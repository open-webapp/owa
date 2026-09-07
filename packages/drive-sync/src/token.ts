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
 * The silent `prompt: 'none'` probe that recovers a completed sign-in GIS
 * misreported as `popup_closed` is retried a few times: GIS's popup-closed
 * poll can fire before the just-granted consent is durably registered at
 * Google, so a single immediate probe races the grant into existence and
 * loses. A few spaced retries let a real grant surface while still failing
 * fast enough that a genuine cancellation is reported promptly.
 */
const PROBE_ATTEMPTS = 3;
const PROBE_RETRY_DELAY_MS = 350;

/**
 * Hard ceiling on a single GIS token request.
 *
 * GIS settles a request ONLY by invoking `callback` or `error_callback`, and
 * in the field it sometimes does neither: a completed flow whose result is
 * never posted back to this page (most reliably a silent `prompt: 'none'`
 * request in a browser that blocks silent token issuance) leaves both
 * callbacks unfired. Without a ceiling that request stays pending forever —
 * `connect()` never settles, the host app is stuck mid-connect with no error
 * to show, and the in-flight entry in `inFlight` is never released, so every
 * later retry joins the same dead promise and no popup ever opens again.
 *
 * Interactive requests get a generous ceiling because the user is legitimately
 * typing a password inside the popup; silent requests have no UI and must
 * either answer quickly or be treated as failed.
 */
const INTERACTIVE_REQUEST_TIMEOUT_MS = 5 * 60_000;
const SILENT_REQUEST_TIMEOUT_MS = 10_000;
/** Probes run up to PROBE_ATTEMPTS times, so each one has to fail fast. */
const PROBE_REQUEST_TIMEOUT_MS = 4_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Key used for in-flight coalescing: per (projectId, sorted-scope-set,
 * interactive), NOT global. This is what keeps concurrent calls for different
 * projects (or different scope requirements within the same project) from
 * colliding.
 *
 * `interactive` is part of the key because the two modes are not
 * interchangeable: a user-initiated `connect()` must run its own OAuth flow,
 * and must never be handed the outcome of a silent background refresh that
 * happens to be in flight — that resolves (or rejects) the user's click with
 * no flow shown at all, which is indistinguishable from a dead button.
 */
