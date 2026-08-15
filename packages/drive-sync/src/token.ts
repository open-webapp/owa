import type { Logger } from './logger.js';
import type { StoredToken } from './types.js';
import { setToken, getToken } from './storage.js';
import { waitForGoogleIdentityServices } from './gis.js';
import { NeedsReauthError } from './errors.js';
import { createBroadcast } from './broadcast.js';

/** Minimal shape of the GIS token response passed to a token client's callback. */
interface GisTokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

/**
 * Shape of the object GIS passes to `error_callback`. This is a DIFFERENT
 * channel from `callback`: popup-level failures (blocked by the browser,
 * dismissed by the user) are reported here and never reach `callback`.
 */
interface GisErrorResponse {
  type?: string;
  message?: string;
}

interface GisTokenClientConfig {
  client_id: string;
  scope: string;
  callback: (response: GisTokenResponse) => void;
  error_callback?: (error: GisErrorResponse) => void;
  [key: string]: unknown;
}

interface GisRequestAccessTokenOverride {
  prompt?: string;
  hint?: string;
  scope?: string;
}

interface GisTokenClient {
  requestAccessToken(overrideConfig?: GisRequestAccessTokenOverride): void;
}

interface GisWindow {
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient?: (config: GisTokenClientConfig) => GisTokenClient;
      };
    };
  };
}

/**
 * Persists a freshly-acquired GIS token response as a StoredToken, deriving
 * expiresAt from the response's own expires_in (never hardcoded) and
 * grantedScopes from the response's space-delimited scope string.
 */
export async function persistTokenResponse(
  appId: string,
  projectId: string,
  response: GisTokenResponse
): Promise<StoredToken> {
  const expiresIn = response.expires_in ?? 0;
  const token: StoredToken = {
    accessToken: response.access_token ?? '',
    expiresAt: Date.now() + expiresIn * 1000,
    grantedScopes: (response.scope ?? '').split(' ').filter((s) => s.length > 0),
  };
  await setToken(appId, projectId, token);
  return token;
}

export interface AcquireTokenOptions {
  appId: string;
  projectId: string;
  clientId: string;
  scopes: string[];
  interactive: boolean;
  hint?: string;
  logger?: Logger;
}

/**
 * Key used for in-flight coalescing: per (projectId, sorted-scope-set), NOT
 * global. This is what keeps concurrent calls for different projects (or
 * different scope requirements within the same project) from colliding.
 */
function coalesceKey(projectId: string, scopes: string[]): string {
  return `${projectId}|${scopes.slice().sort().join(' ')}`;
}

const inFlight = new Map<string, Promise<StoredToken>>();

/**
 * Set of projectIds for which another tab has broadcast a fresh `token`
 * message (see broadcast.ts / index.ts's `activate()`) that THIS tab has not
 * yet consumed. Populated by `notifyExternalTokenRefresh` (called from
 * index.ts's broadcast subscription) and drained by the next non-interactive
 * `acquireToken` call for that project — a one-shot signal, not a durable
 * cache (the durable copy is IndexedDB, read via `getToken`).
 */
const externallyRefreshed = new Set<string>();

/**
 * Records that another tab just persisted a fresh token for `projectId` (via
 * a cross-tab `token` broadcast). The NEXT non-interactive `acquireToken`
 * call for this project will, instead of unconditionally starting a new GIS
 * round-trip, first re-read the token this tab already shares via
 * IndexedDB — skipping the redundant network request when that stored token
 * turns out to already be usable.
 */
export function notifyExternalTokenRefresh(projectId: string): void {
  externallyRefreshed.add(projectId);
}

