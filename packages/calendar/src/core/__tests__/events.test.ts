import { describe, it, expect } from 'vitest';
import type { CalendarEvent, CalendarInfo } from '../types';
import {
  isAllDay,
  getRollingWindow,
  filterByRsvp,
  getOrganizerLabel,
  groupByDay,
  formatDayHeader,
  isEventCurrent,
  findNextUpcomingEvent,
  reconcileSelectedCalendarIds,
  filterCalendarsByName,
  getCalendarEventKey,
  summarizeCalendarSelection,
  parseEvent,
  parseEvents,
} from '../events';

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    sourceId: 'src1',
    summary: 'Test event',
    start: { dateTime: '2026-09-27T10:00:00Z' },
    end: { dateTime: '2026-09-27T11:00:00Z' },
    isAllDay: false,
    selfResponseStatus: 'accepted',
    joinUrl: null,
    organizer: { self: false },
    htmlLink: 'https://calendar.google.com/event?id=evt-1',
    ...overrides,
  };
}

function makeCalendar(overrides: Partial<CalendarInfo> = {}): CalendarInfo {
  return {
    id: 'primary',
    summary: 'Primary calendar',
    primary: true,
    accessRole: 'owner',
    ...overrides,
  };
}

describe('calendar selection helpers', () => {
  const calendars = [
    makeCalendar(),
    makeCalendar({ id: 'work', summary: 'Work' }),
    makeCalendar({ id: 'family', summary: 'Family' }),
  ];

  it('reconciles a missing stored selection to the primary calendar', () => {
    expect(reconcileSelectedCalendarIds(null, calendars)).toEqual(['primary']);
  });

  it('drops stale calendar ids and keeps valid stored ids', () => {
    expect(reconcileSelectedCalendarIds(['work', 'removed'], calendars)).toEqual(['work']);
  });

  it('falls back to the primary calendar when all stored ids are stale', () => {
    expect(reconcileSelectedCalendarIds(['removed'], calendars)).toEqual(['primary']);
  });

  it('falls back to the first calendar without a primary and returns no ids for an empty list', () => {
    const noPrimary = [makeCalendar({ id: 'first', primary: false })];
    expect(reconcileSelectedCalendarIds(null, noPrimary)).toEqual(['first']);
    expect(reconcileSelectedCalendarIds(null, [])).toEqual([]);
  });

  it('filters calendars by case-insensitive summary substring', () => {
    expect(filterCalendarsByName(calendars, 'ORk')).toEqual([calendars[1]]);
  });

  it('returns all calendars for an empty name query and none for no match', () => {
    expect(filterCalendarsByName(calendars, '')).toEqual(calendars);
    expect(filterCalendarsByName(calendars, 'missing')).toEqual([]);
  });

  it('creates distinct calendar event keys for duplicate event ids', () => {
    const event = makeEvent({ id: 'ev1', calendarId: 'calA', sourceId: 'src1' });
    const sameIdOtherCalendar = makeEvent({ id: 'ev1', calendarId: 'calB', sourceId: 'src1' });
    expect(getCalendarEventKey(event)).toBe('src1:calA:ev1');
    expect(getCalendarEventKey(event)).not.toBe(getCalendarEventKey(sameIdOtherCalendar));
  });

  it('creates distinct calendar event keys for the same calendar and event id across sources', () => {
    const a = makeEvent({ id: 'ev1', calendarId: 'calA', sourceId: 'src1' });
    const b = makeEvent({ id: 'ev1', calendarId: 'calA', sourceId: 'src2' });
    expect(getCalendarEventKey(a)).toBe('src1:calA:ev1');
    expect(getCalendarEventKey(b)).toBe('src2:calA:ev1');
  });

  it('summarizes one selected calendar by name and multiple by count', () => {
    expect(summarizeCalendarSelection(['work'], calendars)).toBe('Work');
    expect(summarizeCalendarSelection(['primary', 'work', 'family'], calendars)).toBe('3 calendars');
  });
});

describe('isAllDay', () => {
  it('returns true when event.isAllDay is true', () => {
    expect(isAllDay(makeEvent({ isAllDay: true }))).toBe(true);
  });

  it('returns false when event.isAllDay is false', () => {
    expect(isAllDay(makeEvent({ isAllDay: false }))).toBe(false);
  });
});