function coalesceKey(projectId: string, scopes: string[], interactive: boolean): string {
  return `${projectId}|${interactive ? 'i' : 's'}|${scopes.slice().sort().join(' ')}`;
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
 * Parallel-set mirror of {@link externallyRefreshed} for the server-mediated
 * token-exchange path (envelope.ts `refreshEnvelope`). Kept deliberately
 * separate from the legacy set so the two flows never consume each other's
 * cross-tab signals: a `token` broadcast that originated from an envelope
 * refresh drains this set, and one from a legacy GIS acquisition drains the
 * other. Populated by {@link notifyExternalEnvelopeRefresh}, drained by
 * {@link consumeExternalEnvelopeRefresh}.
 */
const externallyRefreshedEnvelope = new Set<string>();

/**
 * Records that another tab just persisted a fresh envelope for `projectId`.
 * The next {@link import('./envelope.js').refreshEnvelope} call for this
 * project drains the signal and re-reads the stored envelope before deciding
 * whether a network round-trip is needed.
 */
export function notifyExternalEnvelopeRefresh(projectId: string): void {
  externallyRefreshedEnvelope.add(projectId);
}

/**
 * Consume (one-shot) a pending cross-tab envelope-refresh signal for
 * `projectId`. Returns `true` when a signal was pending (and clears it),
 * `false` otherwise. Mirrors the inline `externallyRefreshed.delete(...)`
 * check the legacy `acquireToken` path performs.
 */
export function consumeExternalEnvelopeRefresh(projectId: string): boolean {
  return externallyRefreshedEnvelope.delete(projectId);
}

/**
 * Single entry point for acquiring a Drive access token, used by BOTH the
 * interactive "connect" path (interactive: true -> prompt: '', i.e. no
 * forced consent screen) and the silent "refresh" path (interactive: false
 * -> prompt: 'none'). Both pass `hint`: the connection's known email, when
 * there is one.
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

  const key = coalesceKey(opts.projectId, opts.scopes, opts.interactive);
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
 * Issues up to `PROBE_ATTEMPTS` silent `prompt: 'none'` requests to find out
 * whether the sign-in that GIS reported as `popup_closed` actually completed.
 * Resolves with the token response as soon as a live grant is found;
 * otherwise rethrows `popupClosedError` — the original interactive failure —
 * so callers see the cancellation they would have seen before, never a
 * confusing silent-path error.
 *
 * `opts.hint` matters here: a bare `prompt: 'none'` request with no
 * `login_hint` cannot be resolved by GIS when the browser holds more than one
 * Google session, so the interactive callers pass the connection's known
 * email through as the hint for this probe.
 */
async function probeForCompletedGrant(
  initTokenClient: (config: GisTokenClientConfig) => GisTokenClient,
  opts: AcquireTokenOptions,
  popupClosedError: unknown
): Promise<GisTokenResponse> {
  opts.logger?.debug('drive-sync: popup_closed with no token; probing for a completed grant', {
    projectId: opts.projectId,
  });

  let lastProbeError: unknown;
  for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt += 1) {
    try {
      // No grace window: `prompt: 'none'` never opens a popup, so there is no
      // popup-closed poll to race and nothing to wait out on failure.
      const response = await requestGisToken(
        initTokenClient,
        opts,
        { prompt: 'none', hint: opts.hint },
        0,
        PROBE_REQUEST_TIMEOUT_MS
      );
      opts.logger?.debug('drive-sync: recovered a completed sign-in reported as popup_closed', {
        projectId: opts.projectId,
        attempt,
      });
      return response;
    } catch (probeError: unknown) {
      lastProbeError = probeError;
      if (attempt < PROBE_ATTEMPTS) {
        await delay(PROBE_RETRY_DELAY_MS);
      }
    }
  }

  opts.logger?.debug('drive-sync: no live grant after popup_closed; treating as cancelled', {
    projectId: opts.projectId,
    probeError: lastProbeError,
  });
  throw popupClosedError;
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
  popupClosedGraceMs: number = POPUP_CLOSED_GRACE_MS,
  timeoutMs: number = INTERACTIVE_REQUEST_TIMEOUT_MS
): Promise<GisTokenResponse> {
  return new Promise<GisTokenResponse>((resolve, reject) => {
    let settled = false;

    // Neither GIS callback is guaranteed to fire; see the timeout constants.
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      opts.logger?.warn('drive-sync: GIS never returned a result; timing out the request', {
        projectId: opts.projectId,
        prompt: override.prompt,
        timeoutMs,
      });
      reject(
        new NeedsReauthError('Google sign-in did not return a result', {
          reason: 'gis_timeout',
        })
      );
    }, timeoutMs);

    const succeed = (res: GisTokenResponse) => {
      settled = true;
      clearTimeout(timeout);
      resolve(res);
    };
    const fail = (err: Error) => {
      settled = true;
      clearTimeout(timeout);
      reject(err);
    };

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
        if (res.error) {
          fail(new Error(`GIS token request failed: ${res.error}`));
          return;
        }
        succeed(res);
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
            fail(
              new NeedsReauthError('Google sign-in popup was closed before completing', {
                reason: 'popup_closed',
              })
            );
          }, popupClosedGraceMs);
          return;
        }
        fail(
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
    response = await requestGisToken(
      initTokenClient,
      opts,
      {
        // The interactive path deliberately does NOT force `prompt: 'consent'`.
        // Forcing the full consent screen on every connect buys nothing in the
        // implicit (token) flow — there is no refresh token to obtain — while
        // holding a popup open for seconds. That popup lifetime IS the window
        // in which GIS's popup-closed poll beats delivery of the token, so
        // forcing consent manufactures the very race the probe below recovers
        // from. `prompt: ''` lets Google skip straight through when the grant
        // already exists (and still shows consent on the first grant, or when
        // new scopes are requested), which closes the race instead of racing
        // it. The hint goes on both paths so an already-known account can skip
        // the chooser too.
        prompt: opts.interactive ? '' : 'none',
        hint: opts.hint,
      },
      POPUP_CLOSED_GRACE_MS,
      opts.interactive ? INTERACTIVE_REQUEST_TIMEOUT_MS : SILENT_REQUEST_TIMEOUT_MS
    );
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
