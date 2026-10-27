import { describe, expect, expectTypeOf, it } from 'vitest';

import { mergeRemoteEntries } from '../mergeRemoteEntries.js';
import type { Entry, Tombstone } from '../types';

function entry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    date: '2026-08-31',
    time: '09:00',
    text: 'hello',
    createdAt: 1_000,
    ...overrides,
  };
}

describe('mergeRemoteEntries without tombstones', () => {
  // Expected arrays are hand-written, independent of the old implementation.
  // Full-array assertions also lock the legacy return shape and entry order.
  const cases: { name: string; local: Entry[]; remote: Entry[]; expected: Entry[] }[] = [
    {
      name: 'keeps local A before remote B when ids differ',
      local: [entry({ id: 'a', text: 'local-a' })],
      remote: [entry({ id: 'b', text: 'remote-b' })],
      expected: [entry({ id: 'a', text: 'local-a' }), entry({ id: 'b', text: 'remote-b' })],
    },
    {
      name: 'keeps local content when its updatedAt is newer',
      local: [entry({ id: 'x', text: 'local', updatedAt: 2_000 })],
      remote: [entry({ id: 'x', text: 'remote', updatedAt: 1_000 })],
      expected: [entry({ id: 'x', text: 'local', updatedAt: 2_000 })],
    },
    {
      name: 'replaces local content when remote updatedAt is newer',
      local: [entry({ id: 'x', text: 'local', updatedAt: 1_000 })],
      remote: [entry({ id: 'x', text: 'remote', updatedAt: 2_000 })],
      expected: [entry({ id: 'x', text: 'remote', updatedAt: 2_000 })],
    },
    {
      name: 'replaces local completion state with newer remote doneAt',
      local: [entry({ id: 'x', updatedAt: 1_000, doneAt: undefined })],
      remote: [entry({ id: 'x', updatedAt: 2_000, doneAt: 3_000 })],
      expected: [entry({ id: 'x', updatedAt: 2_000, doneAt: 3_000 })],
    },
    {
      name: 'clears local completion state when newer remote has no doneAt',
      local: [entry({ id: 'x', updatedAt: 1_000, doneAt: 1_500 })],
      remote: [entry({ id: 'x', updatedAt: 2_000, doneAt: undefined })],
      expected: [entry({ id: 'x', updatedAt: 2_000, doneAt: undefined })],
    },
    {
      name: 'treats missing local updatedAt as zero against a remote timestamp',
      local: [entry({ id: 'x', text: 'local', updatedAt: undefined })],
      remote: [entry({ id: 'x', text: 'remote', updatedAt: 1 })],
      expected: [entry({ id: 'x', text: 'remote', updatedAt: 1 })],
    },
    {
      name: 'treats missing remote updatedAt as zero against a local timestamp',
      local: [entry({ id: 'x', text: 'local', updatedAt: 1 })],
      remote: [entry({ id: 'x', text: 'remote', updatedAt: undefined })],
      expected: [entry({ id: 'x', text: 'local', updatedAt: 1 })],
    },
    {
      name: 'keeps local when both updatedAt values are missing',
      local: [entry({ id: 'x', text: 'local' })],
      remote: [entry({ id: 'x', text: 'remote' })],
      expected: [entry({ id: 'x', text: 'local' })],
    },
    {
      name: 'keeps local completion state on an updatedAt tie',
      local: [entry({ id: 'x', updatedAt: 1_000, doneAt: 1_500 })],
      remote: [entry({ id: 'x', updatedAt: 1_000, doneAt: 2_500 })],
      expected: [entry({ id: 'x', updatedAt: 1_000, doneAt: 1_500 })],
    },
    {
      name: 'adds a remote-only entry',
      local: [],
      remote: [entry({ id: 'r', text: 'remote-only' })],
      expected: [entry({ id: 'r', text: 'remote-only' })],
    },
    {
      name: 'preserves a local-only entry',
      local: [entry({ id: 'x', text: 'local-only' })],
      remote: [],
      expected: [entry({ id: 'x', text: 'local-only' })],
    },
    {
      name: 'never overwrites or unarchives an archived local entry with newer remote content',
      local: [entry({ id: 'a', archived: true, updatedAt: 1, text: 'old' })],
      remote: [entry({ id: 'a', updatedAt: 999, text: 'new' })],
      expected: [entry({ id: 'a', archived: true, updatedAt: 1, text: 'old' })],
    },
    {
      name: 'replaces a non-archived local entry with newer remote content',
      local: [entry({ id: 'b', archived: false, updatedAt: 1, text: 'old' })],
      remote: [entry({ id: 'b', updatedAt: 999, text: 'new' })],
      expected: [entry({ id: 'b', updatedAt: 999, text: 'new' })],
    },
    {
      name: 'preserves an archived local-only entry',
      local: [entry({ id: 'c', archived: true, updatedAt: 5, text: 'keep' })],
      remote: [],
      expected: [entry({ id: 'c', archived: true, updatedAt: 5, text: 'keep' })],
    },
    {
      name: 'keeps local positions on replacement and appends remote-only entries in remote order',
      local: [
        entry({ id: 'b', text: 'local-b', updatedAt: 1 }),
        entry({ id: 'a', text: 'local-a', updatedAt: 3 }),
        entry({ id: 'c', text: 'local-only' }),
      ],
      remote: [
        entry({ id: 'z', text: 'remote-z' }),
        entry({ id: 'a', text: 'older-a', updatedAt: 2 }),
        entry({ id: 'b', text: 'newer-b', updatedAt: 2 }),
        entry({ id: 'd', text: 'remote-d' }),
      ],
      expected: [
        entry({ id: 'b', text: 'newer-b', updatedAt: 2 }),
        entry({ id: 'a', text: 'local-a', updatedAt: 3 }),
        entry({ id: 'c', text: 'local-only' }),
        entry({ id: 'z', text: 'remote-z' }),
        entry({ id: 'd', text: 'remote-d' }),
      ],
    },
  ];

  it.each(cases)('$name', ({ local, remote, expected }) => {
    const merged = mergeRemoteEntries(local, remote);

    expect(Array.isArray(merged)).toBe(true);
    expect(merged).toStrictEqual(expected);
  });

  it('preserves the reference of a local-only entry', () => {
    const localEntry = entry({ id: 'x', text: 'local-only' });

    const merged = mergeRemoteEntries([localEntry], []);

    expect(merged[0]).toBe(localEntry);
  });

  it.each([
    { name: 'NaN', doneAt: Number.NaN },
    { name: 'Infinity', doneAt: Number.POSITIVE_INFINITY },
    { name: 'string', doneAt: 'now' },
  ])('skips remote entries with $name doneAt for existing and new ids', ({ doneAt }) => {
    const local = [entry({ id: 'x', updatedAt: 1_000, text: 'local' })];
    const remote = [
      { ...entry({ id: 'x', updatedAt: 2_000, text: 'remote' }), doneAt },
      { ...entry({ id: 'new', updatedAt: 2_000, text: 'invalid-new' }), doneAt },
      entry({ id: 'valid', text: 'valid-remote', doneAt: 3_000 }),
    ] as unknown as Entry[];

    // Calling directly also verifies malformed remote data does not throw.
    const merged = mergeRemoteEntries(local, remote);

    expect(Array.isArray(merged)).toBe(true);
    expect(merged).toStrictEqual([
      entry({ id: 'x', updatedAt: 1_000, text: 'local' }),
      entry({ id: 'valid', text: 'valid-remote', doneAt: 3_000 }),
    ]);
  });
});

