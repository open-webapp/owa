import { reconcileSelectedCalendarIds } from './events.js';
import { parseEvent } from './events.js';
import type { CalendarEvent, CalendarInfo } from './types.js';

/** Stored selection filtered to existing calendars; the primary calendar is always included. */
export function reconcileSelection(stored: string[] | null, calendars: CalendarInfo[]): string[] {
  const ids = reconcileSelectedCalendarIds(stored, calendars);
  const primary = calendars.find((c) => c.primary);
  if (primary && !ids.includes(primary.id)) ids.unshift(primary.id);
  return ids;
}

/** Applies an incremental page of raw items to one calendar's events (cancelled items remove). */
export function applyChanges(
  existing: CalendarEvent[],
  items: any[],
  ctx: { sourceId: string; calendarId: string },
): CalendarEvent[] {
  const map = new Map(existing.map((e) => [e.id, e]));
  for (const raw of items) {
    if (!raw || typeof raw.id !== 'string') continue;
    const parsed = parseEvent(raw, ctx);
    if (parsed) map.set(parsed.id, parsed);
    else map.delete(raw.id);
  }
  return [...map.values()];
}
