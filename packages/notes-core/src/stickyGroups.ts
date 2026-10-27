import type { Entry } from './types.js';
import { filterParagraphsForTab, sectionDateForTab } from './entryFiltering.js';
import { getEntryLevelDate } from './tags.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const COLORS = ['oklch(72% 0.16 25)', 'oklch(78% 0.14 85)', 'oklch(76% 0.13 145)', 'oklch(72% 0.14 210)', 'oklch(72% 0.16 290)'];
const ROTS = [-1.5, 1.5];

/** One checkbox row on a sticky: a section of an entry. */
export type StickyRow = {
  entry: Entry;
  section: string;
  time: string;
};

export type Day = {
  date: string;
  label: string;
  /** Plain formatted date, e.g. "Oct 2". */
  when: string;
  isToday: boolean;
  count: number;
  /** Age index for desaturation: 0 = none. */
  age: number;
  items: Entry[];
  rows: StickyRow[];
};

export type PastItem = {
  entry: Entry;
  section: string;
  time: string;
  weekday: string;
  day: string;
};

/** Returns the sections of an entry that should be shown for a tab. */
export type SectionSource = (entry: Entry) => string[];

export type PastWeek = {
  /** Monday of the week. */
  start: string;
  /** Last day (most recent) with rows. */
  lastDay: string;
  label: string;
  ago: string;
  /** Age index for desaturation: 0 = none. */
  age: number;
  items: PastItem[];
};

export type PastMonth = {
  month: string;
  weeks: PastWeek[];
};

function toDayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date);
}

function dayKey(value: string | Date): string {
  return typeof value === 'string' ? value : toDayKey(value);
}

function addDays(day: string, amount: number): string {
  const value = parseDay(day);
  value.setDate(value.getDate() + amount);
  return toDayKey(value);
}

function formatDay(day: string, includeYear = false): string {
  const value = parseDay(day);
  const base = `${MONTHS[value.getMonth()]} ${value.getDate()}`;
  return includeYear ? `${base}, ${value.getFullYear()}` : base;
}

function formatDayLabel(day: string, today: string): string {
  return day === today ? `Today · ${formatDay(day)}` : formatDay(day, parseDay(day).getFullYear() !== parseDay(today).getFullYear());
}

function doneDay(entry: Entry): string | null {
  return typeof entry.doneAt === 'number' && Number.isFinite(entry.doneAt) && entry.doneAt > 0
    ? toDayKey(new Date(entry.doneAt))
    : null;
}

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
}

function uniqueEntries(rows: StickyRow[]): Entry[] {
  return sortEntries(Array.from(new Set(rows.map((row) => row.entry))));
}

function sortRows(rows: StickyRow[]): StickyRow[] {
  return [...rows].sort((a, b) => a.entry.date.localeCompare(b.entry.date) || a.time.localeCompare(b.time) || a.entry.id.localeCompare(b.entry.id));
}

/** Buckets displayed sections by resolved @date (not done) or doneAt day (done). */
function bucketRows(entries: Entry[], today: string, source?: SectionSource): { dated: Map<string, StickyRow[]>; completed: Map<string, StickyRow[]> } {
  const dated = new Map<string, StickyRow[]>();
  const completed = new Map<string, StickyRow[]>();
  const push = (map: Map<string, StickyRow[]>, date: string, row: StickyRow) => {
    const rows = map.get(date);
    if (rows) rows.push(row);
    else map.set(date, [row]);
  };
  for (const entry of entries) {
    const sections = source ? source(entry) : filterParagraphsForTab(entry, 'upcoming', [], null, '', today);
    const entryDone = doneDay(entry);
    const entryLevelDate = entryDone === null ? getEntryLevelDate(entry.text) : null;
    for (const section of sections) {
      const row = { entry, section, time: entry.time };
      if (entryDone !== null) push(completed, entryDone, row);
      else {
        const date = sectionDateForTab(section, entry, entryLevelDate);
        if (date !== null) push(dated, date, row);
      }
    }
  }
  return { dated, completed };
}

function toDay(date: string, rows: StickyRow[], label: string, isToday: boolean, age: number): Day {
  const sorted = sortRows(rows);
  return { date, label, when: formatDay(date), isToday, age, count: sorted.length, items: uniqueEntries(sorted), rows: sorted };
}

function mondayFor(day: string): string {
  const value = parseDay(day);
  const daysSinceMonday = (value.getDay() + 6) % 7;
  value.setDate(value.getDate() - daysSinceMonday);
  return toDayKey(value);
}

