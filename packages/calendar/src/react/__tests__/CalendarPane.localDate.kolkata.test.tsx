process.env.TZ = 'Asia/Kolkata';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import { makeEvent, baseProps } from './helpers.js';

const ev = (id: string, day: string) =>
  makeEvent({ id, start: { dateTime: `${day}T12:00:00Z` }, end: { dateTime: `${day}T13:00:00Z` } });

describe('CalendarPane local "today" in Asia/Kolkata', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-27T00:30:00+05:30')); // 19:00Z Oct 26
  });
  afterEach(() => vi.useRealTimers());

  it('TZ is actually honored', () => {
    expect(new Date().getTimezoneOffset()).toBe(-330);
    expect(new Date().getDate()).toBe(27);
  });

  it('today is Oct 27 and tomorrow Oct 28 (addDaysToIso stays UTC-safe)', () => {
    const { container } = render(<CalendarPane {...baseProps({ events: [ev('a', '2026-10-27'), ev('b', '2026-10-28')] })} />);
    const h = Array.from(container.querySelectorAll('.calendar-day-header')).map((x) => x.textContent);
    expect(h).toEqual(['Today · Oct 27', 'Tomorrow · Oct 28']);
  });
});
