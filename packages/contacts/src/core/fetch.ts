import {
  ContactsAuthError,
  ContactsFetchError,
  ContactsScopeError,
  SyncTokenExpiredError,
  type Person,
  type Source,
} from './types.js'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface FetchPeopleOptions {
  source: Source
  getToken: () => Promise<string>
  syncToken?: string
  fetch?: FetchFn
}

export interface FetchPeopleResult {
  people: Person[]
  nextSyncToken?: string
  deleted: string[]
}

const FIELDS = 'names,emailAddresses,photos'
const BASE = 'https://people.googleapis.com/v1'

export async function fetchPeople(opts: FetchPeopleOptions): Promise<FetchPeopleResult> {
  const doFetch: FetchFn = opts.fetch ?? ((u, i) => globalThis.fetch(u, i))
  const token = await opts.getToken()
  const people: Person[] = []
  const deleted: string[] = []
  let pageToken: string | undefined
  let nextSyncToken: string | undefined
  do {
    const isConn = opts.source === 'connections'
    const params = new URLSearchParams()
    params.set(isConn ? 'personFields' : 'readMask', FIELDS)
    params.set('requestSyncToken', 'true')
    params.set('pageSize', '1000')
    if (opts.syncToken) params.set('syncToken', opts.syncToken)
    if (pageToken) params.set('pageToken', pageToken)
    const path = isConn ? '/people/me/connections' : '/otherContacts'
    const res = await doFetch(`${BASE}${path}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) {
      if (res.status === 401) throw new ContactsAuthError()
      if (res.status === 403) throw new ContactsScopeError()
      if (res.status === 400 && opts.syncToken) throw new SyncTokenExpiredError()
      throw new ContactsFetchError(res.status)
    }
    const body = (await res.json()) as {
      connections?: Person[]
      otherContacts?: Person[]
      nextPageToken?: string
      nextSyncToken?: string
    }
    for (const p of (isConn ? body.connections : body.otherContacts) ?? []) {
      if (p.deleted || p.metadata?.deleted) {
        if (p.resourceName) deleted.push(p.resourceName)
      } else people.push(p)
    }
    if (body.nextSyncToken) nextSyncToken = body.nextSyncToken
    pageToken = body.nextPageToken
  } while (pageToken)
  return { people, nextSyncToken, deleted }
}
