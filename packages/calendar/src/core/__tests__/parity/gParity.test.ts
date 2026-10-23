import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pkg from '../../../index.js';
import { createCalendarController } from '../../controller.js';

// T11 parity completeness gate. Fills literal-level gaps vs notesdiary G-class tests
// (drive.calendar, calendarCache, App.calendarPane controller cases). Public API only.
// Mapping of notesdiary assertions to the package surface (not weakening, adapting the seam):
//  - syncCalendars()/loadCached()/getCalendarSyncState() -> controller.refresh()/getEvents()/persisted row
//  - result.errors[calId] -> getState().error (true only if all selected calendars fail and nothing cached)
//  - 86400001 ms / 86400000 ms boundaries kept verbatim.
// Intentional divergences from notesdiary (only these): none in this file; the multi-source event key
// form `src:cal:id` is asserted in events.test.ts (sole intentional divergence, see its header).
const NOW = new Date('2026-01-31T00:00:00Z'); // window start 2026-01-01T00:00Z, end 2026-03-02T00:00Z
const S = { id: 'a', email: 'a@x.com' };
const cal = (id: string, primary = false) => ({ id, summary: id, primary, accessRole: 'owner' });
const FUT = '2026-02-02T11:00:00.000Z';
const ev = (id: string, calendarId: string, startIso: string, endIso: string) => ({
  id, sourceId: 'a', calendarId, summary: id,
  start: { dateTime: startIso }, end: { dateTime: endIso },
  isAllDay: false, selfResponseStatus: 'accepted', joinUrl: null, organizer: { self: false }, htmlLink: '',
});
const fut = (id: string, calendarId: string) => ev(id, calendarId, '2026-02-01T10:00:00.000Z', FUT);
const item = (id: string) => ({ id, summary: id, status: 'confirmed',
  start: { dateTime: '2026-02-03T10:00:00Z' }, end: { dateTime: '2026-02-03T11:00:00Z' }, htmlLink: '' });

let log: string[] = [];
let script: Record<string, Array<number | any[]>> = {};
function stubFetch(cals = [cal('primary', true)]) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const u = new URL(String(input));
    log.push(decodeURIComponent(u.pathname) + u.search);
    if (u.pathname.endsWith('/calendarList')) return new Response(JSON.stringify({ items: cals }), { status: 200 });
    const id = decodeURIComponent(u.pathname).match(/calendars\/(.+)\/events/)![1];
    const next = script[id]?.shift() ?? [];
    if (typeof next === 'number') return new Response('{}', { status: next });
    return new Response(JSON.stringify({ items: next, nextSyncToken: 'NEW' }), { status: 200 });
  }));
}
const calls = (cid: string) => log.filter((l) => l.includes(`/calendars/${cid}/events`));
function makeStorage(row?: any) {
  const rows = new Map<string, any>();
  if (row) rows.set('a', row);
  return { rows, get: async (id: string) => rows.get(id) ?? null, put: async (id: string, r: any) => void rows.set(id, r),
    delete: async (id: string) => void rows.delete(id), clear: async (id: string) => void rows.delete(id) };
}
const identity = { encrypt: async (s: string) => s, decrypt: async (s: string) => s };
const make = (storage: any, getToken: () => Promise<string> = async () => 't') =>
  createCalendarController({ sources: [S], getToken, storage, crypto: identity, now: () => NOW });
const ids = (c: any) => c.getEvents().map((e: any) => e.id).sort();
const tokens = (st: any) => JSON.parse(st.rows.get('a').syncState).tokens;
const T = NOW.getTime();

beforeEach(() => { log = []; script = {}; });
afterEach(() => vi.unstubAllGlobals());

