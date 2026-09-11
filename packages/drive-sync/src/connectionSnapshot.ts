import type { Connection } from './types.js';

export interface ConnectionSnapshotStore {
  get(): Connection | null;
  commit(next: Connection | null): void;
  subscribe(fn: () => void): () => void;
}

function shallowEqualConn(a: Connection | null, b: Connection | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return (
    a.email === b.email &&
    a.needsReauth === b.needsReauth &&
    a.expiresAt === b.expiresAt
  );
}

/**
 * Tiny non-React store suitable for use with useSyncExternalStore, holding
 * the durable Connection snapshot (or null when disconnected).
 *
 * - `get()` returns a stable reference; the internal snapshot is only
 *   replaced when at least one of the 3 fields differs (shallow compare).
 * - `commit` notifies listeners only when the snapshot reference changed.
 * - `subscribe` returns an unsubscribe fn; unsubscribing during a notify
 *   pass is safe (listeners are iterated over a copy).
 */
export function createConnectionSnapshotStore(): ConnectionSnapshotStore {
  let snapshot: Connection | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const fn of [...listeners]) {
      fn();
    }
  }

  function commit(next: Connection | null): void {
    if (shallowEqualConn(snapshot, next)) return;
    snapshot = next;
    notify();
  }

  return {
    get(): Connection | null {
      return snapshot;
    },
    commit(next: Connection | null): void {
      commit(next);
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
