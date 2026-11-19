import { describe, expect, it, vi } from 'vitest'
import { fetchPeople } from '../fetch.js'
import {
  ContactsAuthError,
  ContactsFetchError,
  ContactsScopeError,
  SyncTokenExpiredError,
} from '../types.js'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const getToken = async () => 'tok'

describe('fetchPeople', () => {
  it('follows nextPageToken for connections and sends auth + masks', async () => {
    const urls: string[] = []
    const headers: string[] = []
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url)
      headers.push(new Headers(init?.headers).get('authorization') ?? '')
      return urls.length === 1
        ? json({ connections: [{ resourceName: 'people/1' }], nextPageToken: 'p2' })
        : json({ connections: [{ resourceName: 'people/2' }], nextSyncToken: 'S1' })
    })
    const r = await fetchPeople({ source: 'connections', getToken, fetch: fetchFn as never })
    expect(r.people.map((p) => p.resourceName)).toEqual(['people/1', 'people/2'])
    expect(r.nextSyncToken).toBe('S1')
    expect(r.deleted).toEqual([])
    const u1 = new URL(urls[0])
    expect(u1.pathname).toBe('/v1/people/me/connections')
    expect(u1.searchParams.get('personFields')).toBe('names,emailAddresses,photos')
    expect(u1.searchParams.get('requestSyncToken')).toBe('true')
    expect(new URL(urls[1]).searchParams.get('pageToken')).toBe('p2')
    expect(headers).toEqual(['Bearer tok', 'Bearer tok'])
  })

  it('uses readMask for otherContacts', async () => {
    const fetchFn = vi.fn(async () => json({ otherContacts: [{ resourceName: 'otherContacts/1' }], nextSyncToken: 'O' }))
    const r = await fetchPeople({ source: 'otherContacts', getToken, fetch: fetchFn as never })
    const u = new URL(fetchFn.mock.calls[0][0] as string)
    expect(u.pathname).toBe('/v1/otherContacts')
    expect(u.searchParams.get('readMask')).toBe('names,emailAddresses,photos')
    expect(r.people).toHaveLength(1)
    expect(r.nextSyncToken).toBe('O')
  })

  it('incremental sends syncToken and returns deleted resourceNames', async () => {
    const fetchFn = vi.fn(async () =>
      json({
        connections: [
          { resourceName: 'people/1', emailAddresses: [{ value: 'a@b.c' }] },
          { resourceName: 'people/2', metadata: { deleted: true } },
          { resourceName: 'people/3', deleted: true },
        ],
        nextSyncToken: 'S2',
      }),
    )
    const r = await fetchPeople({ source: 'connections', syncToken: 'S1', getToken, fetch: fetchFn as never })
    expect(new URL(fetchFn.mock.calls[0][0] as string).searchParams.get('syncToken')).toBe('S1')
    expect(r.people.map((p) => p.resourceName)).toEqual(['people/1'])
    expect(r.deleted).toEqual(['people/2', 'people/3'])
  })

  it.each([
    [401, ContactsAuthError],
    [403, ContactsScopeError],
  ])('maps %i to typed error', async (status, Cls) => {
    const fetchFn = vi.fn(async () => json({}, status))
    await expect(fetchPeople({ source: 'connections', getToken, fetch: fetchFn as never })).rejects.toBeInstanceOf(Cls)
  })

  it('maps 400 with syncToken to SyncTokenExpiredError, 400 without to fetch error', async () => {
    const fetchFn = vi.fn(async () => json({}, 400))
    await expect(
      fetchPeople({ source: 'connections', syncToken: 'old', getToken, fetch: fetchFn as never }),
    ).rejects.toBeInstanceOf(SyncTokenExpiredError)
    await expect(
      fetchPeople({ source: 'connections', getToken, fetch: fetchFn as never }),
    ).rejects.toMatchObject({ name: 'ContactsFetchError', status: 400 })
  })

  it('maps 500 to ContactsFetchError with status', async () => {
    const fetchFn = vi.fn(async () => json({}, 500))
    const err = await fetchPeople({ source: 'connections', getToken, fetch: fetchFn as never }).catch((e) => e)
    expect(err).toBeInstanceOf(ContactsFetchError)
    expect(err.status).toBe(500)
  })

  it('propagates getToken rejection without any request', async () => {
    const boom = new ContactsAuthError('nope')
    const fetchFn = vi.fn()
    await expect(
      fetchPeople({ source: 'connections', getToken: () => Promise.reject(boom), fetch: fetchFn as never }),
    ).rejects.toBe(boom)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
