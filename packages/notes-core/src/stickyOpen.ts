import type { Entry } from './types.js';
import { filterEntries } from './entryFiltering.js';

type FilterArgs = Parameters<typeof filterEntries> extends [unknown, ...infer R] ? R : never;

/** Resolve a sticky section click: null if entry missing/archived; else whether active filters hide it. */
export function resolveStickyOpen(entries: Entry[], id: string, ...filter: FilterArgs): { entry: Entry; clearFilters: boolean } | null {
  const entry = entries.find(e => e.id === id && !e.archived);
  if (!entry) return null;
  const visible = filterEntries(entries, ...filter).some(e => e.id === id);
  return { entry, clearFilters: !visible };
}
