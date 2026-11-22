// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarPane, type CalendarPaneProps } from '../CalendarPane.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(loadDay: ReturnType<typeof vi.fn> | undefined = vi.fn()) {
  let events = [event('2026-12-01')];
  const controller = {
    subscribe: () => () => {},
    getEvents: vi.fn(() => events),
    getSourceStatus: () => ({ source: 'ready' }),
    getCalendars: () => [],
    getSelectedIds: () => new Set(['calendar']),
    loadDay,
  } as unknown as CalendarPaneProps['controller'];
  const props: CalendarPaneProps = {
    controller, sources: [{ id: 'source', email: 'a@example.com' }] as CalendarPaneProps['sources'],
    selectedRsvpStatuses: new Set(['accepted']), onRsvpStatusesChange: vi.fn(),
  };
  const view = render(<CalendarPane {...props} />);
  fireEvent.click(screen.getByRole('button', { name: '2026-11-02' }));
  fireEvent.click(screen.getByRole('button', { name: 'Toggle calendar weeks' }));
  scroll.mockClear();
  return { ...view, props, controller, setEvents: (keys: string[]) => { events = keys.map(event); } };
}

function event(key: string) {
  return {
    id: key, sourceId: 'source', calendarId: 'calendar', summary: `Event ${key}`,
    start: { date: key }, end: { date: key }, isAllDay: true, selfResponseStatus: 'accepted', organizer: {},
  };
}

const scroll = vi.fn();
const day = (key = '2026-12-02') => screen.getByRole('button', { name: key });
const dimmed = (key = '2026-12-02') => expect(day(key).classList.contains('calendar-weekstrip-day--outside-window'));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 1, 12));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); scroll.mockClear(); });

describe('WeekStrip day loading', () => {
  it('loads the key once, shows per-day busy, then refreshes events and scrolls to the loaded day', async () => {
    const pending = deferred();
    const load = vi.fn(() => pending.promise);
    const view = setup(load);
    fireEvent.click(day());
    fireEvent.click(day());
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith('2026-12-02');
    expect(day().getAttribute('aria-busy')).toBe('true');
    expect(day('2026-12-03').getAttribute('aria-busy')).not.toBe('true');
    expect(day().querySelector('.calendar-weekstrip-dot')).not.toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    view.setEvents(['2026-12-01', '2026-12-02']);
    await act(async () => pending.resolve());
    expect(screen.getByText('Event 2026-12-02')).toBeTruthy();
    dimmed().toBe(false);
    expect(day().getAttribute('aria-busy')).not.toBe('true');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.instances[0]).toBe(screen.getByText('Event 2026-12-02').closest('.calendar-day-group')?.querySelector('.calendar-day-header'));
    fireEvent.click(day());
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('ignores a different unsynced day during loading and allows it after settlement', async () => {
    const pending = deferred();
    const load = vi.fn(() => pending.promise);
    setup(load);
    fireEvent.click(day());
    fireEvent.click(day('2026-12-03'));
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());
    await act(async () => fireEvent.click(day('2026-12-03')));
    expect(load).toHaveBeenLastCalledWith('2026-12-03');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(['reject', 'empty', 'throw'])('%s stays dimmed without alert and can retry', async (outcome) => {
    const pending = deferred();
    const load = vi.fn(() => { if (outcome === 'throw') throw new Error('failed'); return pending.promise; });
    setup(load);
    fireEvent.click(day());
    await act(async () => { if (outcome === 'reject') pending.reject(new Error('failed')); else pending.resolve(); });
    dimmed().toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
    expect(day().getAttribute('aria-busy')).not.toBe('true');
    await act(async () => fireEvent.click(day()));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('falls back to the nearest event for a legacy controller', () => {
    const view = setup();
    delete (view.controller as unknown as { loadDay?: unknown }).loadDay;
    fireEvent.click(day());
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(day('2026-12-01').getAttribute('aria-pressed')).toBe('true');
  });

  it('ignores completion after unmount', async () => {
    const pending = deferred();
    const view = setup(vi.fn(() => pending.promise));
    fireEvent.click(day());
    expect(view.controller.loadDay).toHaveBeenCalledWith('2026-12-02');
    view.unmount();
    const reads = vi.mocked(view.controller.getEvents).mock.calls.length;
    await act(async () => pending.resolve());
    expect(view.controller.getEvents).toHaveBeenCalledTimes(reads);
    expect(scroll).not.toHaveBeenCalled();
  });

  it('ignores stale completion after the controller changes', async () => {
    const pending = deferred();
    const view = setup(vi.fn(() => pending.promise));
    fireEvent.click(day());
    expect(view.controller.loadDay).toHaveBeenCalledWith('2026-12-02');
    const replacement = { ...view.controller, getEvents: vi.fn(() => [event('2026-12-01')]) } as unknown as CalendarPaneProps['controller'];
    view.rerender(<CalendarPane {...view.props} controller={replacement} />);
    const reads = vi.mocked(view.controller.getEvents).mock.calls.length;
    await act(async () => pending.resolve());
    expect(view.controller.getEvents).toHaveBeenCalledTimes(reads);
    dimmed().toBe(true);
    expect(day().getAttribute('aria-busy')).not.toBe('true');
    expect(scroll).not.toHaveBeenCalled();
  });
});
