import type { Logger } from './logger.js';
import { GisLoadError, NeedsReauthError } from './errors.js';

const POLL_INTERVAL_MS = 100;
const TIMEOUT_MS = 10_000;

/**
 * Hard ceiling on how long `acquireAuthCode` waits for GIS to deliver a result
 * on EITHER channel (`callback` or `error_callback`). Neither is guaranteed to
 * fire — a silently swallowed popup leaves the promise pending forever without
 * this. Mirrors token.ts's `INTERACTIVE_REQUEST_TIMEOUT_MS` (5 minutes): the
 * user may take a while at the Google consent screen.
 */
const ACQUIRE_CODE_TIMEOUT_MS = 5 * 60_000;

interface GisWindow {
  google?: {
    accounts?: {
      oauth2?: {
        // Real GIS ships BOTH of these on the same `oauth2` object, loaded
        // together by the one gsi/client script — so a page that has the
        // legacy token client available also has the code client available.
        initTokenClient?: unknown;
        initCodeClient?: (config: GisCodeClientConfig) => GisCodeClient;
      };
    };
  };
}

/** Shape GIS passes to an `initCodeClient` callback: `{ code }` or `{ error }`. */
interface GisCodeResponse {
  code?: string;
  error?: string;
}

/** Popup-level failure channel — same `{ type }` shape as the token client. */
interface GisErrorResponse {
  type?: string;
  message?: string;
}

interface GisCodeClientConfig {
  client_id: string;
  scope: string;
  ux_mode?: string;
  hint?: string;
  callback: (response: GisCodeResponse) => void;
  error_callback?: (error: GisErrorResponse) => void;
  [key: string]: unknown;
}

interface GisCodeClient {
  requestCode(): void;
}

function isGisAvailable(): boolean {
  const w = globalThis as unknown as GisWindow;
  return typeof w.google?.accounts?.oauth2?.initTokenClient !== 'undefined';
}

/** Whether `google.accounts.oauth2.initCodeClient` is present and callable. */
export function isCodeClientAvailable(): boolean {
  const w = globalThis as unknown as GisWindow;
  return typeof w.google?.accounts?.oauth2?.initCodeClient === 'function';
}

/**
 * Resolves once `window.google.accounts.oauth2.initTokenClient` becomes
 * available, polling every 100ms. Rejects with a GisLoadError if it does not
 * become available within 10 seconds. Uses real timers so this behaves
 * correctly under `vi.useFakeTimers()`.
 */
export function waitForGoogleIdentityServices(logger?: Logger): Promise<void> {
  if (isGisAvailable()) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();

    const interval = setInterval(() => {
      logger?.debug('drive-sync: polling for Google Identity Services...');
      if (isGisAvailable()) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= TIMEOUT_MS) {
        clearInterval(interval);
        reject(new GisLoadError());
      }
    }, POLL_INTERVAL_MS);
  });
}

/**
 * Envelope-mode counterpart of {@link waitForGoogleIdentityServices}: resolves
 * once `window.google.accounts.oauth2.initCodeClient` is available, polling
 * every 100ms, rejecting with a GisLoadError after 10 seconds. Kept separate
 * from the legacy token-client poll so the legacy path is untouched.
 */
export function waitForGisCodeClient(logger?: Logger): Promise<void> {
  if (isCodeClientAvailable()) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();

    const interval = setInterval(() => {
      logger?.debug('drive-sync: polling for Google Identity Services code client...');
      if (isCodeClientAvailable()) {
        clearInterval(interval);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= TIMEOUT_MS) {
        clearInterval(interval);
        reject(new GisLoadError());
      }
    }, POLL_INTERVAL_MS);
  });
}

export interface AcquireAuthCodeOptions {
  clientId: string;
  scopes: string[];
  /** Prior account email, passed to GIS as `hint` to pre-select the account. */
  hint?: string;
  logger?: Logger;
}

/**
 * Runs the GIS auth-code (server-side exchange) popup flow once and resolves
 * with the one-time authorization `code`. No `redirect_uri`, no `state`: the
 * code is handed straight to the token-exchange endpoint.
 *
 * Rejects with a {@link NeedsReauthError} when GIS reports an in-band
 * `response.error`, fires `error_callback` (blocked/dismissed popup), or never
 * answers on either channel within {@link ACQUIRE_CODE_TIMEOUT_MS}.
 */
export async function acquireAuthCode(opts: AcquireAuthCodeOptions): Promise<string> {
  await waitForGisCodeClient(opts.logger);

  const w = globalThis as unknown as GisWindow;
  const initCodeClient = w.google?.accounts?.oauth2?.initCodeClient;
  if (!initCodeClient) {
    throw new GisLoadError();
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      opts.logger?.warn('drive-sync: GIS never returned an auth code; timing out', {
        timeoutMs: ACQUIRE_CODE_TIMEOUT_MS,
      });
      reject(
        new NeedsReauthError('Google sign-in did not return an auth code', {
          reason: 'gis_timeout',
        })
      );
    }, ACQUIRE_CODE_TIMEOUT_MS);

    const succeed = (code: string) => {
      settled = true;
      clearTimeout(timeout);
      resolve(code);
    };
    const fail = (err: Error) => {
      settled = true;
      clearTimeout(timeout);
      reject(err);
    };

    const client = initCodeClient({
      client_id: opts.clientId,
      scope: opts.scopes.join(' '),
      ux_mode: 'popup',
      hint: opts.hint,
      callback: (res: GisCodeResponse) => {
        if (settled) return;
        if (res.error) {
          fail(
            new NeedsReauthError(`Google sign-in failed: ${res.error}`, {
              reason: res.error,
            })
          );
          return;
        }
        if (!res.code) {
          fail(
            new NeedsReauthError('Google sign-in returned no auth code', {
              reason: 'gis_error',
            })
          );
          return;
        }
        succeed(res.code);
      },
      error_callback: (err: GisErrorResponse) => {
        opts.logger?.debug('drive-sync: GIS code client error_callback', {
          type: err?.type,
          message: err?.message,
          settled,
        });
        if (settled) return;
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

    opts.logger?.debug('drive-sync: requesting auth code');
    client.requestCode();
  });
}
