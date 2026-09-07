/**
 * useDriveConnection: read-only React hook exposing the current Drive auth
 * status of a `DriveAuthHandle`, plus its stable `refresh` action.
 *
 * Mirrors the `useSyncExternalStore` pattern used by
 * `@open-webapp/project-sync`'s `src/react/index.ts` hooks (`useSyncStatus`
 * etc.): a stable `subscribe` + a synchronous, shallow-stable `getSnapshot`,
 * with the same function reused as `getServerSnapshot`.
 *
 * `auth.subscribe`, `auth.getStatus`, and `auth.refresh` are stable references
 * from `createDriveAuth`, so they are passed straight through. The hook does
 * NOT auto-refresh on mount — that is the widget's job (T10).
 */

import { useSyncExternalStore } from 'react';
import type { DriveAuthHandle } from './types.js';

export function useDriveConnection(auth: DriveAuthHandle) {
  const status = useSyncExternalStore(auth.subscribe, auth.getStatus, auth.getStatus);
  return {
    connected: status.connected,
    email: status.email,
    connecting: status.connecting,
    error: status.error,
    needsReauth: status.needsReauth,
    refresh: auth.refresh,
  };
}
