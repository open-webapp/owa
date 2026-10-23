import { CalendarFetchError, fetchCalendarList } from './fetch.js';
import { reconcileSelection } from './reconcile.js';
import { syncCalendar } from './sync.js';
import type { CryptoAdapter, StorageAdapter, SyncState } from './storage.js';
import type { CalendarEvent, CalendarInfo, Source } from './types.js';

export type SourceStatus = 'ok' | 'needs-scope' | 'error';

export interface CalendarControllerOptions {
  sources: Source[];
  getToken: (sourceId: string) => Promise<string>;
  storage: StorageAdapter;
  crypto: CryptoAdapter;
  now?: () => Date;
}

export interface CalendarController {
  refresh(): Promise<void>;
  getEvents(): CalendarEvent[];
  getSourceStatus(): Record<string, SourceStatus>;
  readonly sourceStatus: Record<string, SourceStatus>;
  getCalendars(sourceId: string): CalendarInfo[];
  getSelectedIds(sourceId: string): string[];
  setSelectedIds(sourceId: string, ids: string[]): Promise<void>;
  clearSelectedIds(sourceId: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

interface SourceState {
  loaded: boolean;
  events: CalendarEvent[];
  syncState: SyncState;
  selectedIds: string[];
  calendars: CalendarInfo[];
  status: SourceStatus;
}

export function createCalendarController(opts: CalendarControllerOptions): CalendarController {
  const { sources, getToken, storage, crypto } = opts;
  const now = opts.now ?? (() => new Date());
  const state = new Map<string, SourceState>();
  const listeners = new Set<() => void>();
  let snapshot: CalendarEvent[] = [];
  let statusSnapshot: Record<string, SourceStatus> = {};

  for (const s of sources) {
    state.set(s.id, {
      loaded: false,
      events: [],
      syncState: { tokens: {} },
      selectedIds: [],
      calendars: [],
      status: 'ok',
    });
  }

  function publish() {
    snapshot = sources.flatMap((s) => state.get(s.id)!.events);
    statusSnapshot = Object.fromEntries(sources.map((s) => [s.id, state.get(s.id)!.status]));
    listeners.forEach((l) => l());
  }

  async function decode<T>(v: unknown, fallback: T): Promise<T> {
    if (typeof v === 'string') {
      try {
        return JSON.parse(await crypto.decrypt(v)) as T;
      } catch {
        return fallback;
      }
    }
    return (v ?? fallback) as T;
  }

  async function load(sourceId: string) {
    const st = state.get(sourceId)!;
    if (st.loaded) return;
    st.loaded = true;
    try {
      const row = await storage.get(sourceId);
      if (!row) return;
      st.events = await decode<CalendarEvent[]>(row.events, []);
      const ss = await decode<SyncState | null>(row.syncState, null);
      st.syncState = ss && ss.tokens ? ss : { tokens: {} };
      st.selectedIds = Array.isArray(row.selectedIds) ? row.selectedIds : [];
    } catch {
      /* unreadable cache: start empty */
    }
  }

  async function persist(sourceId: string) {
    const st = state.get(sourceId)!;
    try {
      await storage.put(sourceId, {
        events: await crypto.encrypt(JSON.stringify(st.events)),
        syncState: await crypto.encrypt(JSON.stringify(st.syncState)),
        selectedIds: st.selectedIds,
      });
    } catch {
      /* persistence is best-effort */
    }
  }

  async function refreshSource(sourceId: string) {
    const st = state.get(sourceId)!;
    await load(sourceId);
    try {
      const token = await getToken(sourceId);
      const calendars = await fetchCalendarList(token);
      st.calendars = calendars;
      const selected = reconcileSelection(st.selectedIds, calendars);
      const next: CalendarEvent[] = [];
      const tokens: Record<string, string> = {};
      for (const calendarId of selected) {
        const res = await syncCalendar({
          token,
          sourceId,
          calendarId,
          existing: st.events.filter((e) => e.calendarId === calendarId),
          syncToken: st.syncState.tokens[calendarId],
          now: now(),
        });
        next.push(...res.events);
        if (res.syncToken) tokens[calendarId] = res.syncToken;
      }
      st.events = next;
      st.syncState = { tokens };
      st.selectedIds = selected;
      st.status = 'ok';
      await persist(sourceId);
    } catch (e) {
      if (e instanceof CalendarFetchError) {
        if (e.kind === 'scope') st.status = 'needs-scope';
        else if (e.kind !== 'network') st.status = 'error';
      } else {
        st.status = 'error';
      }
    }
  }

  async function setSelected(sourceId: string, ids: string[]) {
    const st = state.get(sourceId);
    if (!st) return;
    await load(sourceId);
    const primary = st.calendars.find((c) => c.primary)?.id ?? (st.selectedIds.includes('primary') ? 'primary' : undefined);
    const next = [...new Set(primary && !ids.includes(primary) ? [primary, ...ids] : ids)];
    st.selectedIds = next;
    st.events = st.events.filter((e) => e.calendarId && next.includes(e.calendarId));
    const tokens: Record<string, string> = {};
    for (const id of next) if (st.syncState.tokens[id]) tokens[id] = st.syncState.tokens[id];
    st.syncState = { tokens };
    await persist(sourceId);
    publish();
  }

  const controller: CalendarController = {
    async refresh() {
      try {
        await Promise.all(sources.map((s) => refreshSource(s.id)));
      } catch {
        /* never throws */
      }
      publish();
    },
    getEvents: () => snapshot,
    getSourceStatus: () => statusSnapshot,
    get sourceStatus() {
      return statusSnapshot;
    },
    getCalendars: (id) => state.get(id)?.calendars ?? [],
    getSelectedIds: (id) => state.get(id)?.selectedIds ?? [],
    setSelectedIds: (id, ids) => setSelected(id, ids),
    clearSelectedIds: (id) => setSelected(id, []),
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  statusSnapshot = Object.fromEntries(sources.map((s) => [s.id, 'ok' as SourceStatus]));
  return controller;
}
