import type { Logger } from './logger.js';
import { getConnection, refreshSilently } from './connection.js';
import { getToken } from './storage.js';
import { acquireToken } from './token.js';
import { REQUIRED_SCOPES } from './files.js';

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface ActivateOptions {
  appId: string;
  projectId: string;
  clientId: string;
  /**
   * Resolves the connected account's email from a fresh access token. When
   * supplied, the warm-up's non-interactive refresh goes through
   * `refreshSilently` (connection.ts) so a token GIS silently hands back for
   * the wrong Google account is caught here in the background rather than
   * only being discovered on the next foreground Drive call.
   */
  fetchEmail?: (accessToken: string) => Promise<string>;
  logger?: Logger;
}

/**
 * Per-project token warm-up check: if a connection exists AND its cached
 * token is missing or within the refresh buffer of expiring, fires a
 * non-interactive `acquireToken` warm-up in the background. Never starts a
 * new attempt while the document is hidden (an already in-flight attempt
 * from before the tab hid is allowed to run to completion — this function
 * simply never being called with the tab hidden is enough to guarantee that,
 * since it is only invoked from the visibility/pageshow handlers below,
 * which already gate on visibility).
 */
export async function warmUpIfNeeded(opts: ActivateOptions): Promise<void> {
  try {
    const conn = await getConnection({
      appId: opts.appId,
      projectId: opts.projectId,
      requiredScopes: REQUIRED_SCOPES,
    });
    if (!conn) {
      // No connection at all -> no warm-up.
      return;
    }

    const token = await getToken(opts.appId, opts.projectId);
    const isStale = !token || token.expiresAt - Date.now() <= REFRESH_BUFFER_MS;
    if (!isStale) {
      return;
    }

    if (opts.fetchEmail) {
      await refreshSilently({
        appId: opts.appId,
        projectId: opts.projectId,
        clientId: opts.clientId,
        scopes: REQUIRED_SCOPES,
        expectedEmail: conn.email,
        fetchEmail: opts.fetchEmail,
        logger: opts.logger,
      });
    } else {
      await acquireToken({
        appId: opts.appId,
        projectId: opts.projectId,
        clientId: opts.clientId,
        scopes: REQUIRED_SCOPES,
        interactive: false,
        hint: conn.email,
        logger: opts.logger,
      });
    }
  } catch (err) {
    opts.logger?.warn('drive-sync: background token warm-up failed', { err });
  }
}

/**
 * Attaches `visibilitychange` and `pageshow` (bfcache-restore) listeners for
 * a single project, and returns a disposer that removes both. No listeners
 * are attached at import time — only when this is called (from
 * index.ts's top-level `activate()`, once per known project — see index.ts
 * for how the project set is tracked).
 */
export function activate(opts: ActivateOptions): () => void {
  if (typeof document === 'undefined') {
    return () => {};
  }

  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') return;
    void warmUpIfNeeded(opts);
  };

  const onPageShow = (event: Event): void => {
    const persisted = (event as PageTransitionEvent).persisted;
    if (!persisted) return;
    if (document.hidden) return;
    void warmUpIfNeeded(opts);
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pageshow', onPageShow);

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pageshow', onPageShow);
  };
}
