/**
 * useDriveConnection: read-only React hook exposing the current Drive auth
 * status of a `DriveAuthHandle`.
 *
 * `DriveAuthHandle` itself exposes no `getStatus`/`subscribe`/`refresh` — this
 * hook is the only supported way to read live status from React. Under the
 * hood it subscribes to BOTH drive-sync's `subscribeConnection` (the
 * project's connection changes) AND the local `{connecting, error}` overlay,
 * fanned in by `subscribeMerged` — an internal helper that is NOT a public
 * `DriveAuthHandle` method; it lives on `auth` behind the private
 * `INTERNAL_STATUS` symbol exported from `./auth.js`, alongside
 * `getMergedSnapshot`. Both are pulled off `auth` via a cast through `any`
 * since the symbol-keyed property isn't part of the `DriveAuthHandle` type.
 *
 * The merged snapshot's `tokenValid` is frozen at notify time: it's
 * recomputed only when one of the two underlying sources fires a
 * notification, not on every render read. This hook doesn't return
 * `tokenValid` — it isn't part of the fields this hook exposes.
 *
 * Mirrors the `useSyncExternalStore` pattern used by
 * `@open-webapp/project-sync`'s `src/react/index.ts` hooks (`useSyncStatus`
 * etc.): a stable `subscribe` + a synchronous, shallow-stable `getSnapshot`,
 * with the same function reused as `getServerSnapshot`. The hook does NOT
 * auto-refresh/connect on mount — that is the widget's job.
 *
 * Non-React hosts get no ready-made equivalent: the handle no longer offers
 * a merge helper of its own, so they must build their own status merge
 * against drive-sync's `drive.project(id).getConnectionSync()` /
 * `subscribeConnection()` directly.
 */

import { useSyncExternalStore } from 'react';
import type { DriveAuthHandle, DriveAuthStatus } from './types.js';
import { INTERNAL_STATUS } from './auth.js';

export function useDriveConnection(auth: DriveAuthHandle) {
  const { getMergedSnapshot, subscribeMerged }: {
    getMergedSnapshot: () => DriveAuthStatus;
    subscribeMerged: (listener: () => void) => () => void;
  } = (auth as any)[INTERNAL_STATUS];
  const status = useSyncExternalStore(subscribeMerged, getMergedSnapshot, getMergedSnapshot);
  return {
    connected: status.connected,
    email: status.email,
    connecting: status.connecting,
    error: status.error,
    needsReauth: status.needsReauth,
  };
}
