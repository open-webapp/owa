import type { Logger } from './logger.js';
import type { Connection, StoredToken } from './types.js';
import { getConn, setConn, clearConn, getToken, clearToken } from './storage.js';
import { createBroadcast } from './broadcast.js';
import { acquireToken } from './token.js';
import { WrongAccountError } from './errors.js';

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
}

/**
 * Interactive connection flow: acquires a token with prompt: 'consent',
 * resolves the account email, and persists the durable Connection record.
 */
export async function connect(opts: ConnectOptions): Promise<Connection> {
  const token = await acquireToken({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    scopes: opts.scopes,
    interactive: true,
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
}

/**
 * Disconnects a project: revokes the cached token (if any and if a
 * revokeFn was supplied), then unconditionally clears both the durable
 * connection and the cached token, and broadcasts a logout to other tabs.
 */
export async function disconnect(opts: DisconnectOptions): Promise<void> {
  const token = await getToken(opts.appId, opts.projectId);
  if (token && opts.revokeFn) {
    await opts.revokeFn(token.accessToken);
  }

  await clearConn(opts.appId, opts.projectId);
  await clearToken(opts.appId, opts.projectId);

  createBroadcast(opts.appId).postLogout(opts.projectId);
}
