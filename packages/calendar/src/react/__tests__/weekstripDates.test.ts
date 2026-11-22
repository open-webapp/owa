import { describe, expect, it } from 'vitest';
import {
  addDays,
  inWindow,
  localDateKey,
  monthOfRow,
  nearestDayWithEvents,
  startOfWeek,
  weekRows,
} from '../weekstripDates';

describe('weekstripDates', () => {
  it('formats dates using local calendar fields', () => {
    expect(localDateKey(new Date(2026, 0, 2, 23, 45))).toBe('2026-01-02');
    expect(localDateKey(new Date(2026, 10, 21, 0, 15))).toBe('2026-11-21');
  });

  it('starts weeks on Sunday, including across a year boundary', () => {
    expect(startOfWeek('2026-11-22')).toBe('2026-11-22');
    expect(startOfWeek('2026-11-28')).toBe('2026-11-22');
    expect(startOfWeek('2026-01-01')).toBe('2025-12-28');
  });

  it('adds calendar days across year and leap-day boundaries', () => {
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
  });

  it('creates seven-day rows across the year boundary', () => {
    expect(weekRows('2025-12-28', 2)).toEqual([
      ['2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03'],
      ['2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10'],
    ]);
    expect(weekRows('2026-01-04', 0)).toEqual([]);
  });

  it('uses Wednesday to choose the month of a straddling row', () => {
    expect(monthOfRow('2026-03-29')).toBe('2026-04');
    expect(monthOfRow('2026-05-31')).toBe('2026-06');
    expect(monthOfRow('2025-12-28')).toBe('2025-12');
  });

  it('keeps all calendar dates in spring and fall DST weeks', () => {
    expect(weekRows('2026-03-08', 1)).toEqual([
      ['2026-03-08', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14'],
    ]);
    expect(weekRows('2026-11-01', 1)).toEqual([
      ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'],
    ]);
    expect(addDays('2026-03-07', 2)).toBe('2026-03-09');
    expect(addDays('2026-11-02', -2)).toBe('2026-10-31');
  });

  it('prefers the earliest next event over even a closer previous event', () => {
    expect(nearestDayWithEvents('2026-11-21', new Set([
      '2026-12-10', '2026-11-20', '2026-11-25', '2026-11-21',
    ]))).toBe('2026-11-25');
  });

  it('falls back to the latest previous event, then null', () => {
    expect(nearestDayWithEvents('2026-11-21', new Set([
      '2026-11-01', '2026-11-20', '2026-11-10',
    ]))).toBe('2026-11-20');
    expect(nearestDayWithEvents('2026-11-21', new Set())).toBeNull();
    expect(nearestDayWithEvents('2026-11-21', new Set(['2026-11-21']))).toBeNull();
  });

  it('includes the literal 30-day boundaries but excludes 31 days', () => {
    const now = new Date(2026, 10, 21, 23, 59);
    expect(inWindow('2026-11-21', now, 30)).toBe(true);
    expect(inWindow('2026-12-21', now, 30)).toBe(true);
    expect(inWindow('2026-12-22', now, 30)).toBe(false);
    expect(inWindow('2026-10-22', now, 30)).toBe(true);
    expect(inWindow('2026-10-21', now, 30)).toBe(false);
  });

  it.each(['2026-13-40', '', '2026-02-29', '2026-04-31'])('rejects invalid key %j with exactly RangeError', (key) => {
    const operations = [
      () => startOfWeek(key),
      () => addDays(key, 1),
      () => weekRows(key, 1),
      () => monthOfRow(key),
      () => nearestDayWithEvents(key, new Set<string>()),
      () => nearestDayWithEvents('2026-11-21', new Set([key])),
      () => inWindow(key, new Date(2026, 10, 21), 30),
    ];
    for (const operation of operations) {
      expect(operation).toThrowError(RangeError);
      try {
        operation();
      } catch (error) {
        expect((error as Error).constructor).toBe(RangeError);
      }
    }
  });
});
