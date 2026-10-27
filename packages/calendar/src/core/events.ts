import type { CalendarEvent, CalendarInfo, ParseContext, RsvpStatus } from './types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const DEFAULT_RSVP_STATUSES: RsvpStatus[] = ['accepted', 'tentative', 'needsAction'];

/** Keeps stored calendar selections that still exist, defaulting to the primary calendar. */
export function reconcileSelectedCalendarIds(
  storedIds: string[] | null,
  calendars: CalendarInfo[],
): string[] {
  const availableIds = new Set(calendars.map((calendar) => calendar.id));
  const selectedIds = (storedIds ?? []).filter((id) => availableIds.has(id));
  if (selectedIds.length > 0) return selectedIds;

  const fallback = calendars.find((calendar) => calendar.primary) ?? calendars[0];
  return fallback ? [fallback.id] : [];
}

/** Filters calendars by a case-insensitive substring of their display name. */
export function filterCalendarsByName(calendars: CalendarInfo[], query: string): CalendarInfo[] {
  const normalizedQuery = query.toLocaleLowerCase();
  return normalizedQuery === ''
    ? calendars
    : calendars.filter((calendar) => calendar.summary.toLocaleLowerCase().includes(normalizedQuery));
}

/** Event IDs are unique only within their calendar and source. */
export function getCalendarEventKey(event: CalendarEvent): string {
  return `${event.sourceId}:${event.calendarId ?? ""}:${event.id}`;
}

/** Produces the compact calendar-selection label shown in the filter control. */
export function summarizeCalendarSelection(selectedIds: string[], calendars: CalendarInfo[]): string {
  if (selectedIds.length !== 1) return `${selectedIds.length} calendars`;
  return calendars.find((calendar) => calendar.id === selectedIds[0])?.summary ?? '1 calendar';
}

/** True iff the event is an all-day event. Passthrough of the package-computed flag. */
export function isAllDay(event: CalendarEvent): boolean {
  return event.isAllDay;
}

/**
 * Rolling fetch window: now-30d to now+30d, as full RFC3339 timestamps.
 * Google Calendar's `timeMin`/`timeMax` reject bare `YYYY-MM-DD` dates.
 */
