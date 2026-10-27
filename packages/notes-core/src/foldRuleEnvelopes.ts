import { mergeRemoteEntries } from './mergeRemoteEntries.js';
import type { Entry, FilterRule } from './types.js';

/**
 * Folds shape-validated rule backups in order. The first rule for each id wins;
 * entries use the legacy merge, with timestamp ties favouring earlier folds.
 * A malformed envelope aborts the fold without returning a partial result.
 */
export function foldRuleEnvelopes(
  envelopes: { rule: FilterRule; entries: Entry[] }[],
): { entries: Entry[]; filterRules: FilterRule[] } {
  const rulesById = new Map<string, FilterRule>();
  let entries: Entry[] = [];

  for (const envelope of envelopes) {
    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      Array.isArray(envelope) ||
      typeof envelope.rule !== 'object' ||
      envelope.rule === null ||
      Array.isArray(envelope.rule) ||
      !Array.isArray(envelope.entries)
    ) {
      throw new Error('A rule envelope has an unexpected shape.');
    }

    if (!rulesById.has(envelope.rule.id)) {
      rulesById.set(envelope.rule.id, envelope.rule);
    }
    entries = mergeRemoteEntries(entries, envelope.entries);
  }

  return { entries, filterRules: [...rulesById.values()] };
}