describe('findNextUpcomingEvent', () => {
  const now = new Date('2026-09-27T10:00:00Z');

  it('returns null for empty list', () => {
    expect(findNextUpcomingEvent([], now)).toBeNull();
  });

  it('returns the single future timed event', () => {
    const event = makeEvent({
      id: 'evt-1',
      start: { dateTime: '2026-09-27T11:00:00Z' },
    });
    expect(findNextUpcomingEvent([event], now)).toBe(event);
  });

  it('returns the earliest future event by start time, not array order', () => {
    const later = makeEvent({ id: 'evt-later', start: { dateTime: '2026-09-27T15:00:00Z' } });
    const earlier = makeEvent({ id: 'evt-earlier', start: { dateTime: '2026-09-27T12:00:00Z' } });
    expect(findNextUpcomingEvent([later, earlier], now)).toBe(earlier);
  });

  it('excludes an all-day event even if it would otherwise be earliest', () => {
    const allDay = makeEvent({ id: 'evt-allday', isAllDay: true, start: { date: '2026-09-27' }, end: { date: '2026-09-28' } });
    const timed = makeEvent({ id: 'evt-timed', start: { dateTime: '2026-09-27T12:00:00Z' } });
    expect(findNextUpcomingEvent([allDay, timed], now)).toBe(timed);
  });

  it('excludes an event whose startMs equals now', () => {
    const event = makeEvent({ id: 'evt-boundary', start: { dateTime: now.toISOString() } });
    expect(findNextUpcomingEvent([event], now)).toBeNull();
  });

  it('excludes an event with invalid/missing start.dateTime', () => {
    const missing = makeEvent({ id: 'evt-missing', start: {} });
    const invalid = makeEvent({ id: 'evt-invalid', start: { dateTime: 'not-a-date' } });
    expect(findNextUpcomingEvent([missing, invalid], now)).toBeNull();
  });

  it('excludes a past event', () => {
    const event = makeEvent({ id: 'evt-past', start: { dateTime: '2026-09-27T09:00:00Z' } });
    expect(findNextUpcomingEvent([event], now)).toBeNull();
  });

  it('on a tie in start time, returns the first array entry', () => {
    const first = makeEvent({ id: 'evt-first', start: { dateTime: '2026-09-27T12:00:00Z' } });
    const second = makeEvent({ id: 'evt-second', start: { dateTime: '2026-09-27T12:00:00Z' } });
    expect(findNextUpcomingEvent([first, second], now)).toBe(first);
  });
});

describe('isEventCurrent', () => {
  it('returns true during the event', () => {
    const event = makeEvent({
      start: { dateTime: '2026-09-27T10:00:00Z' },
      end: { dateTime: '2026-09-27T11:00:00Z' },
    });
    expect(isEventCurrent(event, new Date('2026-09-27T10:30:00Z'))).toBe(true);
  });

  it('returns true exactly at start', () => {
    const event = makeEvent({
      start: { dateTime: '2026-09-27T10:00:00Z' },
      end: { dateTime: '2026-09-27T11:00:00Z' },
    });
    expect(isEventCurrent(event, new Date('2026-09-27T10:00:00Z'))).toBe(true);
  });

  it('returns false exactly at end', () => {
    const event = makeEvent({
      start: { dateTime: '2026-09-27T10:00:00Z' },
      end: { dateTime: '2026-09-27T11:00:00Z' },
    });
    expect(isEventCurrent(event, new Date('2026-09-27T11:00:00Z'))).toBe(false);
  });

  it('returns false before the event', () => {
    const event = makeEvent({
      start: { dateTime: '2026-09-27T10:00:00Z' },
      end: { dateTime: '2026-09-27T11:00:00Z' },
    });
    expect(isEventCurrent(event, new Date('2026-09-27T09:59:59Z'))).toBe(false);
  });

  it('returns false after the event', () => {
    const event = makeEvent({
      start: { dateTime: '2026-09-27T10:00:00Z' },
      end: { dateTime: '2026-09-27T11:00:00Z' },
    });
    expect(isEventCurrent(event, new Date('2026-09-27T11:00:01Z'))).toBe(false);
  });

  it('returns false for all-day events', () => {
    const event = makeEvent({
      isAllDay: true,
      start: { date: '2026-09-27' },
      end: { date: '2026-09-28' },
    });
    expect(isEventCurrent(event, new Date('2026-09-27T10:30:00Z'))).toBe(false);
  });

  it('returns false when start.dateTime is missing', () => {
    const event = makeEvent({
      start: {},
      end: { dateTime: '2026-09-27T11:00:00Z' },
    });
    expect(isEventCurrent(event, new Date('2026-09-27T10:30:00Z'))).toBe(false);
  });

  it('returns false when end.dateTime is missing', () => {
    const event = makeEvent({
      start: { dateTime: '2026-09-27T10:00:00Z' },
      end: {},
    });
    expect(isEventCurrent(event, new Date('2026-09-27T10:30:00Z'))).toBe(false);
  });

  it('returns false when start.dateTime is invalid', () => {
    const event = makeEvent({
      start: { dateTime: 'not-a-date' },
      end: { dateTime: '2026-09-27T11:00:00Z' },
    });
    expect(isEventCurrent(event, new Date('2026-09-27T10:30:00Z'))).toBe(false);
  });

  it('returns false when end.dateTime is invalid', () => {
    const event = makeEvent({
      start: { dateTime: '2026-09-27T10:00:00Z' },
      end: { dateTime: 'not-a-date' },
    });
    expect(isEventCurrent(event, new Date('2026-09-27T10:30:00Z'))).toBe(false);
  });

  it('compares offset-bearing timestamps as instants', () => {
    const event = makeEvent({
      start: { dateTime: '2026-09-27T03:00:00-07:00' },
      end: { dateTime: '2026-09-27T04:00:00-07:00' },
    });
    // 2026-09-27T10:30:00Z == 03:30 PDT, inside [10:00Z, 11:00Z)
    expect(isEventCurrent(event, new Date('2026-09-27T10:30:00Z'))).toBe(true);
  });
});

