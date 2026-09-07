/**
 * Server-mediated token-exchange transport.
 *
 * This module owns the HTTP conversation with the token-exchange endpoint
 * (`DriveSyncOptions.tokenExchangeUrl`): POSTing an auth `code` or a stored
 * `envelope`, parsing the `{ envelope }` response, mapping failures onto typed
 * {@link NeedsReauthError}s, and retrying the transient ones.
 *
 * It deliberately has NO knowledge of storage: it never clears the connection,
 * token, or envelope records. The one failure that requires a clear — a `410`
 * saying the server-side refresh token was revoked — is surfaced as a
 * distinguishable {@link EnvelopeRevokedError} (a tagged subclass of
 * `NeedsReauthError`, `reason: 'refresh_token_revoked'`). T4/T6 callers detect
 * it with `instanceof EnvelopeRevokedError` and run the
 * clear-conn+token+envelope themselves.
 */
import { createBroadcast } from './broadcast.js';
import { NeedsReauthError } from './errors.js';
import type { Logger } from './logger.js';
import { REFRESH_BUFFER_MS } from './refresh.js';
import {
  clearConn,
  clearEnvelope,
  clearToken,
  getEnvelope,
  setEnvelope,
  setToken,
} from './storage.js';
import { consumeExternalEnvelopeRefresh } from './token.js';
import type { Envelope, EnvelopePayload, StoredToken } from './types.js';

/**
 * Distinguishable 410 sentinel: the server-side refresh token was revoked, so
 * every stored credential for this project is now worthless. It IS a
 * `NeedsReauthError` (`reason: 'refresh_token_revoked'`) so a caller that does
 * not special-case it still does the right, if lossy, thing; callers that want
 * to also wipe conn+token+envelope test `err instanceof EnvelopeRevokedError`.
 */
export class EnvelopeRevokedError extends NeedsReauthError {
  constructor(message = 'Server-side refresh token was revoked') {
    super(message, { status: 410, reason: 'refresh_token_revoked' });
    this.name = 'EnvelopeRevokedError';
  }
}

/**
 * Internal marker for a failure worth retrying (a 502, a 5xx, a network-level
 * throw, or an unparseable body). Never escapes this module: the retry wrapper
 * either retries past it or converts it to `NeedsReauthError`
 * (`reason: 'exchange_unavailable'`).
 */
class EnvelopeRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeRetryableError';
  }
}

/** Real-timer delay. Vitest fake timers still drive this via advanceTimersByTimeAsync. */
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const RETRY_DELAYS_MS = [500, 1500] as const;

/**
 * Project an {@link EnvelopePayload} onto the {@link StoredToken} shape the
 * rest of drive-sync persists. Pure; no I/O.
 */
export function deriveToken(payload: EnvelopePayload): StoredToken {
  return {
    accessToken: payload.access_token,
    expiresAt: payload.expiry_date,
    grantedScopes: payload.scope.split(' ').filter(Boolean),
  };
}

interface ExchangeErrorBody {
  error?: { code?: string; message?: string };
}

/**
 * POST `body` to the token-exchange endpoint once and return the `envelope`
 * from a 2xx `{ envelope }` response.
 *
 * Throws:
 *  - {@link EnvelopeRevokedError} on a 410 (`code === 'refresh_token_revoked'`
 *    or a bare 410) — no retry.
 *  - {@link EnvelopeRetryableError} on a 502 / 5xx / network throw / unparseable
 *    body — the retry wrapper handles these.
 *  - {@link NeedsReauthError} (`reason: 'exchange_failed'`) on a 400 / 401 / 404
 *    — logs and does not retry.
 */
export async function postExchange(
  url: string,
  body: { code: string } | { envelope: Envelope },
  logger?: Logger
): Promise<Envelope> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Network-level failure (DNS, offline, connection reset, CORS abort).
    throw new EnvelopeRetryableError(
      `token exchange request failed: ${(err as Error)?.message ?? String(err)}`
    );
  }

  if (res.ok) {
    let parsed: { envelope?: Envelope };
    try {
      parsed = (await res.json()) as { envelope?: Envelope };
    } catch {
      throw new EnvelopeRetryableError('token exchange returned a non-JSON 2xx body');
    }
    return parsed.envelope as Envelope;
  }

  // Non-2xx: try to read a structured { error: { code } }.
  let errBody: ExchangeErrorBody | undefined;
  let bodyParsed = false;
  try {
    errBody = (await res.json()) as ExchangeErrorBody;
    bodyParsed = true;
  } catch {
    bodyParsed = false;
  }
  const code = errBody?.error?.code;

  if (res.status === 410) {
    // Revoked server-side refresh token — everything stored is dead.
    throw new EnvelopeRevokedError(
      code === 'refresh_token_revoked'
        ? 'Server reported the refresh token was revoked (410)'
        : 'Token exchange endpoint returned 410'
    );
  }

  if (res.status === 400 || res.status === 401 || res.status === 404) {
    logger?.error(
      `drive-sync: token exchange failed (${res.status}${code ? ` ${code}` : ''}); reauth required`
    );
    throw new NeedsReauthError('Token exchange rejected the request', {
      status: res.status,
      reason: 'exchange_failed',
    });
  }

  // 502, other 5xx, or an unreadable body: worth another try.
  if (res.status === 502 || res.status >= 500 || !bodyParsed) {
    throw new EnvelopeRetryableError(`token exchange transient failure (${res.status})`);
  }

  // Any other unexpected non-2xx (e.g. 403, 409): treat as non-retryable reauth.
  logger?.error(
    `drive-sync: token exchange failed (${res.status}${code ? ` ${code}` : ''}); reauth required`
  );
  throw new NeedsReauthError('Token exchange rejected the request', {
    status: res.status,
    reason: 'exchange_failed',
  });
}

