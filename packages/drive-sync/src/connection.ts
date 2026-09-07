import type { Logger } from './logger.js';
import type { Connection, Envelope, StoredToken } from './types.js';
import {
  getConn,
  setConn,
  clearConn,
  getToken,
  clearToken,
  setEnvelope,
  setToken,
  clearEnvelope,
} from './storage.js';
import { createBroadcast } from './broadcast.js';
import { acquireToken } from './token.js';
import { acquireAuthCode } from './gis.js';
import {
  deriveToken,
  postExchange,
  postExchangeWithRetry,
  refreshEnvelope,
  EnvelopeRevokedError,
} from './envelope.js';
import { NeedsReauthError, WrongAccountError } from './errors.js';

/** Mirrors refresh.ts's own buffer: a cached token this close to expiry is treated as unusable. */
const TOKEN_REUSE_BUFFER_MS = 5 * 60 * 1000;

export interface ConnectOptions {
  appId: string;
  projectId: string;
  clientId: string;
  scopes: string[];
  logger?: Logger;
  /**
   * Resolves the connected account's email from a fresh access token.
   * Injected rather than implemented here because drive-sync does not yet
   * have an http.ts (a later task); index.ts will wire this to a real fetch
   * against the Google userinfo endpoint once http.ts exists.
   */
  fetchEmail: (accessToken: string) => Promise<string>;
  /**
   * When set, `connect()` takes the server-mediated token-exchange path:
   * it acquires a one-time auth CODE via GIS (never an access token) and
   * POSTs it to this endpoint, which returns a signed {@link Envelope}. The
   * durable refresh token stays server-side. Absent, `connect()` runs the
   * legacy client-side `initTokenClient` flow unchanged.
   */
  tokenExchangeUrl?: string;
}

/**
 * Interactive connection flow: acquires a token without forcing a consent
 * screen, resolves the account email, and persists the durable Connection
 * record.
 *
 * With `opts.tokenExchangeUrl` set, runs the envelope (server-mediated
 * token-exchange) variant instead — see {@link connectViaEnvelope}.
 */
export async function connect(opts: ConnectOptions): Promise<Connection> {
  if (opts.tokenExchangeUrl) {
    return connectViaEnvelope(opts, opts.tokenExchangeUrl);
  }

  // On a re-auth the previous connection's email is the account the user is
  // expected to consent as again; pass it as a hint so the popup_closed
  // recovery probe (token.ts) can resolve a completed grant silently even
  // when the browser holds several Google sessions. First-time connect has
  // no prior email and simply passes undefined.
  const existing = await getConn(opts.appId, opts.projectId);
  const token = await acquireToken({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    scopes: opts.scopes,
    interactive: true,
    hint: existing?.email,
    logger: opts.logger,
  });

  const email = await opts.fetchEmail(token.accessToken);

  await setConn(opts.appId, opts.projectId, {
    email,
    grantedScopes: token.grantedScopes,
    connectedAt: Date.now(),
  });

  return {
    email,
    needsReauth: false,
    expiresAt: token.expiresAt,
  };
}

/**
 * Server-mediated token-exchange connect:
 *  1. read the stored conn (for the account `hint` only);
 *  2. acquire a one-time auth CODE via GIS (never touches `acquireToken` /
 *     `initTokenClient`);
 *  3. POST the code to the exchange endpoint for a signed envelope, retrying
 *     transient failures via `postExchangeWithRetry`;
 *  4. persist envelope + derived token + durable conn;
 *  5. resolve the email once (no wrong-account compare — a fresh interactive
 *     grant is authoritative about which account it belongs to).
 *
 * An {@link EnvelopeRevokedError} (410) additionally clears conn+token+envelope
 * before propagating; every other {@link NeedsReauthError} propagates as-is.
 */
