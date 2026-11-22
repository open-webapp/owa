// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarPane, type CalendarPaneProps } from '../CalendarPane.js';
import { WeekStrip } from '../WeekStrip.js';

const today = new Date(2026, 10, 18, 12);
const scroll = vi.fn();
function event(day: string, status = 'accepted') {
  return {
    id: day, sourceId: 'source', calendarId: 'calendar', summary: `Event ${day}`,
    start: { date: day }, end: { date: day }, isAllDay: true, selfResponseStatus: status, organizer: {},
  };
}
function pane(events: ReturnType<typeof event>[] = [], statuses = new Set(['accepted'])) {
  return {
    connected: true, sources: [], selectedRsvpStatuses: statuses,
    onRsvpStatusesChange: vi.fn(),
    controller: {
      subscribe: () => () => {}, getEvents: () => events, getSourceStatus: () => ({}),
      getCalendars: () => [], getSelectedIds: () => new Set(),
    },
  } as unknown as CalendarPaneProps;
}
function strip() { return within(screen.getByRole('group', { name: 'Week' })); }
function day(date: string) { return strip().getByRole('button', { name: date }); }
function expectHeader(label: string) {
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll.mock.instances[0]).toBe(screen.getByText(label));
  expect(scroll).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(today);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
  scroll.mockClear();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('collapsed week strip', () => {
  it('renders Sunday-first headings, seven date buttons, and today/selected state', () => {
    render(<CalendarPane {...pane()} />);
    expect(strip().getAllByRole('columnheader').map((el) => el.textContent)).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
    expect(within(strip().getByRole('table')).getAllByRole('button')).toHaveLength(7);
    expect(day('2026-11-18').getAttribute('aria-current')).toBe('date');
    expect(day('2026-11-18').getAttribute('aria-pressed')).toBe('true');
    expect(day('2026-11-15').textContent).toContain('15');
  });

  it('selects an event day and scrolls its exact header', () => {
    render(<CalendarPane {...pane([event('2026-11-19'), event('2026-11-20')])} />);
    scroll.mockClear();
    fireEvent.click(day('2026-11-19'));
    expectHeader('Tomorrow · Thursday');
    expect(day('2026-11-19').getAttribute('aria-pressed')).toBe('true');
    expect(day('2026-11-18').getAttribute('aria-pressed')).toBe('false');
  });

  it('uses the next event day for an empty day, then falls back to the previous day', () => {
    render(<CalendarPane {...pane([event('2026-11-16'), event('2026-11-20')])} />);
    scroll.mockClear();
    fireEvent.click(day('2026-11-17'));
    expectHeader('Friday');
    expect(day('2026-11-20').getAttribute('aria-pressed')).toBe('true');
    scroll.mockClear();
    fireEvent.click(day('2026-11-21'));
    expectHeader('Friday');
  });

  it('does not scroll when there are no matching event days', () => {
    render(<CalendarPane {...pane()} />);
    scroll.mockClear();
    fireEvent.click(day('2026-11-19'));
    expect(scroll).not.toHaveBeenCalled();
  });

  it('removes the event dot when RSVP filtering hides that day', () => {
    const props = pane([event('2026-11-19')]);
    const { rerender } = render(<CalendarPane {...props} />);
    expect(within(day('2026-11-19')).getByRole('img', { name: 'Has events' })).toBeTruthy();
    rerender(<CalendarPane {...props} selectedRsvpStatuses={new Set(['declined'])} />);
    expect(within(day('2026-11-19')).queryByRole('img', { name: 'Has events' })).toBeNull();
  });

  it('Today resets the selected date', () => {
    render(<CalendarPane {...pane([event('2026-11-19')])} />);
    fireEvent.click(day('2026-11-19'));
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }));
    expect(day('2026-11-18').getAttribute('aria-pressed')).toBe('true');
    expect(day('2026-11-19').getAttribute('aria-pressed')).toBe('false');
  });

  it('marks dates outside the inclusive local ±30-day window and forwards clicks for loading', () => {
    const onSelect = vi.fn();
    render(<WeekStrip today={today} selected="2026-12-18" eventDays={new Set()} loading={false} onSelect={onSelect} />);
    fireEvent.click(strip().getByRole('button', { name: 'Toggle calendar weeks' }));
    expect(day('2026-12-18').getAttribute('data-outside-window')).toBe('false');
    expect(day('2026-12-19').getAttribute('data-outside-window')).toBe('true');
    fireEvent.click(day('2026-12-19'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('2026-12-19');
  });

  it('does not throw when the target header is missing', () => {
    const props = pane([event('2026-11-19')]);
    props.controller.getState = () => ({ loading: false, error: true, deferred: false, lastSyncAt: null });
    props.sources = [{ id: 'source', email: 'test@example.com' }] as CalendarPaneProps['sources'];
    props.controller.getSourceStatus = () => ({ source: 'error' });
    // A source error with no events hides day groups; the strip still accepts clicks safely.
    props.controller.getEvents = () => [];
    render(<CalendarPane {...props} />);
    scroll.mockClear();
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Scroll to today' }))).not.toThrow();
    expect(() => fireEvent.click(day('2026-11-19'))).not.toThrow();
    expect(scroll).not.toHaveBeenCalled();
  });
});
