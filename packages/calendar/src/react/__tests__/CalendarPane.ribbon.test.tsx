import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import { makeEvent, baseProps } from './helpers.js';

describe('CalendarPane day ribbon', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00'));
  });
  afterEach(() => vi.useRealTimers());

  const two = () => [
    makeEvent({ id: 'a', start: { dateTime: '2026-10-26T18:00:00Z' }, end: { dateTime: '2026-10-26T19:00:00Z' } }),
    makeEvent({ id: 'b', start: { dateTime: '2026-10-27T18:00:00Z' }, end: { dateTime: '2026-10-27T19:00:00Z' } }),
  ];

  it('renders one aria-hidden ribbon per day before its events', () => {
    const { container } = render(<CalendarPane {...baseProps({ events: two() })} />);
    const ribbons = container.querySelectorAll('.calendar-day-ribbon');
    expect(ribbons).toHaveLength(2);
    expect(Array.from(ribbons).map((r) => r.textContent)).toEqual(['Oct 26', 'Oct 27']);
    ribbons.forEach((r) => {
      expect(r.getAttribute('aria-hidden')).toBe('true');
      const events = r.parentElement!.querySelector('.calendar-event-row, .calendar-event-allday')!;
      expect(r.compareDocumentPosition(events) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('flags only today, with no year or Today text', () => {
    const { container } = render(<CalendarPane {...baseProps({ events: two() })} />);
    const flagged = container.querySelectorAll('.calendar-day-ribbon[data-today]');
    expect(flagged).toHaveLength(1);
    expect(flagged[0].textContent).toBe('Oct 26');
  });

  it('renders no ribbons without events', () => {
    const { container } = render(<CalendarPane {...baseProps({ events: [] })} />);
    expect(container.querySelectorAll('.calendar-day-ribbon')).toHaveLength(0);
  });

  it('scroll-to-today still targets the day header', () => {
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy;
    const { container, queryByRole } = render(<CalendarPane {...baseProps({ events: two() })} />);
    const btn = queryByRole('button', { name: /today/i });
    if (btn) {
      fireEvent.click(btn);
      if (spy.mock.instances.length) {
        expect((spy.mock.instances[0] as Element).className).toBe('calendar-day-header');
      }
    }
    expect(container.querySelector('.calendar-day-header')).not.toBeNull();
  });
});
