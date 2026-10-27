import type { Entry, Tombstone } from './types.js';

/**
 * Merges remote entries into the local set for a pull. Last-write-wins by
 * `updatedAt` (epoch ms); a missing `updatedAt` is treated as 0 (oldest). Ties
 * favour local — a local entry is never overwritten by a remote entry with an
 * equal-or-older timestamp. Local-only entries are always preserved (never
 * deleted for being absent remotely).
 * With tombstones, retains the newest valid deletion per id and filters the
 * merged entries; only an entry strictly newer than its deletion survives.
 */
export function mergeRemoteEntries(local: Entry[], remote: Entry[], tombstones?: undefined): Entry[];
export function mergeRemoteEntries(
  local: Entry[],
  remote: Entry[],
  tombstones: { local: Tombstone[]; remote: Tombstone[] },
): { entries: Entry[]; tombstones: Tombstone[] };
export function mergeRemoteEntries(
  local: Entry[],
  remote: Entry[],
  tombstones?: { local: Tombstone[]; remote: Tombstone[] },
): Entry[] | { entries: Entry[]; tombstones: Tombstone[] } {
  const byId = new Map(local.map(e => [e.id, e]));
  for (const remoteEntry of remote) {
    // Remote backups are untrusted; do not let an invalid completion timestamp
    // replace an otherwise valid local entry (or introduce a malformed one).
    if (
      remoteEntry.doneAt !== undefined &&
      (typeof remoteEntry.doneAt !== 'number' || !Number.isFinite(remoteEntry.doneAt))
    ) {
      continue;
    }
    const localEntry = byId.get(remoteEntry.id);
    if (!localEntry) {
      byId.set(remoteEntry.id, remoteEntry);
      continue;
    }
    if (localEntry.archived === true) continue;
    const localTs = localEntry.updatedAt ?? 0;
    const remoteTs = remoteEntry.updatedAt ?? 0;
    if (remoteTs > localTs) {
      byId.set(remoteEntry.id, remoteEntry);
    }
    // remoteTs <= localTs: local wins, keep localEntry as-is.
  }
  const entries = Array.from(byId.values());
  if (tombstones === undefined) return entries;

  const removedById = new Map<string, Tombstone>();
  for (const tombstone of [...tombstones.local, ...tombstones.remote]) {
    if (typeof tombstone.removedAt !== 'number' || !Number.isFinite(tombstone.removedAt)) {
      continue;
    }
    const previous = removedById.get(tombstone.id);
    if (!previous || tombstone.removedAt > previous.removedAt) {
      removedById.set(tombstone.id, tombstone);
    }
  }

  return {
    entries: entries.filter(entry => {
      const tombstone = removedById.get(entry.id);
      return !tombstone || !(tombstone.removedAt >= (entry.updatedAt ?? 0));
    }),
    tombstones: Array.from(removedById.values()),
  };
}
