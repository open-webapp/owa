// TZ must be set before any Date is created; Node re-reads process.env.TZ at runtime.
process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, within, act } from '@testing-library/react';
import { CalendarPane } from '../CalendarPane.js';
import { baseProps } from './helpers.js';

describe('CalendarPane week strip local date in America/Los_Angeles', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T20:00:00-07:00')); // 03:00Z Sunday Oct 25
  });
  afterEach(() => vi.useRealTimers());

  it('marks Saturday as today and starts the week on local Sunday, not UTC Sunday', () => {
    expect(new Date().getTimezoneOffset()).toBe(420);
    expect(new Date().getDate()).toBe(24);
    expect(new Date().toISOString().slice(0, 10)).toBe('2026-10-25');
    const { getByRole } = render(<CalendarPane {...baseProps({ events: [] })} />);
    const strip = within(getByRole('group', { name: 'Week', exact: true }));
    const today = strip.getByRole('button', { name: '2026-10-24' });
    expect(today.getAttribute('aria-current')).toBe('date');
    expect(today.getAttribute('aria-pressed')).toBe('true');
    expect(strip.getAllByRole('button').filter((button) => button.hasAttribute('aria-current'))).toEqual([today]);
    const week = strip.getByRole('row', { name: 'Week of 2026-10-18' });
    expect(within(week).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      '2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21',
      '2026-10-22', '2026-10-23', '2026-10-24',
    ]);
    expect(strip.getAllByRole('row').filter((row) => row.getAttribute('aria-label')?.startsWith('Week of '))).toEqual([week]);
  });

  it('loads an outside-window day using the clicked local date key', async () => {
    const props = baseProps({ events: [] });
    const loadDay = vi.fn(async () => {});
    props.controller.loadDay = loadDay;
    const { getByRole } = render(<CalendarPane {...props} />);
    fireEvent.click(getByRole('button', { name: 'Toggle calendar weeks' }));
    const strip = within(getByRole('group', { name: 'Week', exact: true }));
    const outsideDay = strip.getByRole('button', { name: '2026-12-01' });
    expect(outsideDay.getAttribute('data-outside-window')).toBe('true');
    expect(loadDay).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(outsideDay); });
    expect(loadDay).toHaveBeenCalledTimes(1);
    expect(loadDay).toHaveBeenCalledWith('2026-12-01');
  });
});