/**
 * {@link postExchange} with transient-failure retries: on a retryable error
 * wait 500ms and retry, on a second retryable error wait 1500ms and retry,
 * then give up with {@link NeedsReauthError} (`reason: 'exchange_unavailable'`).
 *
 * Non-retryable errors ({@link EnvelopeRevokedError}, the `exchange_failed`
 * {@link NeedsReauthError}) propagate immediately, unretried.
 */
export async function postExchangeWithRetry(
  url: string,
  body: { code: string } | { envelope: Envelope },
  logger?: Logger
): Promise<Envelope> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await postExchange(url, body, logger);
    } catch (err) {
      if (!(err instanceof EnvelopeRetryableError)) throw err;
      if (attempt >= RETRY_DELAYS_MS.length) {
        throw new NeedsReauthError('Token exchange service is unavailable', {
          reason: 'exchange_unavailable',
        });
      }
      await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Per-`projectId` coalescing map for {@link refreshEnvelope}, mirroring the
 * `inFlight` pattern in token.ts: concurrent callers for the same project
 * share a single in-flight promise, and the entry is removed in a `finally`
 * once it settles (success or failure) so the next call starts fresh.
 */
const inFlightEnvelope = new Map<string, Promise<StoredToken>>();

export interface RefreshEnvelopeOptions {
  appId: string;
  projectId: string;
  tokenExchangeUrl: string;
  logger?: Logger;
}

/**
 * Freshness-gated, coalesced envelope refresh for the server-mediated
 * token-exchange mode.
 *
 * 1. Drains any pending cross-tab envelope-refresh signal for this project
 *    (so a fresh envelope another tab just persisted is picked up here).
 * 2. Reads the stored envelope. No envelope means "not connected in this
 *    mode" -> {@link NeedsReauthError} (`reason: 'exchange_failed'`).
 * 3. If the stored access token is still outside the {@link REFRESH_BUFFER_MS}
 *    window, returns {@link deriveToken}(payload) with NO network call.
 * 4. Otherwise POSTs `{ envelope }` via {@link postExchangeWithRetry}. On the
 *    410 {@link EnvelopeRevokedError} sentinel it clears conn + token +
 *    envelope and re-throws a plain `NeedsReauthError`
 *    (`reason: 'refresh_token_revoked'`); on success it persists the new
 *    envelope + derived token, fires a cross-tab `token` broadcast, and
 *    returns the derived token.
 * 5. Concurrent calls for the same `projectId` are coalesced onto one promise.
 */
export async function refreshEnvelope(opts: RefreshEnvelopeOptions): Promise<StoredToken> {
  const existing = inFlightEnvelope.get(opts.projectId);
  if (existing) {
    return existing;
  }

  const promise = refreshEnvelopeUncoalesced(opts);
  inFlightEnvelope.set(opts.projectId, promise);
  try {
    return await promise;
  } finally {
    inFlightEnvelope.delete(opts.projectId);
  }
}

async function refreshEnvelopeUncoalesced(opts: RefreshEnvelopeOptions): Promise<StoredToken> {
  const { appId, projectId, tokenExchangeUrl, logger } = opts;

  // A cross-tab signal only tells us to re-read storage; the durable copy is
  // IndexedDB. Draining it here is a no-op beyond the getEnvelope() below,
  // but keeps the "consume the one-shot signal" contract explicit.
  consumeExternalEnvelopeRefresh(projectId);

  const envelope = await getEnvelope(appId, projectId);
  if (!envelope) {
    throw new NeedsReauthError('No stored envelope; connect is required', {
      reason: 'exchange_failed',
    });
  }

  if (Date.now() < envelope.payload.expiry_date - REFRESH_BUFFER_MS) {
    return deriveToken(envelope.payload);
  }

  let refreshed: Envelope;
  try {
    refreshed = await postExchangeWithRetry(tokenExchangeUrl, { envelope }, logger);
  } catch (err) {
    if (err instanceof EnvelopeRevokedError) {
      await clearConn(appId, projectId);
      await clearToken(appId, projectId);
      await clearEnvelope(appId, projectId);
      throw new NeedsReauthError('Server-side refresh token was revoked', {
        status: 410,
        reason: 'refresh_token_revoked',
      });
    }
    throw err;
  }

  const token = deriveToken(refreshed.payload);
  await setEnvelope(appId, projectId, refreshed);
  await setToken(appId, projectId, token);
  createBroadcast(appId).postToken(projectId);
  return token;
}
