import { describe, it, expect } from 'vitest';
import { sortInvitees, summarizeInvitees } from '../inviteeUtils.js';
import type { CalendarEventAttendee } from '../../core/types.js';

const A = (email: string, responseStatus: any, extra: Partial<CalendarEventAttendee> = {}): CalendarEventAttendee => ({
  email, responseStatus, ...extra,
});

describe('inviteeUtils', () => {
  it('sorts organizer, self, accepted, tentative, needsAction, declined and summarizes', () => {
    const list = [
      A('d@x.com', 'declined'),
      A('n@x.com', 'needsAction'),
      A('t@x.com', 'tentative'),
      A('y@x.com', 'accepted'),
      A('me@x.com', 'accepted', { self: true }),
      A('o@x.com', 'accepted', { organizer: true }),
    ];
    expect(sortInvitees(list).map((a) => a.email)).toEqual([
      'o@x.com', 'me@x.com', 'y@x.com', 't@x.com', 'n@x.com', 'd@x.com',
    ]);
    expect(summarizeInvitees(list)).toBe('3 yes · 1 maybe · 1 awaiting · 1 no');
    expect(summarizeInvitees([A('a@x.com', 'accepted'), A('b@x.com', 'accepted'), A('t@x.com', 'tentative'), A('n@x.com', 'needsAction')])).toBe('2 yes · 1 maybe · 1 awaiting');
  });

  it('organizer who is self is one entry first; name sort case-insensitive; zero buckets omitted', () => {
    const list = [
      A('z@x.com', 'accepted', { displayName: 'bob' }),
      A('a@x.com', 'accepted', { displayName: 'Alice' }),
      A('me@x.com', 'accepted', { self: true, organizer: true }),
    ];
    const out = sortInvitees(list);
    expect(out.map((a) => a.email)).toEqual(['me@x.com', 'a@x.com', 'z@x.com']);
    expect(summarizeInvitees([A('d@x.com', 'declined')])).toBe('1 no');
  });

  it('unknown status counts as awaiting; empty summary is empty', () => {
    expect(summarizeInvitees([A('a@x.com', undefined), A('b@x.com', 'weird')])).toBe('2 awaiting');
    expect(summarizeInvitees([])).toBe('');
  });

  it('does not mutate input', () => {
    const list = [A('b@x.com', 'declined'), A('a@x.com', 'accepted')];
    const before = JSON.stringify(list);
    sortInvitees(list);
    expect(JSON.stringify(list)).toBe(before);
  });
});
