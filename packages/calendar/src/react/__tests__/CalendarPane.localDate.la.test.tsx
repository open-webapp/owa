// TZ must be set before any Date is created; Node re-reads process.env.TZ at runtime.
process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import { makeEvent, baseProps } from './helpers.js';

const ev = (id: string, day: string) =>
  makeEvent({ id, start: { dateTime: `${day}T12:00:00Z` }, end: { dateTime: `${day}T13:00:00Z` } });
const headers = (c: HTMLElement) => Array.from(c.querySelectorAll('.calendar-day-header')).map((h) => h.textContent);

describe('CalendarPane local "today" in America/Los_Angeles', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T20:00:00-07:00')); // 03:00Z Oct 27
  });
  afterEach(() => vi.useRealTimers());

  it('TZ is actually honored', () => {
    expect(new Date('2026-10-26T20:00:00-07:00').getTimezoneOffset()).toBe(420);
    expect(new Date().getDate()).toBe(26);
  });

  it('labels the local date as Today and the next as Tomorrow', () => {
    const { container } = render(<CalendarPane {...baseProps({ events: [ev('a', '2026-10-26'), ev('b', '2026-10-27')] })} />);
    expect(headers(container)).toEqual(['Today · Oct 26', 'Tomorrow · Oct 27']);
  });

  it('scroll-to-today targets the Oct 26 header', () => {
    const spy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    try {
      const { container, getByRole } = render(
        <CalendarPane {...baseProps({ events: [] })} />,
      );
      spy.mockClear();
      fireEvent.click(getByRole('button', { name: /today/i }));
      expect(spy).toHaveBeenCalled();
      const target = spy.mock.contexts[spy.mock.contexts.length - 1] as HTMLElement;
expect(target.classList.contains('calendar-day-header')).toBe(true);
      expect(target.textContent).toBe('Today · Oct 26');
      expect(target).toBe(container.querySelector('.calendar-day-header'));
    } finally {
      spy.mockRestore();
    }
  });
});