describe('getRollingWindow', () => {
  it('returns now-30d to now+30d as full RFC3339 timestamps', () => {
    expect(getRollingWindow(new Date('2026-09-26T00:00:00Z'))).toEqual({
      start: '2026-08-27T00:00:00.000Z',
      end: '2026-10-26T00:00:00.000Z',
    });
  });

  it('never returns a bare YYYY-MM-DD date (Google Calendar rejects those as timeMin/timeMax)', () => {
    const { start, end } = getRollingWindow(new Date('2026-09-26T00:00:00Z'));
    const bareDatePattern = /^\d{4}-\d{2}-\d{2}$/;
    expect(start).not.toMatch(bareDatePattern);
    expect(end).not.toMatch(bareDatePattern);
  });
});

describe('filterByRsvp', () => {
  const events = [
    makeEvent({ id: 'accepted-1', selfResponseStatus: 'accepted' }),
    makeEvent({ id: 'tentative-1', selfResponseStatus: 'tentative' }),
    makeEvent({ id: 'needsAction-1', selfResponseStatus: 'needsAction' }),
    makeEvent({ id: 'declined-1', selfResponseStatus: 'declined' }),
  ];

  it('keeps only accepted when selected is {accepted}', () => {
    const result = filterByRsvp(events, new Set(['accepted']));
    expect(result.map((e) => e.id)).toEqual(['accepted-1']);
  });

  it('returns declined events when declined is selected (no longer hard-excluded)', () => {
    const result = filterByRsvp(events, new Set(['declined']));
    expect(result.map((e) => e.id)).toEqual(['declined-1']);
  });

  it('keeps accepted and declined when both are selected', () => {
    const result = filterByRsvp(events, new Set(['accepted', 'declined']));
    expect(result.map((e) => e.id).sort()).toEqual(['accepted-1', 'declined-1'].sort());
  });

  it('returns [] when selection is empty', () => {
    expect(filterByRsvp(events, new Set())).toEqual([]);
  });

  it('returns every event when all statuses are selected', () => {
    const result = filterByRsvp(events, new Set(['accepted', 'tentative', 'needsAction', 'declined']));
    expect(result.map((e) => e.id).sort()).toEqual(
      ['accepted-1', 'tentative-1', 'needsAction-1', 'declined-1'].sort()
    );
  });

  it('"tentative" keeps only tentative', () => {
    const result = filterByRsvp(events, new Set(['tentative']));
    expect(result.map((e) => e.id)).toEqual(['tentative-1']);
  });

  it('"needsAction" keeps only needsAction', () => {
    const result = filterByRsvp(events, new Set(['needsAction']));
    expect(result.map((e) => e.id)).toEqual(['needsAction-1']);
  });
});

