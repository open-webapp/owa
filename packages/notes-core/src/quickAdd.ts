const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function parseIsoDate(value: string): Date | null {
  const match = ISO_DATE_PATTERN.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }

  return date
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function formatDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value

  return `${value('weekday')} ${value('month')} ${value('day')}`
}

export function buildQuickAddText(draft: string, isoDate: string): string | null {
  const trimmed = draft.trim()
  if (!trimmed || !parseIsoDate(isoDate)) return null

  return `${trimmed} @${isoDate}`
}

export function quickAddChipDates(
  today: string,
  upcomingStickyDates: string[],
): { date: string; label: string }[] {
  const todayDate = parseIsoDate(today)
  if (!todayDate) return []

  const tomorrowDate = new Date(todayDate)
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1)
  const tomorrow = toIsoDate(tomorrowDate)

  const laterDates = [...new Set(upcomingStickyDates)]
    .filter((date) => parseIsoDate(date) !== null && date > tomorrow)
    .sort()
    .slice(0, 3)

  return [
    { date: today, label: 'Today' },
    { date: tomorrow, label: 'Tomorrow' },
    ...laterDates.map((date) => ({ date, label: formatDate(parseIsoDate(date)!) })),
  ]
}
