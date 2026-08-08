import type { Logger } from './logger.js';
import { GisLoadError } from './errors.js';

const POLL_INTERVAL_MS = 100;
const TIMEOUT_MS = 10_000;

interface GisWindow {
  google?: {
    accounts?: {
      oauth2?: {
        initTokenClient?: unknown;
      };
    };
  };
}

function isGisAvailable(): boolean {
  const w = globalThis as unknown as GisWindow;
  return typeof w.google?.accounts?.oauth2?.initTokenClient !== 'undefined';
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
