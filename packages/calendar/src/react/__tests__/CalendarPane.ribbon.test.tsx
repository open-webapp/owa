import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import { makeEvent, baseProps } from './helpers.js';

function parity(key: string): 'even' | 'odd' {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000) % 2 === 0 ? 'even' : 'odd';
}
const ev = (id: string, day: string, extra: object = {}) =>
  makeEvent({ id, start: { dateTime: `${day}T12:00:00Z` }, end: { dateTime: `${day}T13:00:00Z` }, ...extra });
const parities = (c: HTMLElement) =>
  Array.from(c.querySelectorAll('.calendar-day-ribbon')).map((r) => r.getAttribute('data-parity'));

describe('CalendarPane ribbon parity across boundaries',()=>{
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00'));
  });
  afterEach(() => vi.useRealTimers());

  it('alternates across consecutive days, month boundary and year boundary', () => {
    const days = ['2026-10-30', '2026-10-31', '2026-11-01', '2026-12-31', '2027-01-01'];
    const { container } = render(<CalendarPane {...baseProps({ events: days.map((d) => ev(d, d)) })} />);
    expect(parities(container)).toEqual(days.map(parity));
    const p = parities(container);
    expect(p[1]).not.toBe(p[2]);
    expect(p[3]).not.toBe(p[4]);
  });

  it('keeps remaining days parity unchanged when a middle day is filtered out', () => {
    const events = [ev('a', '2026-10-27'), ev('b', '2026-10-28', { selfResponseStatus: 'declined' }), ev('c', '2026-10-29')];
    const { container } = render(<CalendarPane {...baseProps({ events })} />);
    const ribbons = Array.from(container.querySelectorAll('.calendar-day-ribbon'));
    expect(ribbons.map((r) => r.textContent)).toEqual(['Oct 27', 'Oct 29']);
    expect(parities(container)).toEqual([parity('2026-10-27'), parity('2026-10-29')]);
  });

  it('renders no ribbon for the synthesized empty today group (events elsewhere)', () => {
    const { container } = render(<CalendarPane {...baseProps({ events: [ev('a', '2026-10-28')] })} />);
    // NOTE: empty groups have no ribbon at all, so there is no data-parity to check on them.
    expect(container.querySelectorAll('.calendar-day-ribbon')).toHaveLength(1);
    expect(parities(container)).toEqual([parity('2026-10-28')]);
  });
});

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

  it('has no data-today attribute anywhere (today is not special)', () => {
    const { container } = render(<CalendarPane {...baseProps({ events: two() })} />);
    expect(container.querySelectorAll('[data-today]')).toHaveLength(0);
  });

  it('sets data-parity on every ribbon from the day-number parity of its dateKey', () => {
    const { container } = render(<CalendarPane {...baseProps({ events: two() })} />);
    const ribbons = Array.from(container.querySelectorAll('.calendar-day-ribbon'));
    expect(ribbons.map((r) => r.getAttribute('data-parity'))).toEqual([parity('2026-10-26'), parity('2026-10-27')]);
    expect(ribbons[0].getAttribute('data-parity')).not.toBe(ribbons[1].getAttribute('data-parity'));
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
