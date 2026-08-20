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
 * How long to wait, after GIS reports `popup_closed`, for the success
 * `callback` to still win the race before treating it as a real failure.
 * 300ms proved too tight in production: on a real network round-trip the
 * success token can arrive well after GIS's popup-closed poll fires,
 * causing genuinely successful sign-ins to be reported as NeedsReauthError.
 *
 * The grace window alone is NOT sufficient: in the field there are completed
 * sign-ins where the success `callback` never arrives at all, so no window is
 * long enough. `probeForCompletedGrant` below is what actually recovers those.
 */
const POPUP_CLOSED_GRACE_MS = 2000;

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

function isPopupClosedError(err: unknown): boolean {
  return err instanceof NeedsReauthError && err.reason === 'popup_closed';
}

/**
 * Issues ONE `prompt: 'none'` request to find out whether the sign-in that
 * GIS reported as `popup_closed` actually completed. Resolves with the token
 * response when a live grant is found; otherwise rethrows `popupClosedError`
 * — the original interactive failure — so callers see the cancellation they
 * would have seen before, never a confusing silent-path error.
 */
async function probeForCompletedGrant(
  initTokenClient: (config: GisTokenClientConfig) => GisTokenClient,
  opts: AcquireTokenOptions,
  popupClosedError: unknown
): Promise<GisTokenResponse> {
  opts.logger?.debug('drive-sync: popup_closed with no token; probing for a completed grant', {
    projectId: opts.projectId,
  });

  try {
    // No grace window: `prompt: 'none'` never opens a popup, so there is no
    // popup-closed poll to race and nothing to wait out on failure.
    const response = await requestGisToken(
      initTokenClient,
      opts,
      { prompt: 'none', hint: opts.hint },
      0
    );
    opts.logger?.debug('drive-sync: recovered a completed sign-in reported as popup_closed', {
      projectId: opts.projectId,
    });
    return response;
  } catch (probeError: unknown) {
    opts.logger?.debug('drive-sync: no live grant after popup_closed; treating as cancelled', {
      projectId: opts.projectId,
      probeError,
    });
    throw popupClosedError;
  }
}

/**
 * Wraps a single GIS token request in a promise.
 *
 * Every call creates a FRESH `initTokenClient`, and the resolve/reject pair is
 * captured in THIS call's closure only — never on a module-level variable — so
 * a second concurrent call cannot clobber the first caller's promise.
 */
function requestGisToken(
  initTokenClient: (config: GisTokenClientConfig) => GisTokenClient,
  opts: AcquireTokenOptions,
  override: GisRequestAccessTokenOverride,
  popupClosedGraceMs: number = POPUP_CLOSED_GRACE_MS
): Promise<GisTokenResponse> {
  return new Promise<GisTokenResponse>((resolve, reject) => {
    let settled = false;
    const client = initTokenClient({
      client_id: opts.clientId,
      scope: opts.scopes.join(' '),
      callback: (res: GisTokenResponse) => {
        if (settled) {
          // Diagnostic only: a token arriving after we gave up is the exact
          // signature of a grace window that was too short, and is worth
          // distinguishing from one that never arrived at all.
          opts.logger?.debug('drive-sync: GIS token callback arrived after settle', {
            projectId: opts.projectId,
            prompt: override.prompt,
            hadError: Boolean(res.error),
          });
          return;
        }
        settled = true;
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
        opts.logger?.debug('drive-sync: GIS error_callback', {
          projectId: opts.projectId,
          prompt: override.prompt,
          type: err?.type,
          message: err?.message,
          settled,
        });
        if (settled) return;
        if (err?.type === 'popup_closed') {
          // GIS closes the popup itself at the end of a SUCCESSFUL flow too,
          // and its popup-closed poll can win the race against delivery of
          // the success token, firing this error_callback even though the
          // token is already on its way via `callback`. Give `callback` a
          // brief grace window to settle the promise first, so a completed
          // OAuth flow doesn't get reported as a failed one.
          setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(
              new NeedsReauthError('Google sign-in popup was closed before completing', {
                reason: 'popup_closed',
              })
            );
          }, popupClosedGraceMs);
          return;
        }
        settled = true;
        reject(
          new NeedsReauthError(
            err?.type === 'popup_failed_to_open'
              ? 'Google sign-in popup was blocked by the browser'
              : `Google sign-in failed: ${err?.type ?? 'unknown error'}`,
            { reason: err?.type ?? 'gis_error' }
          )
        );
      },
    });

    opts.logger?.debug('drive-sync: requesting access token', {
      projectId: opts.projectId,
      interactive: opts.interactive,
      prompt: override.prompt,
    });

    client.requestAccessToken(override);
  });
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

  let response: GisTokenResponse;
  try {
    response = await requestGisToken(initTokenClient, opts, {
      prompt: opts.interactive ? 'consent' : 'none',
      hint: !opts.interactive ? opts.hint : undefined,
    });
  } catch (err: unknown) {
    if (!opts.interactive) {
      throw new NeedsReauthError('Silent token acquisition failed', { reason: 'gis_error' });
    }
    if (!isPopupClosedError(err)) {
      throw err;
    }
    // GIS said the popup closed and never delivered a token, but that is NOT
    // proof the user cancelled: a completed consent whose success message is
    // never posted back to this page looks identical from here. The two cases
    // ARE distinguishable at Google, though — a completed consent leaves a
    // live grant behind, so a `prompt: 'none'` request now succeeds with no
    // popup at all. Probe for it; a cancelled sign-in leaves no grant and the
    // probe fails, in which case we surface the original popup_closed error.
    response = await probeForCompletedGrant(initTokenClient, opts, err);
  }

  const token = await persistTokenResponse(opts.appId, opts.projectId, response);

  // Single choke point for the cross-tab "fresh token available" signal:
  // every acquisition path (interactive connect(), silent refreshSilently(),
  // and refresh.ts's direct warm-up call) funnels through here once the
  // token is durably in IndexedDB, so other tabs re-read storage rather than
  // receiving the access token itself over the channel.
  createBroadcast(opts.appId).postToken(opts.projectId);

  return token;
}
