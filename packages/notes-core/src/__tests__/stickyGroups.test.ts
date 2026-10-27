import { describe, expect, it } from 'vitest';
import type { Entry } from '../types.js';
import { colorFor, groupTodoBoard, rotFor, saturationFor } from '../stickyGroups.js';

// 2026-10-04 is a Sunday.
const today = '2026-10-04';
const both = { showCompleted: true, showPastDue: true };

function entry(id: string, date: string, text = `${id} @${date}`, doneAt?: number): Entry {
  return { id, date: today, time: '09:00', text, createdAt: 0, doneAt };
}
function done(id: string, y: number, m: number, d: number, text = id): Entry {
  return entry(id, today, text, new Date(y, m - 1, d, 12).getTime());
}
const board = (entries: Entry[], opts = both, t = today) => groupTodoBoard(entries, t, opts);
const weekLabels = (months: { weeks: { label: string }[] }[]) => months.map(m => m.weeks.map(w => w.label));

describe('groupTodoBoard upcoming', () => {
  it('fans days 0-6 ascending with today first and week-stacks day 7+', () => {
    const es = ['2026-10-04', '2026-10-10', '2026-10-11', '2026-10-05'].map(d => entry(d, d));
    const b = board(es);
    expect(b.upcoming.fanned.map(d => d.date)).toEqual(['2026-10-04', '2026-10-05', '2026-10-10']);
    expect(b.upcoming.fanned[0]).toMatchObject({ isToday: true, label: 'Today · Oct 4' });
    expect(b.upcoming.months.map(m => m.month)).toEqual(['Oct 2026']);
    expect(b.upcoming.months[0].weeks.map(w => w.items.map(i => i.entry.id))).toEqual([['2026-10-11']]);
  });

  it('day 7 starts a week stack; Sunday and Monday fall in separate Monday-start weeks', () => {
    const b = board([entry('sun', '2026-10-11'), entry('mon', '2026-10-12')]);
    expect(weekLabels(b.upcoming.months)).toEqual([['Oct 5 – 11', 'Oct 12 – 18']]);
  });

  it('orders months and weeks ascending, week spanning months formatted across both', () => {
    const b = board([entry('nov', '2026-11-20'), entry('x', '2026-10-30'), entry('y', '2026-10-14')]);
    expect(b.upcoming.months.map(m => m.month)).toEqual(['Oct 2026', 'Nov 2026']);
    expect(weekLabels(b.upcoming.months)).toEqual([['Oct 12 – 18', 'Oct 26 – Nov 1'], ['Nov 16 – 22']]);
  });

  it('groups by the section @date, not the creation date, one entry in several days', () => {
    const e = entry('m', today, 'A @2026-10-05\n\nB @2026-10-06');
    expect(board([e]).upcoming.fanned.map(d => d.date)).toEqual(['2026-10-05', '2026-10-06']);
  });

  it('handles year boundary', () => {
    const b = board([entry('ny', '2027-01-02')], both, '2026-12-20');
    expect(b.upcoming.months[0].month).toBe('Dec 2026');
    expect(b.upcoming.months[0].weeks[0].label).toBe('Dec 28, 2026 – Jan 3, 2027');
  });

  it('does not desaturate fanned upcoming days', () => {
    const b = board([entry('a', '2026-10-04'), entry('b', '2026-10-09')]);
    expect(b.upcoming.fanned.map(d => saturationFor(d.age))).toEqual([1, 1]);
  });
});