function formatWeek(start: string): string {
  const end = addDays(start, 6);
  const startDate = parseDay(start);
  const endDate = parseDay(end);
  if (startDate.getFullYear() !== endDate.getFullYear()) {
    return `${formatDay(start, true)} – ${formatDay(end, true)}`;
  }
  if (startDate.getMonth() !== endDate.getMonth()) {
    return `${formatDay(start)} – ${formatDay(end)}`;
  }
  return `${formatDay(start)} – ${endDate.getDate()}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / DAY_MS);
}

function ageLabel(day: string, today: string): string {
  const difference = daysBetween(day, today);
  return difference === 1 ? 'yesterday' : `${difference} days ago`;
}

/** Relative label for an upcoming day: "today", "tomorrow" or "in N days". */
export function upcomingAgeLabel(day: string, today: string): string {
  const difference = daysBetween(today, day);
  if (difference <= 0) return 'today';
  return difference === 1 ? 'tomorrow' : `in ${difference} days`;
}

/** Saturation multiplier (1 = full) for an age index; monotonic non-increasing with a floor. */
export function saturationFor(age: number): number {
  return Math.max(0.35, 1 - Math.max(0, age) * 0.02);
}

/** Groups day buckets into Monday-start week stacks inside month columns. `newestFirst` orders months/weeks descending. */
function groupWeeks(buckets: Map<string, StickyRow[]>, today: string, newestFirst: boolean, desaturate: boolean): PastMonth[] {
  const weeks = new Map<string, PastItem[]>();
  for (const [date, rows] of buckets) {
    const items: PastItem[] = rows.map((row) => ({ ...row, weekday: WEEKDAYS[parseDay(date).getDay()], day: date }));
    const week = mondayFor(date);
    const grouped = weeks.get(week);
    if (grouped) grouped.push(...items);
    else weeks.set(week, items);
  }

  const currentMonday = mondayFor(today);
  const months = new Map<string, PastMonth>();
  const ordered = Array.from(weeks.entries()).sort(([a], [b]) => (newestFirst ? b.localeCompare(a) : a.localeCompare(b)));
  for (const [start, items] of ordered) {
    const startDate = parseDay(start);
    const month = `${MONTHS[startDate.getMonth()]} ${startDate.getFullYear()}`;
    const diffWeeks = Math.round(daysBetween(start, currentMonday) / 7);
    const sorted = [...items].sort((a, b) => a.day.localeCompare(b.day) || a.time.localeCompare(b.time) || a.entry.id.localeCompare(b.entry.id));
    const nearest = diffWeeks > 0 ? sorted[sorted.length - 1].day : sorted[0].day;
    const ago = diffWeeks === 0 ? 'this week'
      : diffWeeks > 0 ? (diffWeeks === 1 ? '1 week ago' : `${diffWeeks} weeks ago`)
      : (diffWeeks === -1 ? 'next week' : `in ${-diffWeeks} weeks`);
    const week: PastWeek = {
      start,
      lastDay: sorted[sorted.length - 1].day,
      label: formatWeek(start),
      ago,
      age: desaturate ? Math.abs(daysBetween(nearest, today)) : 0,
      items: sorted,
    };
    const group = months.get(month);
    if (group) group.weeks.push(week);
    else months.set(month, { month, weeks: [week] });
  }
  return Array.from(months.values());
}

export type TodoBoard = {
  upcoming: { fanned: Day[]; months: PastMonth[] };
  pastDue: { fanned: Day[]; months: PastMonth[] };
  completed: { months: PastMonth[] };
};

/**
 * Unified ToDo board. Upcoming (@date >= today, not done): next 7 days fanned ascending,
 * later days as week stacks (months/weeks ascending). Past due (@date < today, not done):
 * last 7 days fanned newest first, older as week stacks newest first. Completed (valid
 * doneAt): by doneAt day as week stacks newest first, never fanned. Undated non-done
 * sections are skipped. Hidden sections (flags false) are empty.
 */
export function groupTodoBoard(
  entries: Entry[],
  today: string | Date,
  options: { showCompleted: boolean; showPastDue: boolean },
  source?: SectionSource,
): TodoBoard {
  const todayKey = dayKey(today);
  const fanEnd = addDays(todayKey, 7);
  const pastStart = addDays(todayKey, -7);
  const { dated, completed } = bucketRows(entries, todayKey, source);

  const upFan = new Map<string, StickyRow[]>();
  const upRest = new Map<string, StickyRow[]>();
  const pastFan = new Map<string, StickyRow[]>();
  const pastRest = new Map<string, StickyRow[]>();
  for (const [date, rows] of dated) {
    if (date >= todayKey) (date < fanEnd ? upFan : upRest).set(date, rows);
    else if (options.showPastDue) (date >= pastStart ? pastFan : pastRest).set(date, rows);
  }

  return {
    upcoming: {
      fanned: Array.from(upFan.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, rows]) => toDay(date, rows, formatDayLabel(date, todayKey), date === todayKey, 0)),
      months: groupWeeks(upRest, todayKey, false, true),
    },
    pastDue: {
      fanned: Array.from(pastFan.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([date, rows]) => toDay(date, rows, ageLabel(date, todayKey), false, daysBetween(date, todayKey))),
      months: groupWeeks(pastRest, todayKey, true, true),
    },
    completed: { months: options.showCompleted ? groupWeeks(completed, todayKey, true, true) : [] },
  };
}

export function colorFor(index: number): string {
  return COLORS[((index % COLORS.length) + COLORS.length) % COLORS.length];
}

export function rotFor(index: number): number {
  return ROTS[((index % ROTS.length) + ROTS.length) % ROTS.length];
}
