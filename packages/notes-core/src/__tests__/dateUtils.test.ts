import { describe, it, expect } from 'vitest';
import { parseFlexibleDate, isValidCalendarDate, computeDaysAgo, formatMonthWithYear, formatRelativeTime } from '../dateUtils.js';

describe('computeDaysAgo', () => {
  it('returns 0 for the same date', () => {
    expect(computeDaysAgo('2026-08-22', '2026-08-22')).toBe(0);
  });

  it('returns 29 for 29 days before today', () => {
    expect(computeDaysAgo('2026-07-24', '2026-08-22')).toBe(29);
  });

  it('returns 30 for 30 days before today', () => {
    expect(computeDaysAgo('2026-07-23', '2026-08-22')).toBe(30);
  });

  it('returns 364 for Jan 1 to Dec 31 in a non-leap year', () => {
    expect(computeDaysAgo('2026-01-01', '2026-12-31')).toBe(364);
  });
});

describe('formatMonthWithYear', () => {
  it('formats a mid-year date', () => {
    expect(formatMonthWithYear('2026-07-15')).toBe('July 2026');
  });

  it('formats January 1st', () => {
    expect(formatMonthWithYear('2026-01-01')).toBe('January 2026');
  });

  it('formats December 31st of a leap year', () => {
    expect(formatMonthWithYear('2024-12-31')).toBe('December 2024');
  });
});

describe('formatRelativeTime', () => {
  const now = 1_700_000_000_000;

  it('returns "just now" for the same instant', () => {
    expect(formatRelativeTime(now, now)).toBe('just now');
  });

  it('returns "just now" just under a minute', () => {
    expect(formatRelativeTime(now - 59_000, now)).toBe('just now');
  });

  it('returns "1m ago" at exactly one minute', () => {
    expect(formatRelativeTime(now - 60_000, now)).toBe('1m ago');
  });

  it('returns "59m ago" just under an hour', () => {
    expect(formatRelativeTime(now - 59 * 60_000, now)).toBe('59m ago');
  });

  it('returns "1h ago" at exactly one hour', () => {
    expect(formatRelativeTime(now - 60 * 60_000, now)).toBe('1h ago');
  });

  it('returns "23h ago" just under a day', () => {
    expect(formatRelativeTime(now - 23 * 3_600_000, now)).toBe('23h ago');
  });

  it('returns "1d ago" at exactly one day', () => {
    expect(formatRelativeTime(now - 24 * 3_600_000, now)).toBe('1d ago');
  });

  it('returns "10d ago" for ten days', () => {
    expect(formatRelativeTime(now - 10 * 86_400_000, now)).toBe('10d ago');
  });

  it('returns "just now" for a future timestamp', () => {
    expect(formatRelativeTime(now + 5_000, now)).toBe('just now');
  });
});

describe('isValidCalendarDate', () => {
  it('should validate valid calendar dates', () => {
    expect(isValidCalendarDate(2026, 8, 17)).toBe(true);
    expect(isValidCalendarDate(2024, 2, 29)).toBe(true); // leap year
    expect(isValidCalendarDate(2026, 1, 1)).toBe(true);
  });

  it('should reject invalid months', () => {
    expect(isValidCalendarDate(2026, 0, 1)).toBe(false);
    expect(isValidCalendarDate(2026, 13, 1)).toBe(false);
  });

  it('should reject invalid days', () => {
    expect(isValidCalendarDate(2026, 1, 0)).toBe(false);
    expect(isValidCalendarDate(2026, 2, 30)).toBe(false);
  });

  it('should reject leap year dates on non-leap years', () => {
    expect(isValidCalendarDate(2026, 2, 29)).toBe(false);
  });
});

