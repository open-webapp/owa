import { describe, it, expect } from 'vitest';
import { parseEvent } from '../events';

const ctx = { sourceId: 'src1', calendarId: 'primary' };
const base = {
  id: 'g1',
  summary: 'Standup',
  htmlLink: 'https://calendar.google.com/event?eid=g1',
  start: { dateTime: '2026-09-27T10:00:00Z' },
  end: { dateTime: '2026-09-27T11:00:00Z' },
};

describe('parseEvent details fields', () => {
  it('maps location, description, attendees', () => {
    const e = parseEvent(
      {
        ...base,
        location: 'Room 1',
        description: 'Agenda',
        attendees: [
          { email: 'a@x.com', displayName: 'A', responseStatus: 'accepted', self: true },
          { email: 'b@x.com', responseStatus: 'declined', organizer: true },
        ],
      } as never,
      ctx,
    );
    expect(e).toEqual({
      id: 'g1', sourceId: 'src1', calendarId: 'primary', summary: 'Standup',
      start: { dateTime: '2026-09-27T10:00:00Z', date: undefined, timeZone: undefined },
      end: { dateTime: '2026-09-27T11:00:00Z', date: undefined, timeZone: undefined },
      isAllDay: false, selfResponseStatus: 'accepted', joinUrl: null,
      organizer: { displayName: undefined, email: undefined, self: false },
      htmlLink: 'https://calendar.google.com/event?eid=g1',
      location: 'Room 1', description: 'Agenda',
      attendees: [
        { email: 'a@x.com', displayName: 'A', responseStatus: 'accepted', self: true, organizer: undefined },
        { email: 'b@x.com', displayName: undefined, responseStatus: 'declined', self: undefined, organizer: true },
      ],
    });
  });

  it('leaves fields undefined when absent; rsvp/join unchanged', () => {
    const e = parseEvent(base as never, ctx)!;
    expect(e.location).toBeUndefined();
    expect(e.description).toBeUndefined();
    expect(e.attendees).toBeUndefined();
    expect(e.selfResponseStatus).toBe('accepted');
    expect(e.joinUrl).toBeNull();
  });

  it("defaults missing attendee responseStatus to 'needsAction'", () => {
    const e = parseEvent({ ...base, attendees: [{ email: 'a@x.com' }] } as never, ctx)!;
    expect(e.attendees![0].responseStatus).toBe('needsAction');
  });

  it('ignores malformed values without throwing', () => {
    const e = parseEvent({ ...base, location: 5, description: {}, attendees: 'nope' } as never, ctx)!;
    expect(e.location).toBeUndefined();
    expect(e.description).toBeUndefined();
    expect(e.attendees).toBeUndefined();
  });
});