describe('getOrganizerLabel', () => {
  it('prefers displayName when present', () => {
    const event = makeEvent({ organizer: { displayName: 'Jane', email: 'jane@x.com', self: false } });
    expect(getOrganizerLabel(event)).toBe('Jane');
  });

  it('falls back to email when no displayName', () => {
    const event = makeEvent({ organizer: { email: 'j@x.com', self: false } });
    expect(getOrganizerLabel(event)).toBe('j@x.com');
  });

  it('returns the email, not "You", when self is true but email is present (no displayName)', () => {
    const event = makeEvent({ organizer: { email: 'me@x.com', self: true } });
    expect(getOrganizerLabel(event)).toBe('me@x.com');
  });

  it('returns "You" only when self is true and both displayName/email are absent', () => {
    const event = makeEvent({ organizer: { self: true } });
    expect(getOrganizerLabel(event)).toBe('You');
  });
});

describe('groupByDay', () => {
  it('groups across days, all-day first within a day, ascending day order', () => {
    const events = [
      makeEvent({ id: 'timed-day1', start: { dateTime: '2026-09-27T14:00:00Z' }, isAllDay: false }),
      makeEvent({ id: 'allday-day1', start: { date: '2026-09-27' }, isAllDay: true }),
      makeEvent({ id: 'timed-day2', start: { dateTime: '2026-09-28T09:00:00Z' }, isAllDay: false }),
    ];
    const groups = groupByDay(events);
    expect(groups.map((g) => g.dateKey)).toEqual(['2026-09-27', '2026-09-28']);
    expect(groups[0].events.map((e) => e.id)).toEqual(['allday-day1', 'timed-day1']);
    expect(groups[1].events.map((e) => e.id)).toEqual(['timed-day2']);
  });

  it('returns [] for empty input', () => {
    expect(groupByDay([])).toEqual([]);
  });

  it('synthesizes an empty group for todayIso when it has no events', () => {
    expect(groupByDay([], '2026-09-26')).toEqual([{ dateKey: '2026-09-26', events: [] }]);
  });

  it('inserts the synthesized today group in correct sorted order among real event days', () => {
    const events = [
      makeEvent({ id: 'day-27', start: { dateTime: '2026-09-27T14:00:00Z' }, isAllDay: false }),
      makeEvent({ id: 'day-29', start: { dateTime: '2026-09-29T09:00:00Z' }, isAllDay: false }),
    ];
    const groups = groupByDay(events, '2026-09-28');
    expect(groups.map((g) => g.dateKey)).toEqual(['2026-09-27', '2026-09-28', '2026-09-29']);
    expect(groups[1].events).toEqual([]);
  });

  it('does not duplicate or alter a day that already has events when it matches todayIso', () => {
    const events = [
      makeEvent({ id: 'timed-day1', start: { dateTime: '2026-09-27T14:00:00Z' }, isAllDay: false }),
      makeEvent({ id: 'allday-day1', start: { date: '2026-09-27' }, isAllDay: true }),
    ];
    const groups = groupByDay(events, '2026-09-27');
    expect(groups.length).toBe(1);
    expect(groups[0].events.map((e) => e.id)).toEqual(['allday-day1', 'timed-day1']);
  });

  it('omitting todayIso preserves old no-synthesis behavior', () => {
    const events = [
      makeEvent({ id: 'timed-day1', start: { dateTime: '2026-09-27T14:00:00Z' }, isAllDay: false }),
      makeEvent({ id: 'allday-day1', start: { date: '2026-09-27' }, isAllDay: true }),
      makeEvent({ id: 'timed-day2', start: { dateTime: '2026-09-28T09:00:00Z' }, isAllDay: false }),
    ];
    const groups = groupByDay(events);
    expect(groups.map((g) => g.dateKey)).toEqual(['2026-09-27', '2026-09-28']);
    expect(groups[0].events.map((e) => e.id)).toEqual(['allday-day1', 'timed-day1']);
    expect(groups[1].events.map((e) => e.id)).toEqual(['timed-day2']);
  });
});