describe('groupTodoBoard past due', () => {
  it('fans last 7 days newest first, labelled by age', () => {
    const b = board([entry('a', '2026-10-03'), entry('b', '2026-09-27'), entry('c', '2026-09-30')]);
    expect(b.pastDue.fanned.map(d => d.date)).toEqual(['2026-10-03', '2026-09-30', '2026-09-27']);
    expect(b.pastDue.fanned.map(d => d.label)).toEqual(['yesterday', '4 days ago', '7 days ago']);
    expect(b.pastDue.months).toEqual([]);
  });

  it('older goes to month columns and weeks, newest first', () => {
    const b = board([entry('a', '2026-09-26'), entry('b', '2026-09-21'), entry('c', '2026-09-20'), entry('d', '2026-08-10')]);
    expect(b.pastDue.fanned).toEqual([]);
    expect(b.pastDue.months.map(m => m.month)).toEqual(['Sep 2026', 'Aug 2026']);
    expect(weekLabels(b.pastDue.months)).toEqual([['Sep 21 – 27', 'Sep 14 – 20'], ['Aug 10 – 16']]);
    expect(b.pastDue.months[0].weeks[0].items[1]).toMatchObject({ weekday: 'Saturday', entry: { id: 'a' } });
  });

  it('desaturates with age, monotonic with a floor', () => {
    const b = board([entry('a', '2026-10-03'), entry('b', '2026-09-28'), entry('c', '2026-09-01'), entry('d', '2025-01-01')]);
    const sats = [...b.pastDue.fanned.map(d => saturationFor(d.age)), ...b.pastDue.months.flatMap(m => m.weeks.map(w => saturationFor(w.age)))];
    for (let i = 1; i < sats.length; i++) expect(sats[i]).toBeLessThanOrEqual(sats[i - 1]);
    expect(sats[0]).toBeLessThan(1);
    expect(sats[sats.length - 1]).toBeGreaterThan(0);
    expect(saturationFor(100000)).toBe(saturationFor(200000));
  });

  it('is empty when showPastDue is false', () => {
    const b = board([entry('a', '2026-10-03')], { showCompleted: true, showPastDue: false });
    expect(b.pastDue).toEqual({ fanned: [], months: [] });
  });
});

describe('groupTodoBoard completed', () => {
  it('groups by doneAt day into week stacks, never fanned, even for today', () => {
    const b = board([done('t', 2026, 10, 4), done('y', 2026, 10, 3), done('o', 2026, 8, 5)]);
    expect(b.completed.months.map(m => m.month)).toEqual(['Sep 2026', 'Aug 2026']);
    expect(b.completed.months[0].weeks[0].items.map(i => i.entry.id).sort()).toEqual(['t', 'y']);
    expect(Object.keys(b.completed)).toEqual(['months']);
  });

  it('excludes done entries from upcoming and past due, even with dated sections', () => {
    const e = entry('x', today, 'Task @2026-10-05', Date.now());
    const f = entry('y', today, 'Task @2026-10-01', Date.now());
    const b = board([e, f]);
    expect(b.upcoming.fanned).toEqual([]);
    expect(b.pastDue.fanned).toEqual([]);
  });

  it('includes undated done entries; is empty when showCompleted is false', () => {
    const e = done('u', 2026, 10, 1, 'no date here');
    expect(board([e]).completed.months).toHaveLength(1);
    expect(board([e], { showCompleted: false, showPastDue: true }).completed).toEqual({ months: [] });
  });

  it('sorts newest first by doneAt day', () => {
    const b = board([done('a', 2026, 9, 28), done('b', 2026, 9, 30)]);
    expect(weekLabels(b.completed.months)).toEqual([['Sep 28 – Oct 4']]);
    expect(b.completed.months[0].weeks[0].items.map(i => i.entry.id)).toEqual(['a', 'b']);
  });
});

describe('groupTodoBoard edge cases', () => {
  it('empty input gives empty sections', () => {
    expect(board([])).toEqual({ upcoming: { fanned: [], months: [] }, pastDue: { fanned: [], months: [] }, completed: { months: [] } });
  });

  it('skips undated non-done entries', () => {
    const b = board([entry('n', today, 'just a note')]);
    expect(b).toEqual(board([]));
  });

  it('treats non-finite/zero doneAt and invalid @date as not done / undated without throwing', () => {
    const nan = entry('nan', today, 'Task @2026-10-05', Number.NaN);
    const inf = entry('inf', today, 'Task @2026-10-06', Infinity);
    const bad = entry('bad', today, 'Task @2026-13-40');
    let b = board([]);
    expect(() => { b = board([nan, inf, bad]); }).not.toThrow();
    expect(b.upcoming.fanned.map(d => d.date)).toEqual(['2026-10-05', '2026-10-06']);
    expect(b.completed.months).toEqual([]);
    expect(b.pastDue).toEqual({ fanned: [], months: [] });
  });

  it('cycles colors deterministically and alternates rotation signs', () => {
    expect(colorFor(5)).toBe(colorFor(0));
    expect(rotFor(0)).toBeLessThan(0);
    expect(rotFor(1)).toBeGreaterThan(0);
  });
});
