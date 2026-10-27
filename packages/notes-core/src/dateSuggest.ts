export type DateSuggestion = { label: string; iso: string }

const months = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

const dayLabel = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isoDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function validDate(year: number, month: number, day: number) {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
}

function parsedIso(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [, year, month, day] = match
  const result = { year: Number(year), month: Number(month), day: Number(day) }
  return validDate(result.year, result.month, result.day) ? result : null
}

function displayDate(iso: string) {
  const { year, month, day } = parsedIso(iso)!
  return dayLabel.format(new Date(Date.UTC(year, month - 1, day)))
}

function daysForMonth(year: number, month: number, dayPrefix = ''): DateSuggestion[] {
  return Array.from({ length: daysInMonth(year, month) }, (_, index) => index + 1)
    .filter((day) => String(day).startsWith(dayPrefix))
    .map((day) => {
      const iso = isoDate(year, month, day)
      return { label: displayDate(iso), iso }
    })
}

function addDays(iso: string, days: number) {
  const { year, month, day } = parsedIso(iso)!
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

export function dateSuggest(query: string, today: string): DateSuggestion[] {
  const current = parsedIso(today)
  if (!current) return []

  const input = query.trim().toLowerCase()
  if (!input) return []

  const exactIso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input)
  if (exactIso) {
    const parsed = parsedIso(input)
    return parsed ? [{ label: `Use ${input}`, iso: input }] : []
  }

  const shortDate = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(input)
  if (shortDate) {
    const [, month, day, year] = shortDate
    const iso = isoDate(2000 + Number(year), Number(month), Number(day))
    return parsedIso(iso) ? [{ label: displayDate(iso), iso }] : []
  }

  if (/^\d{4}$/.test(input)) {
    const year = Number(input)
    const sameDay = Math.min(current.day, daysInMonth(year, current.month))
    return [
      { label: 'Same day next year', iso: isoDate(year, current.month, sameDay) },
      { label: 'Start of year', iso: isoDate(year, 1, 1) },
      { label: 'Mid-year', iso: isoDate(year, 7, 1) },
      { label: 'End of year', iso: isoDate(year, 12, 31) },
    ]
  }

  const yearMonth = /^(\d{4})-(\d{1,2})$/.exec(input)
  if (yearMonth) {
    const [, year, month] = yearMonth
    const numericMonth = Number(month)
    return numericMonth >= 1 && numericMonth <= 12 ? daysForMonth(Number(year), numericMonth) : []
  }

  const monthDay = /^(\d{1,2})[-/](\d{1,2})$/.exec(input)
  if (monthDay) {
    const [, month, day] = monthDay
    const numericMonth = Number(month)
    return numericMonth >= 1 && numericMonth <= 12
      ? daysForMonth(current.year, numericMonth, day)
      : []
  }

  if (input === 'today') {
    const endOfMonth = isoDate(current.year, current.month, daysInMonth(current.year, current.month))
    return [
      { label: 'Today', iso: today },
      { label: 'In a week', iso: addDays(today, 7) },
      { label: 'In two weeks', iso: addDays(today, 14) },
      { label: 'End of month', iso: endOfMonth },
      { label: 'End of year', iso: isoDate(current.year, 12, 31) },
    ]
  }

  const presets: DateSuggestion[] = [
    { label: 'Today', iso: today },
    { label: 'Tomorrow', iso: addDays(today, 1) },
  ]
  const presetMatches = presets.filter(({ label }) => label.toLowerCase().startsWith(input))
  if (presetMatches.length) return presetMatches.slice(0, 5)

  const namedMonth = months.findIndex((month) => month.startsWith(input))
  if (namedMonth !== -1) return daysForMonth(current.year, namedMonth + 1)

  if (/^\d{1,2}$/.test(input)) {
    const matchingMonths = Array.from({ length: 12 }, (_, index) => ((current.month - 1 + index) % 12) + 1)
      .filter((month) => String(month).startsWith(input))
    return matchingMonths.map((month) => {
      const iso = isoDate(current.year, month, 1)
      return { label: displayDate(iso), iso }
    })
  }

  return []
}
