import type { Logger } from './logger.js';
import type { StoredToken } from './types.js';
import { acquireToken } from './token.js';
import { getConnection, refreshSilently } from './connection.js';
import { clearToken, getToken } from './storage.js';
import {
  DriveSyncError,
  NeedsReauthError,
  ScopeInsufficientError,
  NotFoundError,
  RateLimitedError,
  TransientError,
  WrongAccountError,
} from './errors.js';

export interface DriveFetchOptions {
  appId: string;
  projectId: string;
  clientId: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  interactive?: boolean;
  requiredScopes: string[];
  logger?: Logger;
  /**
   * Resolves the connected account's email from a fresh access token. When
   * supplied (index.ts always wires the real implementation in), a 401's
   * silent-refresh-and-retry goes through `refreshSilently` (connection.ts)
   * instead of a bare `acquireToken`, so a token GIS silently hands back for
   * the WRONG Google account is detected and surfaces as a typed
   * `WrongAccountError` rather than being used transparently. Optional so
   * this module has no hard dependency on a network implementation.
   */
  fetchEmail?: (accessToken: string) => Promise<string>;
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
/** Mirrors connection.ts's own buffer: a cached token this close to expiry is treated as unusable. */
const TOKEN_REUSE_BUFFER_MS = 5 * 60 * 1000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Parses a `Retry-After` header (seconds, per HTTP spec) into milliseconds. */
function retryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

function retryAfterSeconds(res: Response): number | undefined {
  const header = res.headers.get('Retry-After');
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Single entry point for all Drive API HTTP calls. Handles token
 * acquisition/attachment, 429/5xx retry with backoff, 401 silent-refresh-and-
 * retry-once, and 403/404 error normalization. Every response is checked for
 * `.ok` before any body is parsed by this function or its callers — callers
 * (files.ts, permissions.ts) receive the raw Response on success and must
 * call .json()/.text()/.blob() themselves.
 */
export async function driveFetch(opts: DriveFetchOptions): Promise<Response> {
  const { appId, projectId, clientId, requiredScopes, logger } = opts;
  const interactive = !!opts.interactive;

  // Reuse a still-valid cached token as-is on the non-interactive path,
  // exactly like connection.ts's getAccessToken() already does — without
  // this check every single Drive call (not just an actual token expiry)
  // forced its own live, non-interactive GIS round-trip via acquireToken
  // below, even when the cached token had plenty of life left.
  if (!interactive) {
    const cached = await getToken(appId, projectId);
    if (cached && cached.expiresAt > Date.now() + TOKEN_REUSE_BUFFER_MS) {
      return performFetch(opts, cached.accessToken, /* isRetryAfter401 */ false);
    }
  }

  // Resolve a hint email from the current connection (if any) so a
  // non-interactive silent refresh can target the right account. If there is
  // no connection at all and interactive is false, acquireToken's silent
  // request (hint: undefined) will fail on GIS's side and surface as
  // NeedsReauthError from acquireToken itself — we deliberately let that
  // propagate rather than pre-emptively short-circuiting here, since
  // acquireToken/GIS is the single source of truth for "can we get a token".
  const conn = await getConnection({ appId, projectId, requiredScopes });
  const hint = conn?.email;

  const token = await acquireToken({
    appId,
    projectId,
    clientId,
    scopes: requiredScopes,
    interactive,
    hint,
    logger,
  });

  return performFetch(opts, token.accessToken, /* isRetryAfter401 */ false);
}

async function performFetch(
  opts: DriveFetchOptions,
  accessToken: string,
  isRetryAfter401: boolean
): Promise<Response> {
  const { appId, projectId, clientId, url, method, body, requiredScopes, logger } = opts;
  const interactive = !!opts.interactive;

  const headers: Record<string, string> = {
    ...opts.headers,
    Authorization: `Bearer ${accessToken}`,
  };

  let res: Response | undefined;
  let lastBodyText = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    res = await fetch(url, { method, headers, body });

    if (res.ok) {
      return res;
    }

    if (isRetryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
      const retryAfter = retryAfterMs(res);
      const delayMs = retryAfter ?? BASE_DELAY_MS * 2 ** (attempt - 1);
      logger?.warn('drive-sync: retrying Drive request', {
        status: res.status,
        attempt,
        delayMs,
      });
      await sleep(delayMs);
      continue;
    }

    // Either not retryable, or attempts exhausted — fall through to
    // status-specific handling below using this final response.
    break;
  }

  // res is guaranteed to be set (loop runs at least once).
  const finalRes = res as Response;

  if (finalRes.ok) {
    return finalRes;
  }

  lastBodyText = await finalRes.text();

  if (isRetryableStatus(finalRes.status)) {
    if (finalRes.status === 429) {
      throw new RateLimitedError({
        status: 429,
        reason: lastBodyText,
        retryAfter: retryAfterSeconds(finalRes),
      });
    }
    throw new TransientError(
      `Drive request failed with status ${finalRes.status}: ${lastBodyText}`,
      { status: finalRes.status, reason: lastBodyText }
    );
  }

  if (finalRes.status === 401) {
    if (isRetryAfter401 || interactive) {
      // Either this IS the retry attempt (already tried a silent refresh
      // once and it still 401'd), or the original call was interactive
      // (caller is expected to have already gone through a fresh
      // connect()-style consent flow) — either way, do not attempt another
      // refresh; surface as NeedsReauthError.
      throw new NeedsReauthError('Drive request unauthorized (401)', {
        status: 401,
        reason: lastBodyText,
      });
    }

    await clearToken(appId, projectId);

    let refreshed: StoredToken;
    try {
      // Re-read the connection to find the email a verified silent refresh
      // must land on. Purely a local storage read — no network call.
      const conn = await getConnection({ appId, projectId, requiredScopes });
      if (conn?.email && opts.fetchEmail) {
        refreshed = await refreshSilently({
          appId,
          projectId,
          clientId,
          scopes: requiredScopes,
          expectedEmail: conn.email,
          fetchEmail: opts.fetchEmail,
          logger,
        });
      } else {
        refreshed = await acquireToken({
          appId,
          projectId,
          clientId,
          scopes: requiredScopes,
          interactive: false,
          hint: conn?.email,
          logger,
        });
      }
    } catch (err) {
      if (err instanceof WrongAccountError) {
        // Not a plain "can't get a token" failure — surface as-is so the
        // caller knows a DIFFERENT account was silently authenticated,
        // rather than masking it behind a generic reauth error. The bad
        // token was already cleared by refreshSilently.
        throw err;
      }
      throw new NeedsReauthError('Drive request unauthorized (401); silent refresh failed', {
        status: 401,
        reason: lastBodyText,
      });
    }

    return performFetch(opts, refreshed.accessToken, /* isRetryAfter401 */ true);
  }

  if (finalRes.status === 403) {
    if (lastBodyText.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
      await clearToken(appId, projectId);
      throw new ScopeInsufficientError('Access token has insufficient scope', {
        status: 403,
        reason: lastBodyText,
      });
    }
    throw new DriveSyncError(`Drive request forbidden (403): ${lastBodyText}`, {
      status: 403,
      reason: lastBodyText,
    });
  }

  if (finalRes.status === 404) {
    // No fileId is reliably available at this layer (the URL may be a
    // search/list/upload endpoint rather than a single-file get); callers
    // that have a fileId in scope should catch this generic 404 and
    // translate it into a NotFoundError with the fileId attached. We throw
    // NotFoundError here with an empty fileId as a reasonable default so a
    // raw un-typed error never surfaces, but files.ts/permissions.ts are
    // expected to re-throw with the concrete fileId when they have one.
    throw new NotFoundError('', { status: 404, reason: lastBodyText });
  }

  throw new DriveSyncError(
    `Drive request failed with status ${finalRes.status}: ${lastBodyText}`,
    { status: finalRes.status, reason: lastBodyText }
  );
}