async function connectViaEnvelope(
  opts: ConnectOptions,
  tokenExchangeUrl: string
): Promise<Connection> {
  const existing = await getConn(opts.appId, opts.projectId);

  const code = await acquireAuthCode({
    clientId: opts.clientId,
    scopes: opts.scopes,
    hint: existing?.email,
    logger: opts.logger,
  });

  let envelope: Envelope;
  try {
    envelope = await postExchange(tokenExchangeUrl, { code }, opts.logger);
  } catch (err) {
    if (err instanceof EnvelopeRevokedError) {
      await clearConn(opts.appId, opts.projectId);
      await clearToken(opts.appId, opts.projectId);
      await clearEnvelope(opts.appId, opts.projectId);
      throw err;
    }
    // A non-retryable rejection (400/401/404) surfaces as a plain
    // NeedsReauthError from postExchange — propagate it untouched.
    if (err instanceof NeedsReauthError) {
      throw err;
    }
    // Anything else is a transient (network / 502 / unparseable) failure:
    // fall through to the retrying variant.
    envelope = await postExchangeWithRetry(tokenExchangeUrl, { code }, opts.logger);
  }

  await setEnvelope(opts.appId, opts.projectId, envelope);
  const token = deriveToken(envelope.payload);
  await setToken(opts.appId, opts.projectId, token);

  const email = await opts.fetchEmail(token.accessToken);

  await setConn(opts.appId, opts.projectId, {
    email,
    grantedScopes: token.grantedScopes,
    connectedAt: Date.now(),
  });

  return {
    email,
    needsReauth: false,
    expiresAt: token.expiresAt,
  };
}

export interface RefreshSilentlyOptions {
  appId: string;
  projectId: string;
  clientId: string;
  scopes: string[];
  /**
   * The email the resulting token MUST belong to (i.e. the currently stored
   * connection's email). GIS's `hint` is only ever a hint to Google — under
   * some multi-login browser states it can silently hand back a valid token
   * for a DIFFERENT account than the one hinted. This function is the single
   * place that closes that gap for every non-interactive (silent) refresh of
   * an EXISTING connection.
   */
  expectedEmail: string;
  /** Resolves the account email from a fresh access token (same shape as
   * ConnectOptions.fetchEmail — deliberately injected rather than
   * implemented here, so this module still has no direct network
   * dependency). */
  fetchEmail: (accessToken: string) => Promise<string>;
  logger?: Logger;
}

/**
 * Wraps a non-interactive `acquireToken` call with account-identity
 * verification: after GIS hands back a token, resolves the email it
 * actually belongs to and compares it against `expectedEmail`. On mismatch,
 * clears the now-suspect cached token (so a caller retrying does not reuse
 * it) and throws `WrongAccountError` instead of returning the token.
 *
 * This is the ONLY place non-interactive refreshes for an existing
 * connection should go through — http.ts's 401-retry path and refresh.ts's
 * proactive warm-up both call this rather than `acquireToken` directly.
 */
export async function refreshSilently(opts: RefreshSilentlyOptions): Promise<StoredToken> {
  const token = await acquireToken({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    scopes: opts.scopes,
    interactive: false,
    hint: opts.expectedEmail,
    logger: opts.logger,
  });

  const actualEmail = await opts.fetchEmail(token.accessToken);
  if (actualEmail !== opts.expectedEmail) {
    await clearToken(opts.appId, opts.projectId);
    throw new WrongAccountError({ expectedEmail: opts.expectedEmail, actualEmail });
  }

  return token;
}

export interface GetConnectionOptions {
  appId: string;
  projectId: string;
  requiredScopes: string[];
}

/**
 * Reads the durable connection + cached token from storage with NO network
 * calls. needsReauth is computed purely from scope coverage: true if the
 * granted scopes on the stored connection are missing any required scope.
 */
export async function getConnection(opts: GetConnectionOptions): Promise<Connection | null> {
  const conn = await getConn(opts.appId, opts.projectId);
  if (!conn) {
    return null;
  }

  const token = await getToken(opts.appId, opts.projectId);
  const grantedScopes = new Set(conn.grantedScopes);
  const needsReauth = opts.requiredScopes.some((scope) => !grantedScopes.has(scope));

  return {
    email: conn.email,
    needsReauth,
    expiresAt: token?.expiresAt ?? null,
  };
}

