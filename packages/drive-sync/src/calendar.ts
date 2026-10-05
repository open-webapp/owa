import type { Logger } from './logger.js';
import type { CalendarEvent, CalendarInfo, ListEventsOptions } from './types.js';
import { driveFetch } from './http.js';

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

interface RawGoogleCalendarEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface RawGoogleCalendarEvent {
  id: string;
  summary?: string;
  start?: RawGoogleCalendarEventDateTime;
  end?: RawGoogleCalendarEventDateTime;
  attendees?: { self?: boolean; responseStatus?: string }[];
  organizer?: { displayName?: string; email?: string; self?: boolean };
  htmlLink: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  location?: string;
  description?: string;
}

/**
 * Best-effort scan for a meeting link in free-text fields. May false-negative
 * on oddly formatted text — acceptable, since `hangoutLink`/`conferenceData`
 * (checked first, in `extractJoinUrl`) cover the common case.
 */
const JOIN_URL_REGEX =
  /https?:\/\/[^\s<>"']*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com)[^\s<>"']*/i;

export function deriveSelfResponseStatus(
  raw: RawGoogleCalendarEvent
): CalendarEvent['selfResponseStatus'] {
  if (!Array.isArray(raw.attendees)) {
    return 'accepted';
  }
  const self = raw.attendees.find((a) => a.self === true);
  const status = self?.responseStatus;
  if (status === 'accepted' || status === 'tentative' || status === 'needsAction' || status === 'declined') {
    return status;
  }
  return 'needsAction';
}

export function extractJoinUrl(raw: RawGoogleCalendarEvent): string | null {
  if (raw.hangoutLink) {
    return raw.hangoutLink;
  }

  const videoEntryPoint = raw.conferenceData?.entryPoints?.find(
    (ep) => ep.entryPointType === 'video'
  );
  if (videoEntryPoint?.uri) {
    return videoEntryPoint.uri;
  }

  const locationMatch = raw.location?.match(JOIN_URL_REGEX);
  if (locationMatch) {
    return locationMatch[0];
  }

  const descriptionMatch = raw.description?.match(JOIN_URL_REGEX);
  if (descriptionMatch) {
    return descriptionMatch[0];
  }

  return null;
}

export function mapEvent(raw: RawGoogleCalendarEvent, calendarId: string = 'primary'): CalendarEvent {
  const start = raw.start ?? {};
  const end = raw.end ?? {};
  return {
    id: raw.id,
    calendarId,
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
    htmlLink: raw.htmlLink,
  };
}

export interface ListEventsCallOptions extends ListEventsOptions {
  appId: string;
  projectId: string;
  clientId: string;
  interactive?: boolean;
  logger?: Logger;
  fetchEmail?: (accessToken: string) => Promise<string>;
  tokenExchangeUrl?: string;
  requiredScopes: string[];
}

/**
 * Read-only listing of the connected account's primary calendar events in
 * `[timeMin, timeMax)`. Reuses `driveFetch` (generic enough for any Google
 * API host, not Drive-specific — it only hardcodes Drive-specific behavior
 * in its error-message text, not its request path) for the same
 * token-acquisition / retry / 401-recovery plumbing `files.ts` uses.
 *
 * Non-interactive by default (like `files.*`, NOT `getAccessToken`'s
 * interactive-by-default exception) so a background poll never pops a
 * consent screen.
 */
export async function listEvents(opts: ListEventsCallOptions): Promise<CalendarEvent[]> {
  const id = opts.calendarId ?? 'primary';
  const url = `${CALENDAR_BASE}/calendars/${encodeURIComponent(id)}/events?timeMin=${encodeURIComponent(
    opts.timeMin
  )}&timeMax=${encodeURIComponent(opts.timeMax)}&singleEvents=true&orderBy=startTime`;

  const res = await driveFetch({
    appId: opts.appId,
    projectId: opts.projectId,
    clientId: opts.clientId,
    url,
    method: 'GET',
    interactive: opts.interactive ?? false,
    requiredScopes: opts.requiredScopes,
    logger: opts.logger,
    fetchEmail: opts.fetchEmail,
    tokenExchangeUrl: opts.tokenExchangeUrl,
  });
  const json = (await res.json()) as { items?: RawGoogleCalendarEvent[] };
  return (json.items ?? []).map((e) => mapEvent(e, id));
}

interface RawGoogleCalendarListEntry {
  id: string;
  summary?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  primary?: boolean;
  accessRole?: string;
  selected?: boolean;
}

export function mapCalendar(raw: RawGoogleCalendarListEntry): CalendarInfo {
  const out: CalendarInfo = {
    id: raw.id,
    summary: raw.summary ?? '',
    primary: Boolean(raw.primary),
    accessRole: raw.accessRole ?? 'reader',
  };
  if (raw.backgroundColor !== undefined) out.backgroundColor = raw.backgroundColor;
  if (raw.foregroundColor !== undefined) out.foregroundColor = raw.foregroundColor;
  if (raw.selected !== undefined) out.selected = raw.selected;
  return out;
}

export type ListCalendarsCallOptions = Omit<ListEventsCallOptions, 'timeMin' | 'timeMax' | 'calendarId'>;

/**
 * Lists the account's calendar list, following `nextPageToken`. Same
 * non-interactive-by-default plumbing as `listEvents`. Any failing page
 * rejects the whole call (no partial results).
 */
export async function listCalendars(opts: ListCalendarsCallOptions): Promise<CalendarInfo[]> {
  const base = `${CALENDAR_BASE}/users/me/calendarList?maxResults=250`;
  const all: RawGoogleCalendarListEntry[] = [];
  let pageToken: string | undefined;
  do {
    const url = pageToken ? `${base}&pageToken=${encodeURIComponent(pageToken)}` : base;
    const res = await driveFetch({
      appId: opts.appId,
      projectId: opts.projectId,
      clientId: opts.clientId,
      url,
      method: 'GET',
      interactive: opts.interactive ?? false,
      requiredScopes: opts.requiredScopes,
      logger: opts.logger,
      fetchEmail: opts.fetchEmail,
      tokenExchangeUrl: opts.tokenExchangeUrl,
    });
    const json = (await res.json()) as { items?: RawGoogleCalendarListEntry[]; nextPageToken?: string };
    all.push(...(json.items ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return all.map(mapCalendar);
}
