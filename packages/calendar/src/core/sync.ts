import { CalendarFetchError, fetchEvents } from './fetch.js';
import { getRollingWindow, parseEvents } from './events.js';
import { applyChanges } from './reconcile.js';
import type { CalendarEvent } from './types.js';

export interface CalendarSyncResult {
  events: CalendarEvent[];
  syncToken?: string;
  /** True when a full (windowed) sync was performed. */
  full: boolean;
}

export const FULL_SYNC_MAX_AGE_MS = 24 * 3600_000;

/** Syncs one calendar: incremental when a token exists, full (windowed) otherwise or on 410. */
export async function syncCalendar(args: {
  token: string;
  sourceId: string;
  calendarId: string;
  existing: CalendarEvent[];
  syncToken?: string;
  lastFullSyncAt?: number;
  now: Date;
}): Promise<CalendarSyncResult> {
  const { token, sourceId, calendarId, existing, syncToken, lastFullSyncAt, now } = args;
  const ctx = { sourceId, calendarId };
  const full = async (): Promise<CalendarSyncResult> => {
    const w = getRollingWindow(now);
    const page = await fetchEvents(token, calendarId, { timeMin: w.start, timeMax: w.end });
    return { events: parseEvents(page.items, ctx), syncToken: page.nextSyncToken, full: true };
  };
  const stale = lastFullSyncAt === undefined || now.getTime() - lastFullSyncAt > FULL_SYNC_MAX_AGE_MS;
  if (!syncToken || stale) return full();
  try {
    const page = await fetchEvents(token, calendarId, { syncToken });
    return {
      events: applyChanges(existing, page.items, ctx),
      syncToken: page.nextSyncToken ?? syncToken,
      full: false,
    };
  } catch (e) {
    if (e instanceof CalendarFetchError && e.kind === 'gone') return full();
    throw e;
  }
}
