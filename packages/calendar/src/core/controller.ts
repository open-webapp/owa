import { CalendarFetchError, fetchCalendarList, isRefreshDeferredError } from './fetch.js';
import { reconcileSelection } from './reconcile.js';
import { syncCalendar, type CalendarSyncResult } from './sync.js';
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

export interface CalendarControllerState {
  loading: boolean;
  /** True only when every selected calendar failed and nothing is cached. */
  error: boolean;
  deferred: boolean;
  lastSyncAt: number | null;
}

export interface CalendarController {
  hydrate(): Promise<void>;
  refresh(): Promise<void>;
  /** Re-runs a refresh after a deferred pass. */
  retryDeferred(): Promise<void>;
  getState(): CalendarControllerState;
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
  /** Calendars whose last sync failed (after retry). */
  errored: Set<string>;
  /** Bumped on selection change so in-flight refreshes don't clobber it. */
  gen: number;
}

export function createCalendarController(opts: CalendarControllerOptions): CalendarController {
  const { sources, getToken, storage, crypto } = opts;
  const now = opts.now ?? (() => new Date());
  const state = new Map<string, SourceState>();
  const listeners = new Set<() => void>();
  let snapshot: CalendarEvent[] = [];
  let loadingCount = 0;
  let deferred = false;
  let statusSnapshot: Record<string, SourceStatus> = {};

  for (const s of sources) {
    state.set(s.id, {
      loaded: false,
      events: [],
      syncState: { tokens: {} },
      selectedIds: ['primary'],
      calendars: [],
      status: 'ok',
      errored: new Set(),
      gen: 0,
    });
  }

  function publish() {
    snapshot = sources.flatMap((s) => {
      const st = state.get(s.id)!;
      const ws = now().getTime() - 30 * 86400000;
      const we = now().getTime() + 30 * 86400000;
      const ms = (v: string | undefined, d: number) => {
        const t = v ? new Date(v).getTime() : NaN;
        return Number.isNaN(t) ? d : t;
      };
      // read-time window: exact edges excluded, overlaps kept (notesdiary loadCached)
      return st.events.filter(
        (e) =>
          (!e.calendarId || st.selectedIds.includes(e.calendarId)) &&
          ms(e.end.dateTime ?? e.end.date, Infinity) > ws &&
          ms(e.start.dateTime ?? e.start.date, -Infinity) < we,
      );
    });
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
      if (Array.isArray(row.selectedIds)) st.selectedIds = row.selectedIds;
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

  async function syncWithRetry(run: () => Promise<CalendarSyncResult>): Promise<CalendarSyncResult> {
    try {
      return await run();
    } catch (e) {
      if (isRefreshDeferredError(e)) throw e;
      return run();
    }
  }

  /** Returns true when the pass was deferred. `only` limits syncing to those calendars. */
  async function refreshSource(sourceId: string, only?: string[]): Promise<boolean> {
    const st = state.get(sourceId)!;
    await load(sourceId);
    const gen = st.gen;
    let wasDeferred = false;
    try {
      const token = await getToken(sourceId);
      const calendars = await fetchCalendarList(token);
      st.calendars = calendars;
      const selected = reconcileSelection(st.selectedIds, calendars);
      const targets = only ? selected.filter((c) => only.includes(c)) : selected;
      const fresh: CalendarEvent[] = [];
      const synced: string[] = [];
      const tokens: Record<string, string> = { ...st.syncState.tokens };
      const lastFull: Record<string, number> = { ...st.syncState.lastFullSyncAt };
      const failures: unknown[] = [];
      for (const calendarId of targets) {
        try {
          const res = await syncWithRetry(() =>
            syncCalendar({
              token,
              sourceId,
              calendarId,
              existing: st.events.filter((e) => e.calendarId === calendarId),
              syncToken: st.syncState.tokens[calendarId],
              lastFullSyncAt: st.syncState.lastFullSyncAt?.[calendarId],
              now: now(),
            }),
          );
          fresh.push(...res.events);
          synced.push(calendarId);
          st.errored.delete(calendarId);
          if (res.syncToken) tokens[calendarId] = res.syncToken;
          else delete tokens[calendarId];
          if (res.full) lastFull[calendarId] = now().getTime();
        } catch (e) {
          if (isRefreshDeferredError(e)) throw e;
          failures.push(e);
          st.errored.add(calendarId);
        }
      }
      const winStart = new Date(now().getTime() - 30 * 86400000).getTime();
      const endMs = (e: CalendarEvent) => {
        const v = e.end.dateTime ?? e.end.date;
        const t = v ? new Date(v).getTime() : NaN;
        return Number.isNaN(t) ? Infinity : t;
      };
      st.events = [...st.events.filter((e) => !(e.calendarId && synced.includes(e.calendarId))), ...fresh].filter(
        (e) => endMs(e) >= winStart,
      );
      st.syncState = { ...st.syncState, tokens, lastFullSyncAt: lastFull };
      if (st.gen === gen) st.selectedIds = selected;
      if (failures.length === 0) st.status = 'ok';
      else if (failures.some((e) => e instanceof CalendarFetchError && e.kind === 'scope')) st.status = 'needs-scope';
      else if (failures.length < targets.length) st.status = 'ok';
      else if (failures.some((e) => !(e instanceof CalendarFetchError) || e.kind !== 'network')) st.status = 'error';
    } catch (e) {
      if (st.selectedIds.length === 0) st.selectedIds = ['primary'];
      if (isRefreshDeferredError(e)) {
        wasDeferred = true;
      } else if (e instanceof CalendarFetchError) {
        if (e.kind === 'scope') st.status = 'needs-scope';
        else if (e.kind !== 'network') st.status = 'error';
      } else {
        st.status = 'error';
      }
    }
    st.syncState = { ...st.syncState, lastSyncAt: now().getTime() };
    await persist(sourceId);
    return wasDeferred;
  }

  async function runPass(only?: Record<string, string[]>) {
    loadingCount++;
    try {
      const ids = sources.map((s) => s.id).filter((id) => !only || only[id]);
      const results = await Promise.all(ids.map((id) => refreshSource(id, only?.[id])));
      deferred = results.some(Boolean);
    } catch {
      /* never throws */
    } finally {
      loadingCount--;
    }
    publish();
  }

  async function setSelected(sourceId: string, ids: string[]) {
    const st = state.get(sourceId);
    if (!st) return;
    await load(sourceId);
    const next = [...new Set(ids)];
    if (next.length === 0) return;
    const added = next.filter((id) => !st.selectedIds.includes(id));
    st.selectedIds = next;
    st.gen++;
    await persist(sourceId);
    publish();
    if (added.length > 0) await runPass({ [sourceId]: added });
  }

  const controller: CalendarController = {
    async hydrate() {
      try {
        await Promise.all(sources.map((s) => load(s.id)));
      } catch {
        /* never throws */
      }
      publish();
    },
    refresh: () => runPass(),
    retryDeferred: () => runPass(),
    getState() {
      const sel = sources.flatMap((s) => {
        const st = state.get(s.id)!;
        return st.selectedIds.map((c) => st.errored.has(c));
      });
      const lasts = sources.map((s) => state.get(s.id)!.syncState.lastSyncAt).filter((v): v is number => typeof v === 'number');
      return {
        loading: loadingCount > 0,
        error: sel.length > 0 && sel.every(Boolean) && snapshot.length === 0,
        deferred,
        lastSyncAt: lasts.length ? Math.max(...lasts) : null,
      };
    },
    getEvents: () => snapshot,
    getSourceStatus: () => statusSnapshot,
    get sourceStatus() {
      return statusSnapshot;
    },
    getCalendars: (id) => state.get(id)?.calendars ?? [],
    getSelectedIds: (id) => state.get(id)?.selectedIds ?? [],
    setSelectedIds: (id, ids) => setSelected(id, ids),
    clearSelectedIds: (id) => setSelected(id, [state.get(id)?.calendars.find((c) => c.primary)?.id ?? 'primary']),
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  statusSnapshot = Object.fromEntries(sources.map((s) => [s.id, 'ok' as SourceStatus]));
  return controller;
}
