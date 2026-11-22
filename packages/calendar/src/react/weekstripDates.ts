const DAY_MS = 86_400_000;

function dateKey(year: number, month: number, day: number): string {
  if (!Number.isInteger(year) || year < 0 || year > 9999) {
    throw new RangeError('Invalid date');
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseKey(key: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    throw new RangeError('Invalid date key');
  }
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const day = Number(key.slice(8, 10));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError('Invalid date key');
  }
  return date;
}

function utcDateKey(date: Date): string {
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function localDateKey(date: Date): string {
  return dateKey(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

export function startOfWeek(key: string): string {
  const date = parseKey(key);
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  return utcDateKey(date);
}

export function addDays(key: string, days: number): string {
  const date = parseKey(key);
  if (!Number.isInteger(days)) throw new RangeError('Invalid day offset');
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateKey(date);
}

export function weekRows(startKey: string, count: number): string[][] {
  parseKey(startKey);
  if (!Number.isInteger(count) || count < 0) throw new RangeError('Invalid week count');
  return Array.from({ length: count }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addDays(startKey, week * 7 + day)),
  );
}

/** A row belongs to the month containing its Wednesday. */
export function monthOfRow(weekStartKey: string): string {
  return addDays(weekStartKey, 3).slice(0, 7);
}

/** Prefer the first later event date, falling back to the last earlier date. */
export function nearestDayWithEvents(key: string, dates: ReadonlySet<string>): string | null {
  parseKey(key);
  let next: string | null = null;
  let previous: string | null = null;
  for (const date of dates) {
    parseKey(date);
    if (date > key && (next === null || date < next)) next = date;
    if (date < key && (previous === null || date > previous)) previous = date;
  }
  return next ?? previous;
}

/** Inclusive calendar-day distance from the local date of now. */
export function inWindow(key: string, now: Date, days: number = 30): boolean {
  const date = parseKey(key);
  const today = parseKey(localDateKey(now));
  if (!Number.isInteger(days) || days < 0) throw new RangeError('Invalid window size');
  return Math.abs(date.getTime() - today.getTime()) <= days * DAY_MS;
}
