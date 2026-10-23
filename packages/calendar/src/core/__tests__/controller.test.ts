import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCalendarController } from '../controller.js';

// ---- inline fakes (replaced by src/testing fakes in T6) ----

interface Req {
  url: string;
  token: string;
}
type Reply = { status: number; body?: unknown } | 'network-error';
type Router = (req: Req, u: URL) => Reply;

function installFakeFetch(router: Router) {
  const log: Req[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      const auth = init?.headers?.Authorization ?? init?.headers?.authorization ?? '';
      const req = { url, token: auth.replace(/^Bearer /, '') };
      log.push(req);
      const reply = router(req, new URL(url));
      if (reply === 'network-error') throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(reply.body ?? {}), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return log;
}

function makeFakeStorage() {
  const rows = new Map<string, { events: unknown[]; syncState: unknown; selectedIds: string[] }>();
  return {
    rows,
    async get(sourceId: string) {
      return rows.get(sourceId) ?? null;
    },
    async put(sourceId: string, row: any) {
      rows.set(sourceId, row);
    },
    async delete(sourceId: string) {
      rows.delete(sourceId);
    },
    async clear(sourceId: string) {
      rows.delete(sourceId);
    },
  };
}

const crypto = { encrypt: async (s: string) => s, decrypt: async (s: string) => s };
const NOW = new Date('2026-01-31T00:00:00Z');
const TIME_MIN = '2026-01-01T00:00:00Z';
const TIME_MAX = '2026-03-02T00:00:00Z';

const A = { id: 'a', email: 'a@x.com' };
const B = { id: 'b', email: 'b@x.com' };

const rawEvent = (id: string, summary: string) => ({
  id,
  summary,
  status: 'confirmed',
  start: { dateTime: '2026-02-01T10:00:00Z' },
  end: { dateTime: '2026-02-01T11:00:00Z' },
  htmlLink: `https://cal/${id}`,
});

const calList = (...cals: Array<{ id: string; primary?: boolean }>) => ({
  status: 200,
  body: {
    items: cals.map((c) => ({
      id: c.id,
      summary: c.id,
      primary: !!c.primary,
      accessRole: 'owner',
    })),
  },
});

const isCalList = (u: URL) => u.pathname.endsWith('/calendarList');
const isEvents = (u: URL) => u.pathname.endsWith('/events');
const eventsReqs = (log: Req[]) => log.filter((r) => isEvents(new URL(r.url)));

function setup(sources = [A], router: Router, storage = makeFakeStorage()) {
  const log = installFakeFetch(router);
  const controller = createCalendarController({
    sources,
    getToken: async (id: string) => `tok-${id}`,
    storage,
    crypto,
    now: () => NOW,
  });
  return { controller, log, storage };
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('sync', () => {
  it('first sync returns events; next refresh sends the syncToken', async () => {
    let call = 0;
    const { controller, log } = setup([A], (_r, u) => {
      if (isCalList(u)) return calList({ id: 'primary', primary: true });
      call++;
      return call === 1
        ? { status: 200, body: { items: [rawEvent('e1', 'Standup')], nextSyncToken: 'T1' } }
        : { status: 200, body: { items: [], nextSyncToken: 'T2' } };
    });

    await controller.refresh();
    expect(controller.getEvents().map((e) => [e.sourceId, e.calendarId, e.id, e.summary])).toEqual([
      ['a', 'primary', 'e1', 'Standup'],
    ]);
    const first = new URL(eventsReqs(log)[0].url);
    expect(first.searchParams.get('timeMin')).toBe(TIME_MIN);
    expect(first.searchParams.get('timeMax')).toBe(TIME_MAX);
    expect(first.searchParams.get('syncToken')).toBeNull();

    await controller.refresh();
    const second = new URL(eventsReqs(log)[1].url);
    expect(second.searchParams.get('syncToken')).toBe('T1');
    expect(controller.getEvents().map((e) => e.id)).toEqual(['e1']);
  });

  it('410 on incremental sync triggers a full resync that replaces events', async () => {
    let call = 0;
    const { controller, log } = setup([A], (_r, u) => {
      if (isCalList(u)) return calList({ id: 'primary', primary: true });
      call++;
      if (call === 1) return { status: 200, body: { items: [rawEvent('old', 'Old')], nextSyncToken: 'T1' } };
      if (call === 2) return { status: 410, body: { error: { code: 410 } } };
      return { status: 200, body: { items: [rawEvent('new', 'New')], nextSyncToken: 'T3' } };
    });

    await controller.refresh();
    await controller.refresh();

    expect(controller.getEvents().map((e) => e.id)).toEqual(['new']);
    const third = new URL(eventsReqs(log)[2].url);
    expect(third.searchParams.get('syncToken')).toBeNull();
    expect(third.searchParams.get('timeMin')).toBe(TIME_MIN);
    expect(third.searchParams.get('timeMax')).toBe(TIME_MAX);
  });

  it('keeps sources isolated: same eventId in two sources yields two events', async () => {
    const { controller } = setup([A, B], (r, u) => {
      if (isCalList(u)) return calList({ id: 'primary', primary: true });
      return {
        status: 200,
        body: { items: [rawEvent('same', `from ${r.token}`)], nextSyncToken: 'T' },
      };
    });

    await controller.refresh();
    const events = controller.getEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e) => [e.sourceId, e.id, e.summary]).sort()).toEqual([
      ['a', 'same', 'from tok-a'],
      ['b', 'same', 'from tok-b'],
    ]);
  });
});

