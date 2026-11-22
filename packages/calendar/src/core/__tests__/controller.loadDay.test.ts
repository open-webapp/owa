import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCalendarController } from '../controller.js';
import type { CalendarEvent } from '../types.js';

const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

const raw = (id = 'extra') => ({
  id, summary: id, status: 'confirmed',
  attendees: [{ email: 'self@example.com', self: true, responseStatus: 'accepted' }],
  organizer: { email: 'self@example.com', self: true },
  start: { dateTime: '2026-06-01T10:00:00Z' },
  end: { dateTime: '2026-06-01T11:00:00Z' },
});
const cached = (id: string): CalendarEvent => ({
  ...raw(id), sourceId: 'a', calendarId: 'primary', isAllDay: false,
  selfResponseStatus: 'accepted', joinUrl: null, organizer: { self: false }, htmlLink: '',
});

function setup(ids = ['a'], events: CalendarEvent[] = [], selectedIds = ['primary']) {
  const row = { events, selectedIds, syncState: { tokens: { primary: 'saved-token' }, lastSyncAt: 123 } };
  const storage = {
    get: vi.fn(async (sourceId = 'a') => ({ ...structuredClone(row), events: events.map((e) => ({ ...e, sourceId })) })),
    put: vi.fn(async () => {}),
  };
  const getToken = vi.fn(async (id: string) => id);
  const controller = createCalendarController({
    sources: ids.map((id) => ({ id, email: `${id}@example.com` })), storage,
    crypto: { encrypt: async (value: string) => value, decrypt: async (value: string) => value },
    getToken, now: () => new Date('2026-06-01T12:00:00Z'),
  });
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response({ items: [raw()] }));
  vi.stubGlobal('fetch', fetchMock);
  return { controller, storage, getToken, fetchMock, row };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('controller.loadDay', () => {
  it('adds out-of-window events and notifies subscribers', async () => {
    const { controller, fetchMock } = setup();
    fetchMock.mockImplementation(async () => response({ items: [{
      ...raw(), start: { dateTime: '2026-09-01T10:00:00Z' }, end: { dateTime: '2026-09-01T11:00:00Z' },
    }] }));
    const listener = vi.fn();
    controller.subscribe(listener);
    await controller.loadDay('2026-09-01');
    expect(controller.getEvents().map((e) => e.id)).toEqual(['extra']);
    expect(listener).toHaveBeenCalled();
    await controller.loadDay('2026-09-01');
    expect(controller.getEvents()).toHaveLength(1);
  });

  it('deduplicates synced events and merges selected calendars across sources', async () => {
    const { controller, fetchMock } = setup(['a', 'b'], [cached('extra')], ['primary', 'team']);
    await controller.hydrate();
    await controller.loadDay('2026-06-01');
    expect(controller.getEvents().map((e) => `${e.sourceId}/${e.calendarId}/${e.id}`).sort()).toEqual([
      'a/primary/extra', 'a/team/extra', 'b/primary/extra', 'b/team/extra',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['America/Los_Angeles', '2026-03-08', '2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z'],
    ['Asia/Kolkata', '2026-03-08', '2026-03-07T18:30:00Z', '2026-03-08T18:30:00Z'],
  ])('uses local-day bounds in %s', async (tz, day, min, max) => {
    const previous = process.env.TZ;
    process.env.TZ = tz;
    try {
      const { controller, fetchMock } = setup();
      await controller.loadDay(day);
      const url = new URL(fetchMock.mock.calls[0][0]);
      expect(url.searchParams.get('timeMin')).toBe(min);
      expect(url.searchParams.get('timeMax')).toBe(max);
      expect(url.searchParams.get('singleEvents')).toBe('true');
      expect(url.searchParams.has('syncToken')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('does not write storage or alter sync state; refresh clears extras', async () => {
    const { controller, storage, fetchMock, row } = setup();
    const before = structuredClone(row);
    await controller.hydrate();
    await controller.loadDay('2026-06-01');
    expect(controller.getEvents()).toHaveLength(1);
    expect(storage.put).not.toHaveBeenCalled();
    expect(await storage.get()).toEqual(before);
    expect(controller.getState().lastSyncAt).toBe(123);
    fetchMock.mockImplementation(async () => response({ items: [] }));
    await controller.refresh();
    expect(controller.getEvents()).toEqual([]);
    const persisted = storage.put.mock.calls as unknown as [string, { syncState: string }][];
    expect(JSON.parse(persisted[0][1].syncState).tokens).toEqual({ primary: 'saved-token' });
  });

  it('resolves token adapter failures and allows a later call', async () => {
    const { controller, getToken } = setup();
    getToken.mockRejectedValueOnce(new Error('adapter failed'));
    await expect(controller.loadDay('2026-06-01')).resolves.toBeUndefined();
    expect(controller.getEvents()).toEqual([]);
    await controller.loadDay('2026-06-01');
    expect(controller.getEvents()).toHaveLength(1);
  });

  it('keeps successful sources when another source fails', async () => {
    const { controller, fetchMock } = setup(['a', 'b']);
    fetchMock.mockImplementation(async (_url, init) => {
      if ((init!.headers as Record<string, string>).Authorization === 'Bearer a') throw new Error('offline');
      return response({ items: [raw()] });
    });
    await expect(controller.loadDay('2026-06-01')).resolves.toBeUndefined();
    expect(controller.getEvents().map((e) => e.sourceId)).toEqual(['b']);
  });

  it('resolves fetch failure without extras', async () => {
    const { controller, fetchMock } = setup();
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(controller.loadDay('2026-06-01')).resolves.toBeUndefined();
    expect(controller.getEvents()).toEqual([]);
  });

  it.each([false, true])('ignores concurrent calls and releases the guard after failure=%s', async (fail) => {
    const { controller, fetchMock } = setup();
    let settle!: () => void;
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    fetchMock.mockImplementationOnce(async () => {
      await pending;
      if (fail) throw new Error('offline');
      return response({ items: [raw()] });
    });
    const first = controller.loadDay('2026-06-01');
    await expect(controller.loadDay('2026-06-02')).resolves.toBeUndefined();
    settle();
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await controller.loadDay('2026-06-03');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
