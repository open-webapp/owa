/**
 * Date & time utilities for the Notes Diary app.
 */

/**
 * Check if a calendar date (year, month, day) is valid using Date.UTC roundtrip.
 * Month is 1-indexed (1-12), day is 1-indexed (1-31).
 */
export function isValidCalendarDate(y: number, m: number, d: number): boolean {
  // Month must be 1-12
  if (m < 1 || m > 12) {
    return false;
  }

  // Create a date with UTC and check if it roundtrips correctly
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * Parse a 3-part date token body (no '@') to ISO YYYY-MM-DD, or null if not a real date.
 *
 * Accepts:
 * - Exactly 2 separators, both '-' or both '/' (not mixed)
 * - Exactly 3 parts
 * - Format precedence:
 *   - If part 1 is 4 digits → ISO (Y-M-D)
 *   - Else if part 3 is 4 digits → US (M-D-Y)
 *   - Else → null (year not at position 1 or 3)
 * - Each part is 1-4 digits (rejects 2-digit years)
 * - Validates using isValidCalendarDate (leap years, invalid months/days, etc.)
 * - Returns zero-padded YYYY-MM-DD on success, null on any failure
 * - Rejects strings with whitespace in the token body
 */
export function parseFlexibleDate(input: string): string | null {
  // Reject if input contains whitespace
  if (/\s/.test(input)) {
    return null;
  }

  // Determine separator
  const dashCount = (input.match(/-/g) || []).length;
  const slashCount = (input.match(/\//g) || []).length;

  // Must have exactly 2 separators of the same type
  if ((dashCount === 2 && slashCount === 0) || (dashCount === 0 && slashCount === 2)) {
    const sep = dashCount === 2 ? '-' : '/';
    const parts = input.split(sep);

    // Must have exactly 3 parts
    if (parts.length !== 3) {
      return null;
    }

    // Each part must be 1-4 digits
    if (!parts.every(p => /^\d{1,4}$/.test(p))) {
      return null;
    }

    const [part1, part2, part3] = parts.map(p => parseInt(p, 10));

    // Determine format based on position of 4-digit number
    if (parts[0].length === 4) {
      // ISO format: Y-M-D
      const year = part1;
      const month = part2;
      const day = part3;

      if (!isValidCalendarDate(year, month, day)) {
        return null;
      }

      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    } else if (parts[2].length === 4) {
      // US format: M-D-Y
      const month = part1;
      const day = part2;
      const year = part3;

      if (!isValidCalendarDate(year, month, day)) {
        return null;
      }

      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    } else {
      // Year not at position 1 or 3
      return null;
    }
  }

  // Not exactly 2 separators of the same type
  return null;
}

export function getTodayISO(): string {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDate(iso: string): { weekday: string; md: string } {
  const date = new Date(iso + 'T00:00:00Z');

  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const weekday = weekdays[date.getUTCDay()];
  const month = months[date.getUTCMonth()];
  const day = date.getUTCDate();

  return {
    weekday: weekday,
    md: `${month} ${day}`
  };
}

export function formatDateWithYear(iso: string): string {
  const date = new Date(iso + 'T00:00:00Z');

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const month = months[date.getUTCMonth()];
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();

  return `${month} ${day}, ${year}`;
}

export function computeDaysAgo(iso: string, todayIso: string): number {
  const date = new Date(iso + 'T00:00:00Z');
  const today = new Date(todayIso + 'T00:00:00Z');

  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((today.getTime() - date.getTime()) / msPerDay);
}

export function formatMonthWithYear(iso: string): string {
  const date = new Date(iso + 'T00:00:00Z');

  const fullMonths = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const month = fullMonths[date.getUTCMonth()];
  const year = date.getUTCFullYear();

  return `${month} ${year}`;
}

export function formatTime(hhmm: string): string {
  const [hours, minutes] = hhmm.split(':').map(Number);

  let hour = hours;
  const isPM = hour >= 12;

  if (hour === 0) {
    hour = 12;
  } else if (hour > 12) {
    hour -= 12;
  }

  const period = isPM ? 'PM' : 'AM';
  return `${hour}:${String(minutes).padStart(2, '0')} ${period}`;
}

/**
 * Format the elapsed time between `ts` and `now` (both epoch ms) as a short
 * relative string: "just now", "5m ago", "3h ago", or "2d ago".
 * Negative deltas (ts in the future) are clamped to 0 → "just now".
 */
export function formatRelativeTime(ts: number, now: number): string {
  const d = Math.max(0, now - ts);

  if (d < 60_000) {
    return 'just now';
  }
  if (d < 3_600_000) {
    return `${Math.floor(d / 60_000)}m ago`;
  }
  if (d < 86_400_000) {
    return `${Math.floor(d / 3_600_000)}h ago`;
  }
  return `${Math.floor(d / 86_400_000)}d ago`;
}