/**
 * Single entry point for acquiring a Drive access token, used by BOTH the
 * interactive "connect" path (interactive: true -> prompt: 'consent', no
 * hint) and the silent "refresh" path (interactive: false -> prompt: 'none',
 * hint: the connection's known email).
 *
 * Design contract (see report): if `interactive` is false and GIS reports an
 * error on the silent attempt, this function throws a NeedsReauthError
 * itself (rather than pushing that decision to the caller). Callers that
 * want to surface a different error type on the interactive path may catch
 * and rethrow.
 *
 * Every call creates a FRESH `initTokenClient` — there is no module-level
 * client, no module-level resolve/reject, and no module-level in-flight
 * promise. Concurrent calls for different (projectId, scopes) pairs cannot
 * collide; concurrent calls for the SAME (projectId, scopes) pair are
 * coalesced onto a single in-flight promise (removed from the map in a
 * `finally` once it settles).
 */
export async function acquireToken(opts: AcquireTokenOptions): Promise<StoredToken> {
  // Non-interactive callers (silent refresh / warm-up) are the ones this is
  // meant to help: an interactive `connect()` call is user-initiated and
  // should never be silently swapped out for a stored token. If another tab
  // signaled a fresh token for this project since we last checked, consume
  // that signal and try storage first — a hit means no GIS round-trip at all.
  if (!opts.interactive && externallyRefreshed.delete(opts.projectId)) {
    const stored = await getToken(opts.appId, opts.projectId);
    if (stored && stored.expiresAt > Date.now()) {
      return stored;
    }
  }

  const key = coalesceKey(opts.projectId, opts.scopes);
  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  const promise = acquireTokenUncoalesced(opts);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

async function acquireTokenUncoalesced(opts: AcquireTokenOptions): Promise<StoredToken> {
  await waitForGoogleIdentityServices(opts.logger);

  const w = globalThis as unknown as GisWindow;
  const initTokenClient = w.google?.accounts?.oauth2?.initTokenClient;
  if (!initTokenClient) {
    // waitForGoogleIdentityServices resolved, so this should not happen in
    // practice; guard anyway rather than throwing an obscure TypeError.
    throw new NeedsReauthError('Google Identity Services is unavailable');
  }

  const response = await new Promise<GisTokenResponse>((resolve, reject) => {
    // These resolve/reject are captured in THIS call's closure only, never
    // stored on a module-level variable, so a second concurrent call cannot
    // clobber the first caller's promise.
    const client = initTokenClient({
      client_id: opts.clientId,
      scope: opts.scopes.join(' '),
      callback: (res: GisTokenResponse) => {
        if (res.error) {
          reject(new Error(`GIS token request failed: ${res.error}`));
          return;
        }
        resolve(res);
      },
      // Without this, a popup that the browser blocks or the user closes
      // settles NOTHING: GIS reports those through error_callback only, so
      // the promise below would stay pending forever and every awaiting
      // Drive call would hang until the caller's own timeout (if any).
      error_callback: (err: GisErrorResponse) => {
        reject(
          new NeedsReauthError(
            err?.type === 'popup_failed_to_open'
              ? 'Google sign-in popup was blocked by the browser'
              : err?.type === 'popup_closed'
                ? 'Google sign-in popup was closed before completing'
                : `Google sign-in failed: ${err?.type ?? 'unknown error'}`,
            { reason: err?.type ?? 'gis_error' }
          )
        );
      },
    });

    opts.logger?.debug('drive-sync: requesting access token', {
      projectId: opts.projectId,
      interactive: opts.interactive,
    });

    client.requestAccessToken({
      prompt: opts.interactive ? 'consent' : 'none',
      hint: !opts.interactive ? opts.hint : undefined,
    });
  }).catch((err: unknown) => {
    if (!opts.interactive) {
      throw new NeedsReauthError('Silent token acquisition failed', { reason: 'gis_error' });
    }
    throw err;
  });

  const token = await persistTokenResponse(opts.appId, opts.projectId, response);

  // Single choke point for the cross-tab "fresh token available" signal:
  // every acquisition path (interactive connect(), silent refreshSilently(),
  // and refresh.ts's direct warm-up call) funnels through here once the
  // token is durably in IndexedDB, so other tabs re-read storage rather than
  // receiving the access token itself over the channel.
  createBroadcast(opts.appId).postToken(opts.projectId);

  return token;
}
