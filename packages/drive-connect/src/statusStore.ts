import type { DriveAuthStatus } from './types.js';

/**
 * The initial disconnected snapshot. Reused by auth.ts as the starting state.
 */
export const DISCONNECTED_STATUS: DriveAuthStatus = {
  connected: false,
  email: null,
  expiresAt: null,
  needsReauth: false,
  tokenValid: false,
  connecting: false,
  error: null,
};

export interface StatusStore {
  get(): DriveAuthStatus;
  set(next: DriveAuthStatus): void;
  patch(partial: Partial<DriveAuthStatus>): void;
  subscribe(fn: () => void): () => void;
}

function shallowEqual(a: DriveAuthStatus, b: DriveAuthStatus): boolean {
  return (
    a.connected === b.connected &&
    a.email === b.email &&
    a.expiresAt === b.expiresAt &&
    a.needsReauth === b.needsReauth &&
    a.tokenValid === b.tokenValid &&
    a.connecting === b.connecting &&
    a.error === b.error
  );
}

/**
 * Tiny non-React store suitable for use with useSyncExternalStore.
 *
 * - `get()` returns a stable reference; the internal snapshot is only replaced
 *   when at least one of the 7 fields differs (shallow compare).
 * - `set` / `patch` notify listeners only when the snapshot reference changed.
 * - `subscribe` returns an unsubscribe fn; unsubscribing during a notify pass
 *   is safe (listeners are iterated over a copy).
 */
export function createStatusStore(initial: DriveAuthStatus): StatusStore {
  let snapshot: DriveAuthStatus = initial;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const fn of [...listeners]) {
      fn();
    }
  }

  function commit(next: DriveAuthStatus): void {
    if (shallowEqual(snapshot, next)) return;
    snapshot = next;
    notify();
  }

  return {
    get(): DriveAuthStatus {
      return snapshot;
    },
    set(next: DriveAuthStatus): void {
      commit(next);
    },
    patch(partial: Partial<DriveAuthStatus>): void {
      commit({ ...snapshot, ...partial });
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