describe('drive.calendar parity literals', () => {
  it('full sync older than 24 hours (86400001 ms) is refreshed with a full fetch', async () => {
    stubFetch();
    const st = makeStorage({ events: [], syncState: { tokens: { primary: 'TOK' }, lastFullSyncAt: { primary: T - 86400001 } }, selectedIds: ['primary'] });
    await make(st).refresh();
    expect(calls('primary')).toHaveLength(1);
    expect(calls('primary')[0]).toContain('timeMin');
    expect(calls('primary')[0]).not.toContain('syncToken');
    expect(JSON.parse(st.rows.get('a').syncState).lastFullSyncAt.primary).toBe(T);
  });

  it('exactly 24 hours (86400000 ms) still uses delta and keeps lastFullSyncAt', async () => {
    stubFetch();
    const st = makeStorage({ events: [], syncState: { tokens: { primary: 'TOK' }, lastFullSyncAt: { primary: T - 86400000 } }, selectedIds: ['primary'] });
    await make(st).refresh();
    expect(calls('primary')).toHaveLength(1);
    expect(calls('primary')[0]).toContain('syncToken=TOK');
    expect(JSON.parse(st.rows.get('a').syncState).lastFullSyncAt.primary).toBe(T - 86400000);
  });

  it('one failure retains its cache/token while another updates', async () => {
    stubFetch([cal('primary', true), cal('two')]);
    script.primary = [500, 500];
    script.two = [[item('two-new')]];
    const st = makeStorage({ events: [fut('one-old', 'primary'), fut('two-old', 'two')],
      syncState: { tokens: { primary: 'old-token', two: 'old-token' }, lastFullSyncAt: { primary: T, two: T } }, selectedIds: ['primary', 'two'] });
    const c = make(st);
    await c.refresh();
    expect(ids(c)).toContain('one-old');
    expect(ids(c)).toContain('two-new');
    expect(tokens(st).primary).toBe('old-token');
    expect(tokens(st).two).toBe('NEW');
    expect(c.getState().error).toBe(false);
  });

  it('all failures return cached events after one retry each, token unchanged', async () => {
    stubFetch([cal('primary', true), cal('two')]);
    script.primary = [500, 500, 500];
    script.two = [500, 500, 500];
    const st = makeStorage({ events: [fut('one', 'primary'), fut('two', 'two')],
      syncState: { tokens: { primary: 'old-token', two: 'old-token' }, lastFullSyncAt: { primary: T, two: T } }, selectedIds: ['primary', 'two'] });
    const c = make(st);
    await c.refresh();
    expect(ids(c)).toEqual(['one', 'two']);
    expect(calls('primary').length + calls('two').length).toBe(4);
    expect(tokens(st).primary).toBe('old-token');
  });

  it('retries a transient failure once and ends without error', async () => {
    stubFetch();
    script.primary = [500, [item('x')]];
    const c = make(makeStorage());
    await c.refresh();
    expect(calls('primary')).toHaveLength(2);
    expect(ids(c)).toEqual(['x']);
    expect(c.getState().error).toBe(false);
  });

  it('deferred refresh is propagated quietly without retry or cache loss', async () => {
    stubFetch();
    const st = makeStorage({ events: [fut('kept', 'primary')], syncState: { tokens: { primary: 'TOK' }, lastFullSyncAt: { primary: T } }, selectedIds: ['primary'] });
    const getToken = vi.fn(async () => { throw new (pkg as any).RefreshDeferredError(); });
    const logSpy = vi.spyOn(console, 'error');
    const c = make(st, getToken);
    await c.hydrate();
    await expect(c.refresh()).resolves.not.toThrow();
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(ids(c)).toEqual(['kept']);
    expect(tokens(st).primary).toBe('TOK');
    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('deselected calendars are not fetched; reselect keeps token even for empty cache', async () => {
    stubFetch([cal('primary', true), cal('two')]);
    const st = makeStorage({ events: [], syncState: { tokens: { primary: 'full-token', two: 'two-token' }, lastFullSyncAt: { primary: T, two: T } }, selectedIds: ['primary'] });
    const c = make(st);
    await c.refresh();
    expect(calls('two')).toHaveLength(0);
    expect(tokens(st).two).toBe('two-token');
    await c.setSelectedIds('a', ['primary', 'two']);
    expect(calls('two')).toHaveLength(1);
    expect(calls('two')[0]).toContain('syncToken=two-token');
    expect(calls('two')[0]).not.toContain('timeMin');
  });

  it('prunes endMs strictly before now-30d, retaining the boundary and future deselected cache and token', async () => {
    stubFetch([cal('primary', true), cal('deselected')]);
    const st = makeStorage({
      events: [
        ev('0', 'deselected', '2025-12-31T22:59:59.999Z', '2025-12-31T23:59:59.999Z'),
        ev('1', 'deselected', '2025-12-31T23:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ev('2', 'deselected', '2026-02-01T10:00:00.000Z', FUT),
      ],
      syncState: { tokens: { primary: 'p', deselected: 'retained-token' }, lastFullSyncAt: { primary: T, deselected: T } },
      selectedIds: ['primary'],
    });
    const c = make(st);
    await c.refresh();
    const persisted = JSON.parse(st.rows.get('a').events).map((e: any) => e.id).sort();
    expect(persisted).toEqual(['1', '2']);
    expect(tokens(st).deselected).toBe('retained-token');
    expect(calls('deselected')).toHaveLength(0);
  });
});

describe('calendarCache parity literals', () => {
  it('filters selected calendars, excludes exact window edges, keeps overlaps; empty selection -> []', async () => {
    stubFetch([cal('primary', true), cal('other')]);
    const ws = '2026-01-01T00:00:00.000Z';
    const we = '2026-03-02T00:00:00.000Z';
    const st = makeStorage({
      events: [
        fut('inside', 'primary'),
        ev('ends-at-start', 'primary', '2025-12-31T23:00:00.000Z', ws),
        ev('starts-at-end', 'primary', we, '2026-03-02T01:00:00.000Z'),
        ev('overlap', 'primary', '2025-12-31T23:00:00.000Z', '2026-01-01T00:00:00.001Z'),
        fut('other-cal', 'other'),
      ],
      syncState: { tokens: {} }, selectedIds: ['primary'],
    });
    const c = make(st);
    await c.hydrate();
    expect(ids(c)).toEqual(['inside', 'overlap']);
  });
});

describe('App.calendarPane controller cases: no refetch of removed calendars', () => {
  it('after removing a calendar, later refreshes fetch only the remaining selection', async () => {
    stubFetch([cal('primary', true), cal('B')]);
    const st = makeStorage({ events: [fut('p1', 'primary'), fut('b1', 'B')],
      syncState: { tokens: { primary: 'TP', B: 'TB' }, lastFullSyncAt: { primary: T, B: T } }, selectedIds: ['primary', 'B'] });
    const c = make(st);
    await c.hydrate();
    await c.setSelectedIds('a', ['primary']);
    log = [];
    await c.refresh();
    expect(calls('B')).toHaveLength(0);
    expect(calls('primary')).toHaveLength(1);
    expect(ids(c)).toEqual(['p1']);
  });
});
