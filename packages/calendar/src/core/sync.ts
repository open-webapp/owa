import { CalendarFetchError, fetchEvents } from './fetch.js';
import { getRollingWindow, parseEvents } from './events.js';
import { applyChanges } from './reconcile.js';
import type { CalendarEvent } from './types.js';

export interface CalendarSyncResult {
  events: CalendarEvent[];
  syncToken?: string;
}

/** Syncs one calendar: incremental when a token exists, full (windowed) otherwise or on 410. */
export async function syncCalendar(args: {
  token: string;
  sourceId: string;
  calendarId: string;
  existing: CalendarEvent[];
  syncToken?: string;
  now: Date;
}): Promise<CalendarSyncResult> {
  const { token, sourceId, calendarId, existing, syncToken, now } = args;
  const ctx = { sourceId, calendarId };
  const full = async (): Promise<CalendarSyncResult> => {
    const w = getRollingWindow(now);
    const page = await fetchEvents(token, calendarId, { timeMin: w.start, timeMax: w.end });
    return { events: parseEvents(page.items, ctx), syncToken: page.nextSyncToken };
  };
  if (!syncToken) return full();
  try {
    const page = await fetchEvents(token, calendarId, { syncToken });
    return {
      events: applyChanges(existing, page.items, ctx),
      syncToken: page.nextSyncToken ?? syncToken,
    };
  } catch (e) {
    if (e instanceof CalendarFetchError && e.kind === 'gone') return full();
    throw e;
  }
}