describe('parseFlexibleDate', () => {
  describe('ISO format (year first)', () => {
    it('should parse YYYY-MM-DD format', () => {
      expect(parseFlexibleDate('2026-08-17')).toBe('2026-08-17');
    });

    it('should parse YYYY/MM/DD format', () => {
      expect(parseFlexibleDate('2026/08/17')).toBe('2026-08-17');
    });

    it('should parse single-digit month and day with dashes', () => {
      expect(parseFlexibleDate('2026-8-7')).toBe('2026-08-07');
    });

    it('should parse single-digit month and day with slashes', () => {
      expect(parseFlexibleDate('2026/8/7')).toBe('2026-08-07');
    });

    it('should handle leading zeros in month and day', () => {
      expect(parseFlexibleDate('2026-01-05')).toBe('2026-01-05');
      expect(parseFlexibleDate('2026/01/05')).toBe('2026-01-05');
    });
  });

  describe('US format (year last)', () => {
    it('should parse MM-DD-YYYY format', () => {
      expect(parseFlexibleDate('08-17-2026')).toBe('2026-08-17');
    });

    it('should parse M/D/YYYY format', () => {
      expect(parseFlexibleDate('8/17/2026')).toBe('2026-08-17');
    });

    it('should parse MM/DD/YYYY format', () => {
      expect(parseFlexibleDate('08/17/2026')).toBe('2026-08-17');
    });

    it('should parse M-D-YYYY format', () => {
      expect(parseFlexibleDate('8-17-2026')).toBe('2026-08-17');
    });

    it('should parse M/D/YYYY with single-digit month and day', () => {
      expect(parseFlexibleDate('1/5/2026')).toBe('2026-01-05');
    });
  });

  describe('Ambiguity rule (US before EU)', () => {
    it('should interpret ambiguous dates as US (month-day-year) when year is last', () => {
      // 08-09-2026: could be Aug 9 (US) or Sep 8 (EU), should be US
      expect(parseFlexibleDate('08-09-2026')).toBe('2026-08-09');
    });

    it('should interpret ambiguous dates with slashes as US when year is last', () => {
      expect(parseFlexibleDate('08/09/2026')).toBe('2026-08-09');
    });

    it('should interpret ambiguous dates as ISO when year is first', () => {
      // 2026-08-09: year first, so definitely ISO (year-month-day)
      expect(parseFlexibleDate('2026-08-09')).toBe('2026-08-09');
    });
  });

  describe('Short form rejection', () => {
    it('should reject 2-part dates', () => {
      expect(parseFlexibleDate('8/17')).toBeNull();
      expect(parseFlexibleDate('2026-08')).toBeNull();
    });

    it('should reject single-part dates', () => {
      expect(parseFlexibleDate('17')).toBeNull();
      expect(parseFlexibleDate('2026')).toBeNull();
    });

    it('should reject dates with only 1 separator', () => {
      expect(parseFlexibleDate('08-17')).toBeNull();
      expect(parseFlexibleDate('2026/08')).toBeNull();
    });
  });

  describe('Calendar validation', () => {
    it('should reject February 30', () => {
      expect(parseFlexibleDate('2026-02-30')).toBeNull();
    });

    it('should reject month 13', () => {
      expect(parseFlexibleDate('2026-13-01')).toBeNull();
    });

    it('should reject day 45 in US format', () => {
      expect(parseFlexibleDate('13-45-2026')).toBeNull();
    });

    it('should reject month 0', () => {
      expect(parseFlexibleDate('2026-00-10')).toBeNull();
    });

    it('should reject day 0', () => {
      expect(parseFlexibleDate('2026-01-00')).toBeNull();
    });

    it('should accept leap year February 29', () => {
      expect(parseFlexibleDate('2024-02-29')).toBe('2024-02-29');
      expect(parseFlexibleDate('02-29-2024')).toBe('2024-02-29');
    });

    it('should reject non-leap year February 29', () => {
      expect(parseFlexibleDate('2026-02-29')).toBeNull();
      expect(parseFlexibleDate('02-29-2026')).toBeNull();
    });

    it('should validate other edge cases', () => {
      expect(parseFlexibleDate('2026-01-31')).toBe('2026-01-31');
      expect(parseFlexibleDate('2026-04-30')).toBe('2026-04-30');
      expect(parseFlexibleDate('2026-04-31')).toBeNull(); // April has 30 days
    });
  });

  describe('Mixed separators', () => {
    it('should reject mixed dash and slash', () => {
      expect(parseFlexibleDate('2026-08/17')).toBeNull();
      expect(parseFlexibleDate('2026/08-17')).toBeNull();
      expect(parseFlexibleDate('08-17/2026')).toBeNull();
    });

    it('should reject 3+ separators', () => {
      expect(parseFlexibleDate('2026-08-17-12')).toBeNull();
      expect(parseFlexibleDate('2026/08/17/12')).toBeNull();
    });
  });

  describe('Junk and empty input', () => {
    it('should reject non-numeric input', () => {
      expect(parseFlexibleDate('not-a-date')).toBeNull();
      expect(parseFlexibleDate('abc-def-ghij')).toBeNull();
    });

    it('should reject empty string', () => {
      expect(parseFlexibleDate('')).toBeNull();
    });

    it('should reject only separators', () => {
      expect(parseFlexibleDate('-')).toBeNull();
      expect(parseFlexibleDate('--')).toBeNull();
      expect(parseFlexibleDate('-/-')).toBeNull();
    });

    it('should reject dates with only separators and spaces', () => {
      expect(parseFlexibleDate('- - ')).toBeNull();
    });
  });

  describe('2-digit year rejection', () => {
    it('should reject 2-digit years', () => {
      expect(parseFlexibleDate('08-17-26')).toBeNull();
      expect(parseFlexibleDate('26-08-17')).toBeNull();
    });

    it('should reject 3-digit years', () => {
      expect(parseFlexibleDate('202-08-17')).toBeNull();
      expect(parseFlexibleDate('08-17-202')).toBeNull();
    });
  });

  describe('Whitespace handling', () => {
    it('should reject input with spaces', () => {
      expect(parseFlexibleDate('2026 - 08 - 17')).toBeNull();
      expect(parseFlexibleDate(' 2026-08-17')).toBeNull();
      expect(parseFlexibleDate('2026-08-17 ')).toBeNull();
    });

    it('should reject input with tabs', () => {
      expect(parseFlexibleDate('2026\t08\t17')).toBeNull();
    });

    it('should reject input with newlines', () => {
      expect(parseFlexibleDate('2026\n08\n17')).toBeNull();
    });
  });

  describe('Edge cases', () => {
    it('should handle dates at year boundaries', () => {
      expect(parseFlexibleDate('2026-01-01')).toBe('2026-01-01');
      expect(parseFlexibleDate('2026-12-31')).toBe('2026-12-31');
    });

    it('should handle dates with all same digits', () => {
      expect(parseFlexibleDate('1111-11-11')).toBe('1111-11-11');
    });

    it('should pad single-digit month and day correctly', () => {
      expect(parseFlexibleDate('2026-1-1')).toBe('2026-01-01');
      expect(parseFlexibleDate('1-1-2026')).toBe('2026-01-01');
    });

    it('should handle year 0000', () => {
      // This is technically not a valid calendar date but let's check the behavior
      expect(parseFlexibleDate('0000-01-01')).toBeNull();
    });

    it('should handle very large years', () => {
      expect(parseFlexibleDate('9999-12-31')).toBe('9999-12-31');
    });

    it('should handle non-4-digit years when they are not at positions 1 or 3', () => {
      expect(parseFlexibleDate('08-2026-17')).toBeNull(); // Year in middle
    });
  });
});
