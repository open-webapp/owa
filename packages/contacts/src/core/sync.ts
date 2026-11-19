import { fetchPeople, type FetchFn, type FetchPeopleResult } from './fetch.js'
import { personToRecord } from './normalize.js'
import type { StorageAdapter } from './storage.js'
import { SyncTokenExpiredError, type ContactRecord, type Person, type Source } from './types.js'

export interface SyncSourceOptions {
  accountId: string
  source: Source
  storage: StorageAdapter
  getToken: () => Promise<string>
  fetch?: FetchFn
  now?: () => number
}

/** Map people to records; people that no longer yield a record (e.g. lost all emails) are returned as drops. */
function toRecords(people: Person[], accountId: string, source: Source) {
  const records: ContactRecord[] = []
  const dropped: string[] = []
  for (const p of people) {
    const r = personToRecord(p, accountId, source)
    if (r) records.push(r)
    else if (p.resourceName) dropped.push(p.resourceName)
  }
  return { records, dropped }
}

/**
 * Sync one source of one account. Full sync (replaceSource) when there is no
 * stored token or the token expired; otherwise incremental (applyDelta).
 * All pages are fetched before any write, so a failure leaves the previous
 * records and sync record untouched. Errors (ContactsAuthError,
 * ContactsScopeError, ContactsFetchError) propagate.
 */
export async function syncSource(opts: SyncSourceOptions): Promise<void> {
  const { accountId, source, storage } = opts
  const now = opts.now ?? Date.now
  const fetchOpts = { source, getToken: opts.getToken, fetch: opts.fetch }
  const syncToken = (await storage.getSync(accountId, source))?.syncToken
  let result: FetchPeopleResult | undefined
  if (syncToken) {
    try {
      result = await fetchPeople({ ...fetchOpts, syncToken })
    } catch (err) {
      if (!(err instanceof SyncTokenExpiredError)) throw err
    }
  }
  const incremental = !!result
  result ??= await fetchPeople(fetchOpts)
  const { records, dropped } = toRecords(result.people, accountId, source)
  if (incremental) await storage.applyDelta(accountId, source, records, [...result.deleted, ...dropped])
  else await storage.replaceSource(accountId, source, records)
  await storage.putSync(accountId, source, { syncToken: result.nextSyncToken, lastSyncAt: now() })
}

export const SOURCES: readonly Source[] = ['connections', 'otherContacts']

export type SourceStatus = { ok: true } | { ok: false; error: unknown }
export type AccountSyncStatus = Record<Source, SourceStatus>

export type SyncAccountOptions = Omit<SyncSourceOptions, 'source'>

/**
 * Sync both sources of one account independently. A failing source keeps its
 * previous cache + sync record and does not block the other; never throws.
 */
export async function syncAccount(opts: SyncAccountOptions): Promise<AccountSyncStatus> {
  const settled = await Promise.allSettled(SOURCES.map((source) => syncSource({ ...opts, source })))
  const status = {} as AccountSyncStatus
  SOURCES.forEach((source, i) => {
    const r = settled[i]
    status[source] = r.status === 'fulfilled' ? { ok: true } : { ok: false, error: r.reason }
  })
  return status
}
