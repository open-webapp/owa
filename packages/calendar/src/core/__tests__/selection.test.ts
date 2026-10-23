import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCalendarController } from '../controller.js';
import { reconcileSelection } from '../reconcile.js';

// Expected values are hand-written literals mirroring notesdiary's selection rules.

const cal = (id: string, primary = false) => ({ id, summary: id, primary, accessRole: 'owner' as const });
const primary = cal('primary', true);
const work = cal('work');
const other = cal('other');

describe('reconcileSelection (notesdiary rule)', () => {
  it('keeps a stored selection that omits primary (primary NOT added)', () => {
    expect(reconcileSelection(['work'], [primary, work])).toEqual(['work']);
  });
  it('defaults to the primary calendar when nothing is stored', () => {
    expect(reconcileSelection(null, [primary, work])).toEqual(['primary']);
  });
  it('falls back to primary when every stored id is unavailable', () => {
    expect(reconcileSelection(['gone', 'removed'], [primary, work])).toEqual(['primary']);
  });
  it('drops unavailable ids and keeps the rest', () => {
    expect(reconcileSelection(['work', 'gone'], [primary, work])).toEqual(['work']);
  });
  it('falls back to the first calendar when there is no primary', () => {
    expect(reconcileSelection(null, [work, other])).toEqual(['work']);
  });
  it('returns [] for an empty calendar list', () => {
    expect(reconcileSelection(['work'], [])).toEqual([]);
  });
});

describe('controller selection (notesdiary rule)', () => {
  const A = { id: 'a', email: 'a@x.com' };
  let listFails = false;

  function makeStorage(initial?: string[]) {
    const rows = new Map<string, any>();
    if (initial) rows.set('a', { events: [], syncState: null, selectedIds: initial });
    return {
      rows,
      get: async (id: string) => rows.get(id) ?? null,
      put: async (id: string, row: any) => void rows.set(id, row),
      delete: async (id: string) => void rows.delete(id),
      clear: async (id: string) => void rows.delete(id),
    };
  }

  function setup(cals: Array<ReturnType<typeof cal>>, initial?: string[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const u = new URL(String(input));
        if (u.pathname.endsWith('/calendarList')) {
          if (listFails) throw new TypeError('Failed to fetch');
          return new Response(JSON.stringify({ items: cals }), { status: 200 });
        }
        return new Response(JSON.stringify({ items: [], nextSyncToken: 'T' }), { status: 200 });
      }),
    );
    const controller = createCalendarController({
      sources: [A],
      getToken: async (id: string) => `tok-${id}`,
      storage: makeStorage(initial),
      crypto: { encrypt: async (s: string) => s, decrypt: async (s: string) => s },
      now: () => new Date('2026-01-31T00:00:00Z'),
    });
    return controller;
  }

  beforeEach(() => {
    listFails = false;
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stored [work] stays [work] (primary not added)', async () => {
    const c = setup([primary, work], ['work']);
    await c.refresh();
    expect(c.getSelectedIds('a')).toEqual(['work']);
  });

  it('nothing stored selects primary only', async () => {
    const c = setup([primary, work]);
    await c.refresh();
    expect(c.getSelectedIds('a')).toEqual(['primary']);
  });

  it('all stored ids unavailable -> [primary]; some unavailable -> dropped', async () => {
    const c1 = setup([primary, work], ['gone']);
    await c1.refresh();
    expect(c1.getSelectedIds('a')).toEqual(['primary']);
    const c2 = setup([primary, work, other], ['work', 'gone', 'other']);
    await c2.refresh();
    expect(c2.getSelectedIds('a')).toEqual(['work', 'other']);
  });

  it('no primary in list -> first calendar; empty list -> []', async () => {
    const c1 = setup([work, other]);
    await c1.refresh();
    expect(c1.getSelectedIds('a')).toEqual(['work']);
    const c2 = setup([]);
    await c2.refresh();
    expect(c2.getSelectedIds('a')).toEqual([]);
  });

  it('allows deselecting primary while another calendar stays selected', async () => {
    const c = setup([primary, work], ['primary', 'work']);
    await c.refresh();
    await c.setSelectedIds('a', ['work']);
    expect(c.getSelectedIds('a')).toEqual(['work']);
  });

  it('refuses to deselect the last selected calendar', async () => {
    const c = setup([primary, work], ['work']);
    await c.refresh();
    await c.setSelectedIds('a', []);
    expect(c.getSelectedIds('a')).toEqual(['work']);
  });

  it('Clear resets selection to [primary]', async () => {
    const c = setup([primary, work], ['work', 'other']);
    await c.refresh();
    await c.clearSelectedIds('a');
    expect(c.getSelectedIds('a')).toEqual(['primary']);
  });

  it('list fetch failure keeps the current selection', async () => {
    const c = setup([primary, work], ['work']);
    listFails = true;
    await c.refresh();
    expect(c.getSelectedIds('a')).toEqual(['work']);
  });

  it('list fetch failure with nothing stored falls back to [primary]', async () => {
    const c = setup([primary, work]);
    listFails = true;
    await c.refresh();
    expect(c.getSelectedIds('a')).toEqual(['primary']);
  });
});