describe('mergeRemoteEntries with tombstones', () => {
  const cases: {
    name: string;
    local: Entry[];
    remote: Entry[];
    tombstones: { local: Tombstone[]; remote: Tombstone[] };
    expected: { entries: Entry[]; tombstones: Tombstone[] };
  }[] = [
    {
      name: 'drops a local entry covered by a remote tombstone',
      local: [entry({ updatedAt: 5 })],
      remote: [],
      tombstones: { local: [], remote: [{ id: 'e1', removedAt: 10 }] },
      expected: { entries: [], tombstones: [{ id: 'e1', removedAt: 10 }] },
    },
    {
      name: 'drops a remote entry covered by a local tombstone',
      local: [],
      remote: [entry({ updatedAt: 5 })],
      tombstones: { local: [{ id: 'e1', removedAt: 10 }], remote: [] },
      expected: { entries: [], tombstones: [{ id: 'e1', removedAt: 10 }] },
    },
    {
      name: 'drops an entry when removedAt equals updatedAt',
      local: [entry({ updatedAt: 10 })],
      remote: [],
      tombstones: { local: [], remote: [{ id: 'e1', removedAt: 10 }] },
      expected: { entries: [], tombstones: [{ id: 'e1', removedAt: 10 }] },
    },
    {
      name: 'revives a strictly newer local entry and retains its tombstone',
      local: [entry({ updatedAt: 11 })],
      remote: [],
      tombstones: { local: [], remote: [{ id: 'e1', removedAt: 10 }] },
      expected: {
        entries: [entry({ updatedAt: 11 })],
        tombstones: [{ id: 'e1', removedAt: 10 }],
      },
    },
    {
      name: 'revives a strictly newer remote entry and retains its tombstone',
      local: [entry({ updatedAt: 5 })],
      remote: [entry({ updatedAt: 11, text: 'revived' })],
      tombstones: { local: [{ id: 'e1', removedAt: 10 }], remote: [] },
      expected: {
        entries: [entry({ updatedAt: 11, text: 'revived' })],
        tombstones: [{ id: 'e1', removedAt: 10 }],
      },
    },
    {
      name: 'keeps the newer remote tombstone for an id present on both sides',
      local: [entry({ updatedAt: 8 })],
      remote: [],
      tombstones: {
        local: [{ id: 'e1', removedAt: 5 }],
        remote: [{ id: 'e1', removedAt: 10 }],
      },
      expected: { entries: [], tombstones: [{ id: 'e1', removedAt: 10 }] },
    },
    {
      name: 'keeps the newer local tombstone for an id present on both sides',
      local: [],
      remote: [entry({ updatedAt: 8 })],
      tombstones: {
        local: [{ id: 'e1', removedAt: 10 }],
        remote: [{ id: 'e1', removedAt: 5 }],
      },
      expected: { entries: [], tombstones: [{ id: 'e1', removedAt: 10 }] },
    },
    {
      name: 'treats missing updatedAt as zero and drops it against removedAt zero',
      local: [entry()],
      remote: [],
      tombstones: { local: [], remote: [{ id: 'e1', removedAt: 0 }] },
      expected: { entries: [], tombstones: [{ id: 'e1', removedAt: 0 }] },
    },
    {
      name: 'retains a tombstone for an unknown id',
      local: [],
      remote: [],
      tombstones: { local: [], remote: [{ id: 'unknown', removedAt: 10 }] },
      expected: { entries: [], tombstones: [{ id: 'unknown', removedAt: 10 }] },
    },
    {
      name: 'drops an archived local entry covered by an equal tombstone',
      local: [entry({ archived: true, updatedAt: 10 })],
      remote: [],
      tombstones: { local: [], remote: [{ id: 'e1', removedAt: 10 }] },
      expected: { entries: [], tombstones: [{ id: 'e1', removedAt: 10 }] },
    },
    {
      name: 'drops an archived local entry covered by a newer tombstone',
      local: [entry({ archived: true, updatedAt: 5 })],
      remote: [],
      tombstones: { local: [], remote: [{ id: 'e1', removedAt: 10 }] },
      expected: { entries: [], tombstones: [{ id: 'e1', removedAt: 10 }] },
    },
    {
      name: 'returns an object with empty tombstones when both lists are empty',
      local: [entry({ id: 'local' })],
      remote: [entry({ id: 'remote' })],
      tombstones: { local: [], remote: [] },
      expected: {
        entries: [entry({ id: 'local' }), entry({ id: 'remote' })],
        tombstones: [],
      },
    },
    {
      name: 'never prunes an unrelated old tombstone while merging newer entries',
      local: [entry({ updatedAt: 1_000 })],
      remote: [entry({ updatedAt: 2_000 })],
      tombstones: { local: [{ id: 'old-deletion', removedAt: 0 }], remote: [] },
      expected: {
        entries: [entry({ updatedAt: 2_000 })],
        tombstones: [{ id: 'old-deletion', removedAt: 0 }],
      },
    },
  ];

  it.each(cases)('$name', ({ local, remote, tombstones, expected }) => {
    expect(mergeRemoteEntries(local, remote, tombstones)).toStrictEqual(expected);
  });

  it.each(['local', 'remote'] as const)(
    'collapses duplicate ids in the %s tombstone list to the maximum removedAt',
    side => {
      const tombstones: { local: Tombstone[]; remote: Tombstone[] } = {
        local: [],
        remote: [],
      };
      tombstones[side] = [
        { id: 'e1', removedAt: 5 },
        { id: 'e1', removedAt: 10 },
        { id: 'e1', removedAt: 3 },
      ];

      expect(mergeRemoteEntries([entry({ updatedAt: 8 })], [], tombstones)).toStrictEqual({
        entries: [],
        tombstones: [{ id: 'e1', removedAt: 10 }],
      });
    },
  );

  const invalidRemovedAt: { name: string; removedAt: unknown }[] = [
    { name: 'NaN', removedAt: Number.NaN },
    { name: 'positive infinity', removedAt: Number.POSITIVE_INFINITY },
    { name: 'negative infinity', removedAt: Number.NEGATIVE_INFINITY },
    { name: 'numeric string', removedAt: '10' },
    { name: 'null', removedAt: null },
    { name: 'undefined', removedAt: undefined },
    { name: 'boolean', removedAt: true },
    { name: 'object', removedAt: {} },
  ];

  describe.each(['local', 'remote'] as const)('invalid %s tombstones', side => {
    it.each(invalidRemovedAt)('ignores $name removedAt without throwing', ({ removedAt }) => {
      const tombstones: { local: Tombstone[]; remote: Tombstone[] } = {
        local: [],
        remote: [],
      };
      tombstones[side] = [{ id: 'e1', removedAt }] as Tombstone[];

      expect(mergeRemoteEntries([entry({ updatedAt: 5 })], [], tombstones)).toStrictEqual({
        entries: [entry({ updatedAt: 5 })],
        tombstones: [],
      });
    });
  });

  it.each([
    { name: 'NaN', doneAt: Number.NaN },
    { name: 'Infinity', doneAt: Number.POSITIVE_INFINITY },
    { name: 'string', doneAt: 'now' },
  ])('skips remote entries with $name doneAt while applying tombstones', ({ doneAt }) => {
    const remote = [
      { ...entry({ updatedAt: 20, text: 'invalid revival' }), doneAt },
      { ...entry({ id: 'invalid-new', updatedAt: 20 }), doneAt },
      entry({ id: 'valid', updatedAt: 20 }),
    ] as unknown as Entry[];

    expect(mergeRemoteEntries([entry({ updatedAt: 5 })], remote, {
      local: [],
      remote: [{ id: 'e1', removedAt: 10 }],
    })).toStrictEqual({
      entries: [entry({ id: 'valid', updatedAt: 20 })],
      tombstones: [{ id: 'e1', removedAt: 10 }],
    });
  });

  it('returns a legacy array when the tombstone argument is explicitly undefined', () => {
    const merged = mergeRemoteEntries([entry()], [], undefined);

    expect(Array.isArray(merged)).toBe(true);
    expect(merged).toStrictEqual([entry()]);
    expectTypeOf(merged).toEqualTypeOf<Entry[]>();
  });

  it('types the legacy and tombstone overload return values', () => {
    const legacy = mergeRemoteEntries([], []);
    const withTombstones = mergeRemoteEntries([], [], { local: [], remote: [] });

    expectTypeOf(legacy).toEqualTypeOf<Entry[]>();
    expectTypeOf(withTombstones).toEqualTypeOf<{
      entries: Entry[];
      tombstones: Tombstone[];
    }>();
    expect(withTombstones).toStrictEqual({ entries: [], tombstones: [] });
  });
});