export interface GetAccessTokenOptions {
  appId: string;
  projectId: string;
  clientId: string;
  scopes: string[];
  /** Whether an interactive (popup) auth flow may be triggered if no usable cached token exists. */
  interactive: boolean;
  logger?: Logger;
  /**
   * When set, `getAccessToken()` takes the server-mediated token-exchange
   * path: a stale/absent cached token is renewed via {@link refreshEnvelope}
   * (which POSTs the stored envelope to this endpoint) rather than an
   * interactive GIS code/token flow. A missing envelope surfaces as a
   * `NeedsReauthError` from `refreshEnvelope` — no popup is ever shown.
   * Absent, the legacy client-side flow runs unchanged.
   */
  tokenExchangeUrl?: string;
}

/**
 * Returns a raw OAuth access token for callers that must hand it directly to
 * a Google-hosted widget this library does not control (namely Google
 * Picker, which requires `setOAuthToken()`). This is a deliberate, narrow
 * exception to Connection's "no secret material" contract documented in
 * types.ts: Picker runs in Google's own popup/iframe and has no way to read
 * a token this library keeps private, so the token must leave the library
 * for that one integration to work at all. Callers should request this only
 * to feed it straight to Picker, not to make their own Drive API calls
 * (use `files`/`permissions` for that).
 *
 * Reuses a still-valid cached token as-is; otherwise acquires a fresh one
 * via the normal token flow (interactive per `opts.interactive`).
 */
export async function getAccessToken(opts: GetAccessTokenOptions): Promise<string> {
  const cached = await getToken(opts.appId, opts.projectId);
  if (cached && cached.expiresAt > Date.now() + TOKEN_REUSE_BUFFER_MS) {
    return cached.accessToken;
  }

  // Server-mediated token-exchange mode: renew via the stored envelope, never
  // an interactive code/token flow. A missing envelope surfaces as a
  // NeedsReauthError from refreshEnvelope — acquireToken is never reached.
  if (opts.tokenExchangeUrl) {
    const token = await refreshEnvelope({
      appId: opts.appId,
      projectId: opts.projectId,
      tokenExchangeUrl: opts.tokenExchangeUrl,
      logger: opts.logger,
    });
    return token.accessToken;
  }

  // Same rationale as connect(): hand the known account email to the
  // popup_closed recovery probe so it can pick up a completed grant silently.
  const existing = await getConn(opts.appId, opts.projectId);
  const token = await acquireToken({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    scopes: opts.scopes,
    interactive: opts.interactive,
    hint: existing?.email,
    logger: opts.logger,
  });
  return token.accessToken;
}

export interface DisconnectOptions {
  appId: string;
  projectId: string;
  /**
   * Revokes the cached access token upstream. Injected because drive-sync
   * does not yet have an http.ts; index.ts will wire this to a real fetch
   * against the Google token revocation endpoint once http.ts exists. Only
   * called when a token is actually cached — mirrors a fixed bug where the
   * old code always POSTed a revoke request even when there was nothing to
   * revoke.
   */
  revokeFn?: (accessToken: string) => Promise<void>;
  /**
   * Accepted for symmetry with the other flows (connect / getAccessToken).
   * `disconnect` clears the `envelope` key unconditionally regardless of
   * whether this is set, so this field is currently informational only.
   */
  tokenExchangeUrl?: string;
}

/**
 * Disconnects a project: revokes the cached token (if any and if a
 * revokeFn was supplied), then unconditionally clears the durable
 * connection, the cached token, and the stored envelope key, and
 * broadcasts a logout to other tabs.
 */
export async function disconnect(opts: DisconnectOptions): Promise<void> {
  const token = await getToken(opts.appId, opts.projectId);
  if (token && opts.revokeFn) {
    await opts.revokeFn(token.accessToken);
  }

  await clearConn(opts.appId, opts.projectId);
  await clearToken(opts.appId, opts.projectId);
  await clearEnvelope(opts.appId, opts.projectId);

  createBroadcast(opts.appId).postLogout(opts.projectId);
}
