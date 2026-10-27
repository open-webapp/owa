process.env.TZ = 'Asia/Kolkata';

import { describe, it, expect } from 'vitest';
import { formatDayHeader } from '../events.js';

describe('events date helpers in Asia/Kolkata (UTC+5:30)', () => {
  it('TZ is actually honored', () => {
    expect(new Date().getTimezoneOffset()).toBe(-330);
  });
  it("formatDayHeader('2026-10-28','2026-10-27') -> Tomorrow", () => {
    expect(formatDayHeader('2026-10-28', '2026-10-27')).toBe('Tomorrow · Oct 28');
  });
});
