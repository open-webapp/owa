import type { CalendarInfo } from './types.js';

const BASE = 'https://www.googleapis.com/calendar/v3';

export class CalendarFetchError extends Error {
  constructor(
    public kind: 'network' | 'auth' | 'scope' | 'gone' | 'http',
    public status = 0,
  ) {
    super(`calendar fetch failed: ${kind} ${status}`);
  }
}

/** Thrown by a host's getToken when a token refresh was deferred (e.g. app inactive). Aborts a pass quietly. */
export class RefreshDeferredError extends Error {
  readonly deferred = true;
  constructor(message = 'token refresh deferred') {
    super(message);
    this.name = 'RefreshDeferredError';
  }
}

export function isRefreshDeferredError(e: unknown): boolean {
  if (e instanceof RefreshDeferredError) return true;
  const x = e as { deferred?: unknown; name?: unknown } | null | undefined;
  return !!x && (x.deferred === true || x.name === 'RefreshDeferredError');
}

async function request(url: string, token: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new CalendarFetchError('network');
  }
  if (res.ok) {
    try {
      return await res.json();
    } catch {
      throw new CalendarFetchError('http', res.status);
    }
  }
  if (res.status === 410) throw new CalendarFetchError('gone', 410);
  if (res.status === 401) throw new CalendarFetchError('auth', 401);
  if (res.status === 403) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    const insufficient = JSON.stringify(body ?? {}).includes('insufficientPermissions');
    throw new CalendarFetchError(insufficient ? 'scope' : 'http', 403);
  }
  throw new CalendarFetchError('http', res.status);
}

export async function fetchCalendarList(token: string): Promise<CalendarInfo[]> {
  const out: CalendarInfo[] = [];
  let pageToken: string | undefined;
  do {
    const u = new URL(`${BASE}/users/me/calendarList`);
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const body = await request(u.toString(), token);
    for (const c of body.items ?? []) {
      out.push({
        id: c.id,
        summary: c.summaryOverride ?? c.summary ?? c.id,
        backgroundColor: c.backgroundColor,
        foregroundColor: c.foregroundColor,
        primary: Boolean(c.primary),
        accessRole: c.accessRole ?? '',
        selected: c.selected,
      });
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

export interface EventsPage {
  items: any[];
  nextSyncToken?: string;
}

const noMillis = (iso: string) => iso.replace(/\.\d{3}Z$/, 'Z');

/** Fetches all pages of events. With syncToken, no time bounds are sent (the API forbids them). */
export async function fetchEvents(
  token: string,
  calendarId: string,
  opts: { syncToken?: string; timeMin?: string; timeMax?: string },
): Promise<EventsPage> {
  const items: any[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const u = new URL(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
    u.searchParams.set('maxResults', '250');
    if (opts.syncToken) {
      u.searchParams.set('syncToken', opts.syncToken);
    } else {
      u.searchParams.set('singleEvents', 'true');
      if (opts.timeMin) u.searchParams.set('timeMin', noMillis(opts.timeMin));
      if (opts.timeMax) u.searchParams.set('timeMax', noMillis(opts.timeMax));
    }
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const body = await request(u.toString(), token);
    items.push(...(body.items ?? []));
    pageToken = body.nextPageToken;
    nextSyncToken = body.nextSyncToken ?? nextSyncToken;
  } while (pageToken);
  return { items, nextSyncToken };
}