export function getRollingWindow(now: Date): { start: string; end: string } {
  const start = new Date(now.getTime() - 30 * MS_PER_DAY);
  const end = new Date(now.getTime() + 30 * MS_PER_DAY);
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Returns events whose `selfResponseStatus` is a member of `selected` —
 * declined is a normal, independently-selectable status now, not hard-excluded.
 */
export function filterByRsvp(events: CalendarEvent[], selected: ReadonlySet<RsvpStatus>): CalendarEvent[] {
  return events.filter((e) => selected.has(e.selfResponseStatus));
}

/** displayName -> email -> "You" (only when organizer.self is true and both above are absent). */
export function getOrganizerLabel(event: CalendarEvent): string {
  const { organizer } = event;
  if (organizer.displayName) return organizer.displayName;
  if (organizer.email) return organizer.email;
  if (organizer.self === true) return 'You';
  return '';
}

/**
 * True iff `event` is a timed (non-all-day) event currently in progress at `now`:
 * both `start.dateTime` and `end.dateTime` exist and parse to valid instants,
 * start <= now < end.
 */
export function isEventCurrent(event: CalendarEvent, now: Date): boolean {
  if (isAllDay(event)) return false;
  const { start, end } = event;
  if (!start.dateTime || !end.dateTime) return false;
  const startMs = new Date(start.dateTime).getTime();
  const endMs = new Date(end.dateTime).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return false;
  const nowMs = now.getTime();
  return startMs <= nowMs && nowMs < endMs;
}

/**
 * Finds the soonest strictly-future timed event: `!isAllDay(event)`,
 * `start.dateTime` exists and parses valid, and `startMs > now.getTime()`.
 * Returns the smallest `startMs`; ties keep first-encountered array order.
 * Returns `null` if none qualify.
 */
export function findNextUpcomingEvent(events: CalendarEvent[], now: Date): CalendarEvent | null {
  const nowMs = now.getTime();
  let best: CalendarEvent | null = null;
  let bestMs = Infinity;
  for (const event of events) {
    if (isAllDay(event)) continue;
    const { dateTime } = event.start;
    if (!dateTime) continue;
    const startMs = new Date(dateTime).getTime();
    if (Number.isNaN(startMs)) continue;
    if (startMs <= nowMs) continue;
    if (startMs < bestMs) {
      bestMs = startMs;
      best = event;
    }
  }
  return best;
}

function getStartDateKey(event: CalendarEvent): string {
  const { start } = event;
  if (start.date) return start.date;
  if (start.dateTime) return start.dateTime.slice(0, 10);
  return '';
}

function getStartTimeSortKey(event: CalendarEvent): number {
  const { start } = event;
  if (start.dateTime) return new Date(start.dateTime).getTime();
  return -Infinity; // all-day events sort first
}

export interface DayGroup {
  dateKey: string;
  events: CalendarEvent[];
}

/**
 * Group by local calendar date, sorted ascending by day. Within a day,
 * all-day events come first (in list order), then timed events sorted by
 * start time ascending.
 *
 * When `todayIso` is given and has no events, an empty group for it is
 * still included (so a "Today" header can always be rendered / scrolled
 * to), inserted in correct sorted position.
 */
export function groupByDay(events: CalendarEvent[], todayIso?: string): DayGroup[] {
  const byDate = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const key = getStartDateKey(event);
    const list = byDate.get(key);
    if (list) {
      list.push(event);
    } else {
      byDate.set(key, [event]);
    }
  }

  if (todayIso !== undefined && !byDate.has(todayIso)) {
    byDate.set(todayIso, []);
  }

  const dateKeys = Array.from(byDate.keys()).sort();

  return dateKeys.map((dateKey) => {
    const dayEvents = byDate.get(dateKey)!;
    const allDayEvents = dayEvents.filter((e) => isAllDay(e));
    const timedEvents = dayEvents
      .filter((e) => !isAllDay(e))
      .sort((a, b) => getStartTimeSortKey(a) - getStartTimeSortKey(b));
    return { dateKey, events: [...allDayEvents, ...timedEvents] };
  });
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function parseIsoDateParts(dateKey: string): { year: number; month: number; day: number } {
  const [year, month, day] = dateKey.split('-').map(Number);
  return { year, month, day };
}

function formatMonthDay(dateKey: string, includeYear: boolean): string {
  const { year, month, day } = parseIsoDateParts(dateKey);
  const monthName = MONTH_NAMES[month - 1];
  const base = `${monthName} ${day}`;
  return includeYear ? `${base}, ${year}` : base;
}

/** Short "Mmm D" label for the day ribbon: no year, no Today/Tomorrow. */
export function formatRibbonLabel(dateKey: string): string {
  return formatMonthDay(dateKey, false);
}

function addDaysToIso(dateKey: string, days: number): string {
  const { year, month, day } = parseIsoDateParts(dateKey);
  const d = new Date(Date.UTC(year, month - 1, day));
  d.setUTCDate(d.getUTCDate() + days);
  // d is built from pure UTC parts (not "now"), so the UTC date is the right one.
  return d.toISOString().slice(0, 10);
}

/**
 * "Today · Sept 26" / "Tomorrow · Sept 27" / else "Sept 28"-style.
 * Includes year only when the event's year differs from today's year.
 */
export function formatDayHeader(dateKey: string, today: string): string {
  const { year: todayYear } = parseIsoDateParts(today);
  const { year: eventYear } = parseIsoDateParts(dateKey);
  const includeYear = eventYear !== todayYear;
  const monthDay = formatMonthDay(dateKey, includeYear);

  if (dateKey === today) return `Today · ${monthDay}`;
  if (dateKey === addDaysToIso(today, 1)) return `Tomorrow · ${monthDay}`;
  return monthDay;
}

interface RawEvent {
  id?: unknown;
  status?: string;
  summary?: string;
  start?: CalendarEvent['start'];
  end?: CalendarEvent['end'];
  attendees?: { self?: boolean; responseStatus?: string }[];
  organizer?: { displayName?: string; email?: string; self?: boolean };
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  location?: string;
  description?: string;
}

const JOIN_URL_REGEX =
  /https?:\/\/[^\s<>"']*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com)[^\s<>"']*/i;

export function deriveSelfResponseStatus(raw: RawEvent): RsvpStatus {
  if (!Array.isArray(raw.attendees)) return 'accepted';
  const status = raw.attendees.find((a) => a?.self === true)?.responseStatus;
  if (status === 'accepted' || status === 'tentative' || status === 'needsAction' || status === 'declined') {
    return status;
  }
  return 'needsAction';
}

export function extractJoinUrl(raw: RawEvent): string | null {
  if (raw.hangoutLink) return raw.hangoutLink;
  const video = raw.conferenceData?.entryPoints?.find((ep) => ep.entryPointType === 'video');
  if (video?.uri) return video.uri;
  const loc = typeof raw.location === 'string' ? raw.location.match(JOIN_URL_REGEX) : null;
  if (loc) return loc[0];
  const desc = typeof raw.description === 'string' ? raw.description.match(JOIN_URL_REGEX) : null;
  return desc ? desc[0] : null;
}

/** Parses a raw Google Calendar event. Returns null for cancelled/malformed input; never throws. */
export function parseEvent(raw: RawEvent, ctx: ParseContext): CalendarEvent | null {
  try {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || raw.id === '') return null;
    if (raw.status === 'cancelled') return null;
    const start = raw.start ?? {};
    const end = raw.end ?? {};
    return {
      id: raw.id,
      sourceId: ctx.sourceId,
      calendarId: ctx.calendarId,
      summary: raw.summary ?? '',
      start: { dateTime: start.dateTime, date: start.date, timeZone: start.timeZone },
      end: { dateTime: end.dateTime, date: end.date, timeZone: end.timeZone },
      isAllDay: Boolean(start.date && !start.dateTime),
      selfResponseStatus: deriveSelfResponseStatus(raw),
      joinUrl: extractJoinUrl(raw),
      organizer: {
        displayName: raw.organizer?.displayName,
        email: raw.organizer?.email,
        self: Boolean(raw.organizer?.self),
      },
      htmlLink: raw.htmlLink ?? '',
    };
  } catch {
    return null;
  }
}

export function parseEvents(items: RawEvent[], ctx: ParseContext): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    const e = parseEvent(item, ctx);
    if (e) out.push(e);
  }
  return out;
}
