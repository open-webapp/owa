import { describe, expect, it } from 'vitest';
import { foldRuleEnvelopes } from '../foldRuleEnvelopes.js';
import type { Entry, FilterRule } from '../types.js';

type Envelope = { rule: FilterRule; entries: Entry[] };

function rule(id: string, filter = id): FilterRule {
  return { id, filter, fileName: `${id}.json`, isRemainder: false };
}

function entry(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    date: '2026-10-27',
    time: '09:00',
    text: id,
    createdAt: 100,
    ...overrides,
  };
}

describe('foldRuleEnvelopes', () => {
  it('unions entries and retains distinct rules from two envelopes', () => {
    const firstRule = rule('first');
    const secondRule = rule('second');
    const firstEntry = entry('one');
    const secondEntry = entry('two');

    expect(foldRuleEnvelopes([
      { rule: firstRule, entries: [firstEntry] },
      { rule: secondRule, entries: [secondEntry] },
    ])).toEqual({
      entries: [firstEntry, secondEntry],
      filterRules: [firstRule, secondRule],
    });
  });

  it('keeps the first rule with a duplicate id while merging both envelopes’ entries', () => {
    const firstRule = rule('shared', '#first');
    const duplicateRule = { ...rule('shared', '#later'), fileName: 'later.json' };
    const firstEntry = entry('one');
    const secondEntry = entry('two');

    expect(foldRuleEnvelopes([
      { rule: firstRule, entries: [firstEntry] },
      { rule: duplicateRule, entries: [secondEntry] },
    ])).toEqual({
      entries: [firstEntry, secondEntry],
      filterRules: [firstRule],
    });
  });

  it.each([
    { firstUpdatedAt: 100, secondUpdatedAt: 200, winner: 'second' },
    { firstUpdatedAt: 200, secondUpdatedAt: 100, winner: 'first' },
    { firstUpdatedAt: undefined, secondUpdatedAt: 100, winner: 'second' },
  ])('uses last-write-wins for a shared entry: $firstUpdatedAt vs $secondUpdatedAt', ({
    firstUpdatedAt, secondUpdatedAt, winner,
  }) => {
    const first = entry('shared', { text: 'first', updatedAt: firstUpdatedAt });
    const second = entry('shared', { text: 'second', updatedAt: secondUpdatedAt });

    expect(foldRuleEnvelopes([
      { rule: rule('first'), entries: [first] },
      { rule: rule('second'), entries: [second] },
    ]).entries).toEqual([winner === 'first' ? first : second]);
  });

  it.each([100, undefined])('keeps the earlier-folded entry on a timestamp tie (%s)', updatedAt => {
    const first = entry('shared', { text: 'first', updatedAt });
    const second = entry('shared', { text: 'second', updatedAt });

    expect(foldRuleEnvelopes([
      { rule: rule('first'), entries: [first] },
      { rule: rule('second'), entries: [second] },
    ]).entries).toEqual([first]);
  });

  it('returns empty entries and rules for an empty list', () => {
    expect(foldRuleEnvelopes([])).toEqual({ entries: [], filterRules: [] });
  });

  it('preserves envelope order for the first occurrence of each rule', () => {
    const lastAlphabetically = rule('z');
    const firstAlphabetically = rule('a');
    const middleAlphabetically = rule('m');

    expect(foldRuleEnvelopes([
      { rule: lastAlphabetically, entries: [] },
      { rule: firstAlphabetically, entries: [] },
      { rule: rule('z', '#duplicate'), entries: [] },
      { rule: middleAlphabetically, entries: [] },
    ]).filterRules).toEqual([lastAlphabetically, firstAlphabetically, middleAlphabetically]);
  });

  it('does not mutate envelopes, rules, or entries when merging and deduplicating', () => {
    const envelopes: Envelope[] = [
      { rule: rule('shared'), entries: [entry('shared', { updatedAt: 100 })] },
      {
        rule: rule('shared', '#duplicate'),
        entries: [entry('shared', { text: 'newer', updatedAt: 200 }), entry('other')],
      },
    ];
    const before = structuredClone(envelopes);

    const result = foldRuleEnvelopes(envelopes);

    expect(result).toEqual({
      entries: [before[1].entries[0], before[1].entries[1]],
      filterRules: [before[0].rule],
    });
    expect(envelopes).toEqual(before);
  });

  it.each([undefined, null, {}, 'entries', 42])('throws for non-array entries (%s), even after a valid envelope', entries => {
    const envelopes = [
      { rule: rule('valid'), entries: [entry('valid')] },
      { rule: rule('invalid'), entries },
    ] as unknown as Envelope[];

    expect(() => foldRuleEnvelopes(envelopes)).toThrow();
  });

  it('throws for a missing rule, even after a valid envelope', () => {
    const envelopes = [
      { rule: rule('valid'), entries: [entry('valid')] },
      { entries: [entry('invalid')] },
    ] as unknown as Envelope[];

    expect(() => foldRuleEnvelopes(envelopes)).toThrow();
  });

  it.each([NaN, Infinity, -Infinity, 'yesterday', null])('skips entries with invalid doneAt (%s) without throwing', doneAt => {
    const valid = entry('valid', { doneAt: 123 });
    const existing = entry('shared', { updatedAt: 100 });
    const malformed = { ...entry('bad'), doneAt } as unknown as Entry;
    const malformedReplacement = {
      ...entry('shared', { text: 'invalid newer replacement', updatedAt: 200 }),
      doneAt,
    } as unknown as Entry;
    const firstRule = rule('first');
    const secondRule = rule('second');

    expect(foldRuleEnvelopes([
      { rule: firstRule, entries: [malformed, valid, existing] },
      { rule: secondRule, entries: [malformedReplacement] },
    ])).toEqual({
      entries: [valid, existing],
      filterRules: [firstRule, secondRule],
    });
  });
});
