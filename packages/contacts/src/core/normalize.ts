import type { ContactRecord, Person, Source } from './types.js'

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
}

export function normalizePhotoUrl(url: string): string {
  return /=s\d+(-[a-z0-9-]+)?$/i.test(url)
    ? url.replace(/=s\d+(-[a-z0-9-]+)?$/i, '=s64')
    : `${url}=s64`
}

export function personToRecord(
  person: Person,
  accountId: string,
  source: Source,
): ContactRecord | undefined {
  const resourceName = person?.resourceName
  if (!resourceName) return undefined
  const emails = (person.emailAddresses ?? [])
    .map((e) => e.value?.trim().toLowerCase())
    .filter((v): v is string => !!v)
  if (emails.length === 0) return undefined
  const rec: ContactRecord = {
    key: `${accountId}:${resourceName}`,
    accountId,
    source,
    resourceName,
    emails,
    emailsNorm: emails.map(normalizeEmail),
  }
  const name = person.names?.find((n) => n.displayName?.trim())?.displayName?.trim()
  if (name) {
    rec.name = name
    rec.nameNorm = normalizeName(name)
  }
  const photo = person.photos?.find((p) => p.url && p.default !== true)
  if (photo?.url) rec.photoUrl = normalizePhotoUrl(photo.url)
  return rec
}
