import type { DriveAuthStatus } from './types.js';

/**
 * Shallow-compares the 7 fields of a DriveAuthStatus snapshot.
 *
 * Exported for the merged-snapshot gate in auth.ts, which combines the
 * overlay store's `{ connecting, error }` with the connection-derived fields
 * to decide whether the merged DriveAuthStatus actually changed.
 */
export function shallowEqualStatus(a: DriveAuthStatus, b: DriveAuthStatus): boolean {
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

export interface OverlayStatus {
  connecting: boolean;
  error: string | null;
}

export interface OverlayStore {
  get(): OverlayStatus;
  patch(partial: Partial<OverlayStatus>): void;
  subscribe(fn: () => void): () => void;
}

function shallowEqualOverlay(a: OverlayStatus, b: OverlayStatus): boolean {
  return a.connecting === b.connecting && a.error === b.error;
}

/**
 * Tiny non-React store holding just the `{ connecting, error }` overlay that
 * auth.ts layers on top of the connection-derived DriveAuthStatus fields.
 *
 * - `get()` returns a stable reference; the internal snapshot is only replaced
 *   when at least one of the 2 fields differs (shallow compare).
 * - `patch` notifies listeners only when the snapshot reference changed.
 * - `subscribe` returns an unsubscribe fn; unsubscribing during a notify pass
 *   is safe (listeners are iterated over a copy).
 */
export function createOverlayStore(initial: OverlayStatus): OverlayStore {
  let snapshot: OverlayStatus = initial;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const fn of [...listeners]) {
      fn();
    }
  }

  return {
    get(): OverlayStatus {
      return snapshot;
    },
    patch(partial: Partial<OverlayStatus>): void {
      const next = { ...snapshot, ...partial };
      if (shallowEqualOverlay(snapshot, next)) return;
      snapshot = next;
      notify();
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
