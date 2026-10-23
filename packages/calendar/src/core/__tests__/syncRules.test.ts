import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pkg from '../../index.js';
import { createCalendarController } from '../controller.js';

// Notesdiary sync rules (G4): 24h full rule, retry-once, per-calendar isolation, deferred, lastSyncAt.
const NOW = new Date('2026-01-31T00:00:00Z');
const H = 3600_000;
const S = { id: 'a', email: 'a@x.com' };
const cal = (id: string, primary = false) => ({ id, summary: id, primary, accessRole: 'owner' });
const item = (id: string) => ({
  id,
  summary: id,
  status: 'confirmed',
  start: { dateTime: '2026-02-03T10:00:00Z' },
  end: { dateTime: '2026-02-03T11:00:00Z' },
  htmlLink: '',
});
const cached = (id: string, calendarId: string) => ({
  id,
  sourceId: 'a',
  calendarId,
  summary: id,
  start: { dateTime: '2026-02-01T10:00:00.000Z' },
  end: { dateTime: '2026-02-02T11:00:00.000Z' },
  isAllDay: false,
  selfResponseStatus: 'accepted',
  joinUrl: null,
  organizer: { self: false },
  htmlLink: '',
});

let log: string[] = [];
// per-calendar queue of responses: number = http status, array = items
let script: Record<string, Array<number | any[]>> = {};

function stubFetch(cals = [cal('primary', true)]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const u = new URL(String(input));
      log.push(decodeURIComponent(u.pathname) + u.search);
      if (u.pathname.endsWith('/calendarList')) return new Response(JSON.stringify({ items: cals }), { status: 200 });
      const id = decodeURIComponent(u.pathname).match(/calendars\/(.+)\/events/)![1];
      const next = script[id]?.shift() ?? [];
      if (typeof next === 'number') return new Response('{}', { status: next });
      return new Response(JSON.stringify({ items: next, nextSyncToken: 'NEW' }), { status: 200 });
    }),
  );
}
const eventCalls = (cid?: string) =>
  log.filter((l) => l.includes('/events') && (!cid || l.includes(`/calendars/${cid}/events`)));

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
const row = (syncState: any, events: any[] = [], selectedIds = ['primary']) => ({ events, syncState, selectedIds });

function make(storage: any, getToken: (id: string) => Promise<string> = async () => 't') {
  return createCalendarController({ sources: [S], getToken, storage, crypto: identity, now: () => NOW });
}
const ids = (c: any) => c.getEvents().map((e: any) => e.id).sort();

