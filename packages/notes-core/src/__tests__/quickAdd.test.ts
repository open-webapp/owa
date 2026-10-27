import { describe, expect, it } from 'vitest'
import { buildQuickAddText, quickAddChipDates } from '../quickAdd.js'

describe('buildQuickAddText', () => {
  it('trims a draft and appends its ISO date token', () => {
    expect(buildQuickAddText('  Call Mom  ', '2026-10-09')).toBe('Call Mom @2026-10-09')
  })

  it('returns null for an empty or whitespace-only draft', () => {
    expect(buildQuickAddText('', '2026-10-09')).toBeNull()
    expect(buildQuickAddText('   ', '2026-10-09')).toBeNull()
  })

  it('preserves existing date tokens in the draft', () => {
    expect(buildQuickAddText('Pay rent @2026-10-01', '2026-10-09')).toBe('Pay rent @2026-10-01 @2026-10-09')
  })

  it('returns null for invalid or non-ISO dates', () => {
    expect(buildQuickAddText('Call Mom', '2026-02-30')).toBeNull()
    expect(buildQuickAddText('Call Mom', '10/09/2026')).toBeNull()
  })
})

describe('quickAddChipDates', () => {
  it('returns Today and Tomorrow when there are no sticky dates', () => {
    expect(quickAddChipDates('2026-10-04', [])).toEqual([
      { date: '2026-10-04', label: 'Today' },
      { date: '2026-10-05', label: 'Tomorrow' },
    ])
  })

  it('does not duplicate sticky dates that are today or tomorrow', () => {
    expect(quickAddChipDates('2026-10-04', ['2026-10-05', '2026-10-04', '2026-10-06'])).toEqual([
      { date: '2026-10-04', label: 'Today' },
      { date: '2026-10-05', label: 'Tomorrow' },
      { date: '2026-10-06', label: 'Tue Oct 6' },
    ])
  })

  it('sorts and deduplicates later sticky dates', () => {
    expect(quickAddChipDates('2026-10-04', ['2026-10-09', '2026-10-06', '2026-10-06', '2026-10-07'])).toEqual([
      { date: '2026-10-04', label: 'Today' },
      { date: '2026-10-05', label: 'Tomorrow' },
      { date: '2026-10-06', label: 'Tue Oct 6' },
      { date: '2026-10-07', label: 'Wed Oct 7' },
      { date: '2026-10-09', label: 'Fri Oct 9' },
    ])
  })

  it('keeps the earliest later sticky dates within the five-chip cap', () => {
    expect(quickAddChipDates('2026-10-04', ['2026-10-11', '2026-10-10', '2026-10-09', '2026-10-08', '2026-10-07', '2026-10-06'])).toEqual([
      { date: '2026-10-04', label: 'Today' },
      { date: '2026-10-05', label: 'Tomorrow' },
      { date: '2026-10-06', label: 'Tue Oct 6' },
      { date: '2026-10-07', label: 'Wed Oct 7' },
      { date: '2026-10-08', label: 'Thu Oct 8' },
    ])
  })

  it('formats later dates across a month and year rollover', () => {
    expect(quickAddChipDates('2026-12-31', ['2027-01-02'])).toEqual([
      { date: '2026-12-31', label: 'Today' },
      { date: '2027-01-01', label: 'Tomorrow' },
      { date: '2027-01-02', label: 'Sat Jan 2' },
    ])
  })

  it('ignores sticky dates on or before tomorrow', () => {
    expect(quickAddChipDates('2026-10-04', ['2026-10-03', '2026-10-04', '2026-10-05'])).toEqual([
      { date: '2026-10-04', label: 'Today' },
      { date: '2026-10-05', label: 'Tomorrow' },
    ])
  })
})