describe('per-source failures', () => {
  const okRouter: Router = (_r, u) =>
    isCalList(u)
      ? calList({ id: 'primary', primary: true })
      : { status: 200, body: { items: [rawEvent('e', 'Ok')], nextSyncToken: 'T' } };

  it('getToken rejecting for one source sets sourceStatus=error; other source still renders', async () => {
    installFakeFetch(okRouter);
    const controller = createCalendarController({
      sources: [A, B],
      getToken: async (id: string) => {
        if (id === 'a') throw new Error('no token');
        return `tok-${id}`;
      },
      storage: makeFakeStorage(),
      crypto,
      now: () => NOW,
    });
    await controller.refresh();
    expect(controller.getSourceStatus()).toEqual({ a: 'error', b: 'ok' });
    expect(controller.getEvents().map((e) => e.sourceId)).toEqual(['b']);
  });

  it('403 insufficient scope -> needs-scope; other source still renders', async () => {
    const { controller } = setup([A, B], (r, u) =>
      r.token === 'tok-a'
        ? {
            status: 403,
            body: { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } },
          }
        : okRouter(r, u),
    );
    await controller.refresh();
    expect(controller.getSourceStatus()).toEqual({ a: 'needs-scope', b: 'ok' });
    expect(controller.getEvents().map((e) => e.sourceId)).toEqual(['b']);
  });

  it('401 -> error', async () => {
    const { controller } = setup([A, B], (r, u) =>
      r.token === 'tok-a' ? { status: 401, body: { error: { code: 401 } } } : okRouter(r, u),
    );
    await controller.refresh();
    expect(controller.getSourceStatus()).toEqual({ a: 'error', b: 'ok' });
    expect(controller.getEvents().map((e) => e.sourceId)).toEqual(['b']);
  });

  it('network failure keeps cached events', async () => {
    let down = false;
    const { controller } = setup([A], (r, u) => (down ? 'network-error' : okRouter(r, u)));
    await controller.refresh();
    down = true;
    await controller.refresh();
    expect(controller.getEvents().map((e) => e.id)).toEqual(['e']);
  });
});

describe('selected calendar reconcile (per source)', () => {
  const twoCals: Router = (_r, u) =>
    isCalList(u)
      ? calList({ id: 'primary', primary: true }, { id: 'work' })
      : { status: 200, body: { items: [], nextSyncToken: 'T' } };

  const seed = (storage: ReturnType<typeof makeFakeStorage>, sourceId: string, selectedIds: string[]) =>
    storage.put(sourceId, { events: [], syncState: null, selectedIds });

  it('drops stale selected IDs not in the calendar list', async () => {
    const storage = makeFakeStorage();
    await seed(storage, 'a', ['work', 'deleted-cal']);
    const { controller } = setup([A], twoCals, storage);
    await controller.refresh();
    expect(controller.getSelectedIds('a').sort()).toEqual(['primary', 'work']);
  });

  it('always keeps primary even if stored selection omits it', async () => {
    const storage = makeFakeStorage();
    await seed(storage, 'a', ['work']);
    const { controller } = setup([A], twoCals, storage);
    await controller.refresh();
    expect(controller.getSelectedIds('a')).toContain('primary');
  });

  it('Clear keeps primary, only for the given source', async () => {
    const storage = makeFakeStorage();
    await seed(storage, 'a', ['primary', 'work']);
    await seed(storage, 'b', ['primary', 'work']);
    const { controller } = setup([A, B], twoCals, storage);
    await controller.refresh();
    await controller.clearSelectedIds('a');
    expect(controller.getSelectedIds('a')).toEqual(['primary']);
    expect(controller.getSelectedIds('b').sort()).toEqual(['primary', 'work']);
  });
});