describe('formatDayHeader', () => {
  const today = '2026-09-26';

  it('formats today', () => {
    expect(formatDayHeader('2026-09-26', today)).toBe('Today · Sep 26');
  });

  it('formats tomorrow', () => {
    expect(formatDayHeader('2026-09-27', today)).toBe('Tomorrow · Sep 27');
  });

  it('formats a plain future date without year', () => {
    expect(formatDayHeader('2026-10-01', today)).toBe('Oct 1');
  });

  it('includes year when the event year differs from today\'s year', () => {
    expect(formatDayHeader('2027-01-05', today)).toBe('Jan 5, 2027');
  });
});

describe('parseEvent', () => {
  const ctx = { sourceId: 'src1', calendarId: 'primary' };
  const raw = (o: Record<string, unknown> = {}) => ({
    id: 'g1',
    summary: 'Standup',
    htmlLink: 'https://calendar.google.com/event?eid=g1',
    start: { dateTime: '2026-09-27T10:00:00Z' },
    end: { dateTime: '2026-09-27T11:00:00Z' },
    ...o,
  });

  it('parses a timed event with source and calendar identity', () => {
    const e = parseEvent(raw(), ctx)!;
    expect(e.id).toBe('g1');
    expect(e.sourceId).toBe('src1');
    expect(e.calendarId).toBe('primary');
    expect(e.summary).toBe('Standup');
    expect(e.isAllDay).toBe(false);
    expect(e.start.dateTime).toBe('2026-09-27T10:00:00Z');
  });

  it('parses an all-day event', () => {
    const e = parseEvent(raw({ start: { date: '2026-09-27' }, end: { date: '2026-09-28' } }), ctx)!;
    expect(e.isAllDay).toBe(true);
    expect(e.start.dateTime).toBeUndefined();
    expect(e.start.date).toBe('2026-09-27');
  });

  it('derives RSVP from the self attendee', () => {
    const e = parseEvent(raw({ attendees: [{ self: true, responseStatus: 'tentative' }] }), ctx)!;
    expect(e.selfResponseStatus).toBe('tentative');
  });

  it('defaults RSVP to accepted without attendees', () => {
    expect(parseEvent(raw(), ctx)!.selfResponseStatus).toBe('accepted');
  });

  it('extracts a join link from hangoutLink', () => {
    expect(parseEvent(raw({ hangoutLink: 'https://meet.google.com/abc' }), ctx)!.joinUrl).toBe('https://meet.google.com/abc');
  });

  it('has a null join link when none exists', () => {
    expect(parseEvent(raw(), ctx)!.joinUrl).toBeNull();
  });

  it('parses the organizer', () => {
    const e = parseEvent(raw({ organizer: { displayName: 'Jane', email: 'j@x.com', self: true } }), ctx)!;
    expect(e.organizer).toEqual({ displayName: 'Jane', email: 'j@x.com', self: true });
  });

  it('keeps a declined event with declined status', () => {
    const e = parseEvent(raw({ attendees: [{ self: true, responseStatus: 'declined' }] }), ctx)!;
    expect(e.selfResponseStatus).toBe('declined');
  });

  it('returns null for a cancelled event', () => {
    expect(parseEvent(raw({ status: 'cancelled' }), ctx)).toBeNull();
  });

  it('uses an empty summary when the title is missing', () => {
    const { summary, ...noTitle } = raw();
    expect(parseEvent(noTitle, ctx)!.summary).toBe('');
  });

  it('returns null without throwing for malformed input', () => {
    expect(() => parseEvent(null as never, ctx)).not.toThrow();
    expect(parseEvent(null as never, ctx)).toBeNull();
    expect(parseEvent({} as never, ctx)).toBeNull();
    expect(parseEvent({ id: 5 } as never, ctx)).toBeNull();
  });
});

describe('parseEvents', () => {
  const ctx = { sourceId: 'src1', calendarId: 'primary' };
  const good = (id: string) => ({
    id,
    htmlLink: 'https://x',
    start: { dateTime: '2026-09-27T10:00:00Z' },
    end: { dateTime: '2026-09-27T11:00:00Z' },
  });

  it('skips malformed and cancelled items and keeps the rest, without throwing', () => {
    const items = [good('a'), null, 'junk', {}, { ...good('c'), status: 'cancelled' }, good('b')];
    let result: CalendarEvent[] = [];
    expect(() => {
      result = parseEvents(items as never, ctx);
    }).not.toThrow();
    expect(result.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('returns [] for an empty list', () => {
    expect(parseEvents([], ctx)).toEqual([]);
  });
});
