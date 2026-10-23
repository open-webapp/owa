import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCalendarController } from '../controller.js';
import type { CalendarEvent } from '../types.js';

// Notesdiary cache-first rules (G2 hydrate, G3 retain on deselect, G6 prune). Public API only.
// now = 2026-01-31T00:00Z -> window start = 2026-01-01T00:00Z.

const NOW = new Date('2026-01-31T00:00:00Z');
const S = { id: 'a', email: 'a@x.com' };
const cal = (id: string, primary = false) => ({ id, summary: id, primary, accessRole: 'owner' });

const ev = (id: string, calendarId: string, endIso: string): CalendarEvent => ({
  id,
  sourceId: 'a',
  calendarId,
  summary: id,
  start: { dateTime: '2026-02-01T10:00:00.000Z' },
  end: { dateTime: endIso },
  isAllDay: false,
  selfResponseStatus: 'accepted',
  joinUrl: null,
  organizer: { self: false },
  htmlLink: '',
});
const FUT = '2026-02-02T11:00:00.000Z';

const apiEvent = (id: string, endIso: string) => ({
  id,
  summary: id,
  status: 'confirmed',
  start: { dateTime: '2026-02-03T10:00:00Z' },
  end: { dateTime: endIso },
  htmlLink: '',
});

function makeStorage(row?: any) {
  const rows = new Map<string, any>();
  if (row) rows.set('a', row);
  return {
    rows,
    get: async (id: string) => rows.get(id) ?? null,
    put: async (id: string, r: any) => void rows.set(id, r),
    delete: async (id: string) => void rows.delete(id),
    clear: async (id: string) => void rows.delete(id),
  };
}
const identity = { encrypt: async (s: string) => s, decrypt: async (s: string) => s };

let log: string[] = [];
let gate: Promise<void> | null = null;
let offline = false;
let eventItems: Record<string, any[]> = {};

function stubFetch(cals = [cal('primary', true), cal('B')]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const u = new URL(String(input));
      log.push(u.pathname + u.search);
      if (gate) await gate;
      if (offline) throw new TypeError('Failed to fetch');
      if (u.pathname.endsWith('/calendarList')) return new Response(JSON.stringify({ items: cals }), { status: 200 });
      const m = decodeURIComponent(u.pathname).match(/calendars\/(.+)\/events/);
      return new Response(JSON.stringify({ items: eventItems[m![1]] ?? [], nextSyncToken: 'NEW' }), { status: 200 });
    }),
  );
}

function make(storage: any, crypto: any = identity) {
  return createCalendarController({ sources: [S], getToken: async () => 't', storage, crypto, now: () => NOW });
}
const ids = (c: any) => c.getEvents().map((e: CalendarEvent) => e.id).sort();

beforeEach(() => {
  log = [];
  gate = null;
  offline = false;
  eventItems = {};
});
afterEach(() => vi.unstubAllGlobals());

describe('cache-first hydrate (G2)', () => {
  it('publishes cached events before the first fetch resolves, then refresh merges', async () => {
    const storage = makeStorage({
      events: [ev('cached', 'primary', FUT)],
      syncState: { tokens: { primary: 'TOK' }, lastFullSyncAt: { primary: NOW.getTime() } },
      selectedIds: ['primary'],
    });
    stubFetch();
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    eventItems.primary = [apiEvent('fresh', FUT)];
    const c = make(storage);
    const seen: string[][] = [];
    c.subscribe(() => seen.push(ids(c)));

    await (c as any).hydrate();
    expect(ids(c)).toEqual(['cached']);
    expect(c.getSelectedIds('a')).toEqual(['primary']);
    expect(log).toEqual([]); // no network during hydrate

    const p = c.refresh();
    await Promise.resolve();
    expect(ids(c)).toEqual(['cached']); // still pending
    release();
    await p;
    expect(ids(c)).toEqual(['cached', 'fresh']);
    expect(seen[0]).toEqual(['cached']);
  });
});

describe('offline + retained selection (G3)', () => {
  it('offline refresh keeps cached events with no error', async () => {
    const storage = makeStorage({ events: [ev('cached', 'primary', FUT)], syncState: { tokens: {} }, selectedIds: ['primary'] });
    stubFetch();
    offline = true;
    const c = make(storage);
    await (c as any).hydrate();
    await c.refresh();
    expect(ids(c)).toEqual(['cached']);
    expect(c.getSourceStatus()).toEqual({ a: 'ok' });
  });

  it('deselect then reselect restores B instantly from cache and uses its stored syncToken', async () => {
    const storage = makeStorage({
      events: [ev('p1', 'primary', FUT), ev('b1', 'B', FUT)],
      syncState: { tokens: { primary: 'TP', B: 'TB' }, lastFullSyncAt: { primary: NOW.getTime(), B: NOW.getTime() } },
      selectedIds: ['primary', 'B'],
    });
    stubFetch();
    const c = make(storage);
    await (c as any).hydrate();
    await c.setSelectedIds('a', ['primary']);
    expect(ids(c)).toEqual(['p1']);
    // retained in persisted row, not dropped
    const row = storage.rows.get('a');
    expect(JSON.parse(row.events).map((e: CalendarEvent) => e.id)).toContain('b1');
    expect(JSON.parse(row.syncState).tokens.B).toBe('TB');

    log = [];
    await c.setSelectedIds('a', ['primary', 'B']); // publishes cache, then syncs only B (G8)
    expect(ids(c)).toEqual(['b1', 'p1']);
    const bFetches = log.filter((l) => l.includes('/calendars/B/events'));
    expect(bFetches).toHaveLength(1);
    expect(bFetches[0]).toContain('syncToken=TB');
    expect(bFetches[0]).not.toContain('timeMin');
  });
});

describe('window prune (G6)', () => {
  it('drops events ending strictly before window start on each pass, keeps the boundary', async () => {
    const storage = makeStorage({
      events: [
        ev('old', 'primary', '2025-12-31T23:59:59.000Z'),
        ev('edge', 'primary', '2026-01-01T00:00:00.000Z'),
        ev('keep', 'primary', FUT),
      ],
      syncState: { tokens: { primary: 'TOK' }, lastFullSyncAt: { primary: NOW.getTime() } },
      selectedIds: ['primary'],
    });
    stubFetch();
    const c = make(storage);
    await c.refresh(); // incremental pass with empty delta
    // prune keeps the boundary row (persisted); the read-time window excludes an event ending exactly at window start
    expect(JSON.parse(storage.rows.get('a').events).map((e: CalendarEvent) => e.id).sort()).toEqual(['edge', 'keep']);
    expect(ids(c)).toEqual(['keep']);
  });
});

describe('unreadable cache', () => {
  it('corrupt cache hydrates to empty without throwing', async () => {
    const storage = makeStorage({ events: '%%bad%%', syncState: '{{', selectedIds: 'x' });
    stubFetch();
    const c = make(storage);
    await expect((c as any).hydrate()).resolves.not.toThrow();
    expect(c.getEvents()).toEqual([]);
  });

  it('wrong crypto key hydrates to empty without throwing', async () => {
    const storage = makeStorage({
      events: 'cipher:' + JSON.stringify([ev('x', 'primary', FUT)]),
      syncState: 'cipher:{"tokens":{}}',
      selectedIds: ['primary'],
    });
    stubFetch();
    const wrong = { encrypt: async (s: string) => s, decrypt: async () => { throw new Error('bad key'); } };
    const c = make(storage, wrong);
    await expect((c as any).hydrate()).resolves.not.toThrow();
    expect(c.getEvents()).toEqual([]);
  });
});
