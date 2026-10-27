import { describe, expect, it } from 'vitest';
import { resolveStickyOpen } from '../stickyOpen.js';
import type { Entry } from '../types.js';

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'visible',
    date: '2026-10-09',
    time: '09:00',
    text: 'Call Mom #personal',
    createdAt: 1,
    ...overrides,
  };
}

describe('resolveStickyOpen', () => {
  it('opens a visible entry without clearing active filters', () => {
    const entry = makeEntry();

    expect(resolveStickyOpen([entry], entry.id, 'tag', ['#personal'], '')).toEqual({
      entry,
      clearFilters: false,
    });
  });

  it('opens an entry hidden by an active filter and requests clearing filters', () => {
    const entry = makeEntry();

    expect(resolveStickyOpen([entry], entry.id, 'tag', ['#work'], '')).toEqual({
      entry,
      clearFilters: true,
    });
  });

  it('returns null for an empty entry list', () => {
    expect(resolveStickyOpen([], 'missing', 'all', [], '')).toBeNull();
  });

  it('returns null without throwing for an unknown id', () => {
    expect(resolveStickyOpen([makeEntry()], 'missing', 'all', [], '')).toBeNull();
  });

  it('returns null without throwing for an archived entry id', () => {
    const entry = makeEntry({ archived: true });

    expect(resolveStickyOpen([entry], entry.id, 'all', [], '')).toBeNull();
  });
});