beforeEach(() => {
  log = [];
  script = {};
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('full vs incremental', () => {
  it('uses incremental (syncToken only) when token present and lastFullSyncAt < 24h', async () => {
    stubFetch();
    const c = make(makeStorage(row({ tokens: { primary: 'TOK' }, lastFullSyncAt: { primary: NOW.getTime() - 23 * H } })));
    await c.refresh();
    const calls = eventCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('syncToken=TOK');
    expect(calls[0]).not.toContain('timeMin');
  });

  it('exactly 24h old still uses incremental', async () => {
    stubFetch();
    const c = make(makeStorage(row({ tokens: { primary: 'TOK' }, lastFullSyncAt: { primary: NOW.getTime() - 24 * H } })));
    await c.refresh();
    expect(eventCalls()[0]).toContain('syncToken=TOK');
  });

  it('does a full windowed sync when lastFullSyncAt > 24h', async () => {
    stubFetch();
    const c = make(makeStorage(row({ tokens: { primary: 'TOK' }, lastFullSyncAt: { primary: NOW.getTime() - 25 * H } })));
    await c.refresh();
    const calls = eventCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('timeMin');
    expect(calls[0]).not.toContain('syncToken');
  });

  it('does a full sync with no token', async () => {
    stubFetch();
    await make(makeStorage()).refresh();
    expect(eventCalls()[0]).toContain('timeMin');
  });

  it('treats a 0.1.0 row (token, no lastFullSyncAt) as full', async () => {
    stubFetch();
    await make(makeStorage(row({ tokens: { primary: 'TOK' } }))).refresh();
    expect(eventCalls()[0]).toContain('timeMin');
    expect(eventCalls()[0]).not.toContain('syncToken');
  });

  it('falls back to full on 410', async () => {
    stubFetch();
    script.primary = [410, [item('x')]];
    const c = make(makeStorage(row({ tokens: { primary: 'TOK' }, lastFullSyncAt: { primary: NOW.getTime() - H } })));
    await c.refresh();
    const calls = eventCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('syncToken=TOK');
    expect(calls[1]).toContain('timeMin');
    expect(ids(c)).toEqual(['x']);
  });
});

describe('retry and per-calendar isolation', () => {
  it('retries a transient 500 exactly once and recovers without error', async () => {
    stubFetch();
    script.primary = [500, [item('x')]];
    const c = make(makeStorage());
    await c.refresh();
    expect(eventCalls()).toHaveLength(2);
    expect(ids(c)).toEqual(['x']);
    expect(c.getState().error).toBe(false);
    expect(c.getSourceStatus().a).toBe('ok');
  });

  it('does not retry more than once', async () => {
    stubFetch();
    script.primary = [500, 500, 500];
    await make(makeStorage()).refresh();
    expect(eventCalls()).toHaveLength(2);
  });

  it('calendar A failing twice does not block B; A keeps cached events', async () => {
    stubFetch([cal('primary', true), cal('B')]);
    script.primary = [500, 500];
    script.B = [[item('b1')]];
    const st = makeStorage(row({ tokens: {} }, [cached('a-old', 'primary')], ['primary', 'B']));
    const c = make(st);
    await c.refresh();
    expect(ids(c)).toEqual(['a-old', 'b1']);
    expect(c.getState().error).toBe(false);
  });

  it('error only when ALL selected calendars failed and nothing is cached', async () => {
    stubFetch([cal('primary', true), cal('B')]);
    script.primary = [500, 500];
    script.B = [500, 500];
    const c = make(makeStorage(row({ tokens: {} }, [], ['primary', 'B'])));
    await c.refresh();
    expect(c.getEvents()).toEqual([]);
    expect(c.getState().error).toBe(true);
  });

  it('all calendars failing but cached events present shows cached, no error', async () => {
    stubFetch([cal('primary', true), cal('B')]);
    script.primary = [500, 500];
    script.B = [500, 500];
    const c = make(makeStorage(row({ tokens: {} }, [cached('old', 'primary')], ['primary', 'B'])));
    await c.refresh();
    expect(ids(c)).toEqual(['old']);
    expect(c.getState().error).toBe(false);
  });

  it('sets lastSyncAt on a pass, including when some calendars fail', async () => {
    stubFetch([cal('primary', true), cal('B')]);
    script.primary = [500, 500];
    script.B = [[item('b1')]];
    const c = make(makeStorage(row({ tokens: {} }, [], ['primary', 'B'])));
    expect(c.getState().lastSyncAt).toBeNull();
    await c.refresh();
    expect(c.getState().lastSyncAt).toBe(NOW.getTime());
  });
});

describe('deferred refresh', () => {
  const deferredErr = () => new (pkg as any).RefreshDeferredError('deferred');

  it('exports RefreshDeferredError and isRefreshDeferredError', () => {
    const e = deferredErr();
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('RefreshDeferredError');
    expect(e.deferred).toBe(true);
    const is = (pkg as any).isRefreshDeferredError;
    expect(is(e)).toBe(true);
    expect(is({ deferred: true })).toBe(true);
    expect(is(Object.assign(new Error('x'), { name: 'RefreshDeferredError' }))).toBe(true);
    expect(is(new Error('x'))).toBe(false);
    expect(is(null)).toBe(false);
  });

  it('deferred getToken: no status change, no error, no retry, deferred true, lastSyncAt set', async () => {
    stubFetch();
    const getToken = vi.fn(async () => {
      throw deferredErr();
    });
    const c = make(makeStorage(), getToken);
    await c.refresh();
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(eventCalls()).toHaveLength(0);
    expect(c.getSourceStatus().a).toBe('ok');
    const s = c.getState();
    expect(s.error).toBe(false);
    expect(s.deferred).toBe(true);
    expect(s.lastSyncAt).toBe(NOW.getTime());
  });

  it('next successful refresh clears deferred', async () => {
    stubFetch();
    let fail = true;
    const c = make(makeStorage(), async () => {
      if (fail) throw deferredErr();
      return 't';
    });
    await c.refresh();
    expect(c.getState().deferred).toBe(true);
    fail = false;
    await c.refresh();
    expect(c.getState().deferred).toBe(false);
  });

  it('retryDeferred() clears deferred on success', async () => {
    stubFetch();
    let fail = true;
    const c = make(makeStorage(), async () => {
      if (fail) throw deferredErr();
      return 't';
    });
    await c.refresh();
    fail = false;
    await c.retryDeferred();
    expect(c.getState().deferred).toBe(false);
    expect(eventCalls().length).toBeGreaterThan(0);
  });

  it('plain network error keeps status (0.1.0 behavior) and is not deferred', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const c = make(makeStorage());
    await c.refresh();
    expect(c.getSourceStatus().a).toBe('ok');
    expect(c.getState().deferred).toBe(false);
  });
});
