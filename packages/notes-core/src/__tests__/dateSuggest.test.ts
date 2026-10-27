import { describe, expect, it } from 'vitest'
import { dateSuggest } from '../dateSuggest.js'
import { parseFlexibleDate } from '../dateUtils.js'

const today = '2026-10-03'

describe('dateSuggest', () => {
  it('suggests relative dates and today presets', () => {
    expect(dateSuggest('t', today)).toEqual([
      { label: 'Today', iso: '2026-10-03' },
      { label: 'Tomorrow', iso: '2026-10-04' },
    ])
    expect(dateSuggest('tom', today)).toEqual([
      { label: 'Tomorrow', iso: '2026-10-04' },
    ])
    expect(dateSuggest('today', today)).toEqual([
      { label: 'Today', iso: '2026-10-03' },
      { label: 'In a week', iso: '2026-10-10' },
      { label: 'In two weeks', iso: '2026-10-17' },
      { label: 'End of month', iso: '2026-10-31' },
      { label: 'End of year', iso: '2026-12-31' },
    ])
  })

  it('suggests every matching named-month day and year-month day', () => {
    const october = dateSuggest('oct', today)
    expect(october).toHaveLength(31)
    expect(october.map(({ iso }) => iso)).toEqual(
      Array.from({ length: 31 }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`),
    )
    expect(october[2]).toEqual({ label: 'Sat, Oct 3', iso: '2026-10-03' })

    const march = dateSuggest('2027-3', today)
    expect(march).toHaveLength(31)
    expect(march.map(({ iso }) => iso)).toEqual(
      Array.from({ length: 31 }, (_, index) => `2027-03-${String(index + 1).padStart(2, '0')}`),
    )
    expect(dateSuggest('12/25/26', today)).toEqual([
      { label: 'Fri, Dec 25', iso: '2026-12-25' },
    ])
  })

  it('handles abbreviated month, numeric month, partial-day, and year queries', () => {
    expect(dateSuggest('sep', today)).toHaveLength(30)
    expect(dateSuggest('1', today).map(({ iso }) => iso)).toEqual([
      '2026-10-01',
      '2026-11-01',
      '2026-12-01',
      '2026-01-01',
    ])
    expect(dateSuggest('12-2', today).map(({ iso }) => iso)).toEqual([
      '2026-12-02',
      '2026-12-20',
      '2026-12-21',
      '2026-12-22',
      '2026-12-23',
      '2026-12-24',
      '2026-12-25',
      '2026-12-26',
      '2026-12-27',
      '2026-12-28',
      '2026-12-29',
    ])
    expect(dateSuggest('2027', today)).toEqual([
      { label: 'Same day next year', iso: '2027-10-03' },
      { label: 'Start of year', iso: '2027-01-01' },
      { label: 'Mid-year', iso: '2027-07-01' },
      { label: 'End of year', iso: '2027-12-31' },
    ])
  })

  it('uses calendar-aware month ends and the supplied year for named months', () => {
    expect(dateSuggest('today', '2028-02-10')).toContainEqual({ label: 'End of month', iso: '2028-02-29' })
    expect(dateSuggest('today', '2027-02-10')).toContainEqual({ label: 'End of month', iso: '2027-02-28' })
    expect(dateSuggest('jan', '2030-05-01').map(({ iso }) => iso)).toEqual(
      Array.from({ length: 31 }, (_, index) => `2030-01-${String(index + 1).padStart(2, '0')}`),
    )
  })

  it('returns only dates accepted by the date parser', () => {
    for (const query of ['t', 'today', 'oct', '2027-3', '12-2', '2027']) {
      for (const { iso } of dateSuggest(query, today)) {
        expect(parseFlexibleDate(iso)).not.toBeNull()
      }
    }
  })

  it('handles exact and invalid input without throwing', () => {
    expect(dateSuggest('2027-05-17', today)).toEqual([
      { label: 'Use 2027-05-17', iso: '2027-05-17' },
    ])
    expect(dateSuggest('2027-02-30', today)).toEqual([])
    expect(dateSuggest('xyz', today)).toEqual([])
    expect(dateSuggest('13-45', today)).toEqual([])
    expect(dateSuggest('', today)).toEqual([])
  })
})
