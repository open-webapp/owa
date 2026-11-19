import { describe, it, expect } from 'vitest'
import { createMemoryStorage } from '../testing'
import { syncAccount, syncSource } from '../core/sync'
import type { FetchFn } from '../core/fetch'
import { ContactsAuthError, ContactsFetchError, ContactsScopeError, type Person } from '../core/types'

type Reply = { status: number; body?: unknown }

// Scripted fake: each request pops the next reply for that endpoint.
function fakeFetch(script: Partial<Record<'connections' | 'otherContacts', Reply[]>>): FetchFn {
  return async (url) => {
    const key = url.includes('/otherContacts') ? 'otherContacts' : 'connections'
    const reply = script[key]?.shift()
    if (!reply) throw new Error(`unexpected request ${url}`)
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status })
  }
}

const person = (id: string, email: string, name?: string): Person => ({
  resourceName: `people/${id}`,
  emailAddresses: [{ value: email }],
  ...(name ? { names: [{ displayName: name }] } : {}),
})

const getToken = async () => 'tok'

describe('syncSource', () => {
  it('first sync is a full sync: replaces source, saves token + lastSyncAt', async () => {
    const storage = createMemoryStorage()
    const fetch = fakeFetch({
      connections: [{ status: 200, body: { connections: [person('1', 'A@x.com', 'Ann')], nextSyncToken: 'S1' } }],
    })
    await syncSource({ accountId: 'acc', source: 'connections', storage, getToken, fetch, now: () => 1000 })
    const hits = await storage.getByEmail('a@x.com')
    expect(hits.map((r) => [r.accountId, r.source, r.name])).toEqual([['acc', 'connections', 'Ann']])
    expect(await storage.getSync('acc', 'connections')).toEqual({ syncToken: 'S1', lastSyncAt: 1000 })
  })

  it('second sync is incremental with the stored token: delta upserts, keeps untouched records', async () => {
    const storage = createMemoryStorage()
    const urls: string[] = []
    const inner = fakeFetch({
      connections: [
        { status: 200, body: { connections: [person('1', 'a@x.com', 'Ann'), person('2', 'b@x.com')], nextSyncToken: 'S1' } },
        { status: 200, body: { connections: [person('3', 'c@x.com', 'Cy')], nextSyncToken: 'S2' } },
      ],
    })
    const fetch: FetchFn = (u, i) => (urls.push(u), inner(u, i))
    await syncSource({ accountId: 'acc', source: 'connections', storage, getToken, fetch, now: () => 1 })
    await syncSource({ accountId: 'acc', source: 'connections', storage, getToken, fetch, now: () => 2 })
    expect(new URL(urls[1]).searchParams.get('syncToken')).toBe('S1')
    expect((await storage.listAll()).map((r) => r.resourceName).sort()).toEqual(['people/1', 'people/2', 'people/3'])
    expect(await storage.getSync('acc', 'connections')).toEqual({ syncToken: 'S2', lastSyncAt: 2 })
  })

  it('incremental sync removes deleted people', async () => {
    const storage = createMemoryStorage()
    const fetch = fakeFetch({
      otherContacts: [
        { status: 200, body: { otherContacts: [{ ...person('1', 'a@x.com'), resourceName: 'otherContacts/1' }], nextSyncToken: 'S1' } },
        { status: 200, body: { otherContacts: [{ resourceName: 'otherContacts/1', metadata: { deleted: true } }], nextSyncToken: 'S2' } },
      ],
    })
    await syncSource({ accountId: 'acc', source: 'otherContacts', storage, getToken, fetch })
    expect(await storage.getByEmail('a@x.com')).toHaveLength(1)
    await syncSource({ accountId: 'acc', source: 'otherContacts', storage, getToken, fetch })
    expect(await storage.getByEmail('a@x.com')).toEqual([])
  })

  it('expired sync token (400) -> full resync replaces the source and stores the new token', async () => {
    const storage = createMemoryStorage()
    const urls: string[] = []
    const inner = fakeFetch({
      connections: [
        { status: 200, body: { connections: [person('1', 'a@x.com'), person('2', 'b@x.com')], nextSyncToken: 'OLD' } },
        { status: 400, body: { error: { status: 'FAILED_PRECONDITION' } } },
        { status: 200, body: { connections: [person('2', 'b@x.com', 'Bo')], nextSyncToken: 'NEW' } },
      ],
    })
    const fetch: FetchFn = (u, i) => (urls.push(u), inner(u, i))
    await syncSource({ accountId: 'acc', source: 'connections', storage, getToken, fetch, now: () => 1 })
    await syncSource({ accountId: 'acc', source: 'connections', storage, getToken, fetch, now: () => 9 })
    expect(new URL(urls[2]).searchParams.has('syncToken')).toBe(false)
    expect((await storage.listAll()).map((r) => [r.resourceName, r.name])).toEqual([['people/2', 'Bo']])
    expect(await storage.getSync('acc', 'connections')).toEqual({ syncToken: 'NEW', lastSyncAt: 9 })
  })

  it('incremental change that drops all emails removes the record', async () => {
    const storage = createMemoryStorage()
    const fetch = fakeFetch({
      connections: [
        { status: 200, body: { connections: [person('1', 'a@x.com')], nextSyncToken: 'S1' } },
        { status: 200, body: { connections: [{ resourceName: 'people/1', names: [{ displayName: 'No Mail' }] }], nextSyncToken: 'S2' } },
      ],
    })
    await syncSource({ accountId: 'acc', source: 'connections', storage, getToken, fetch })
    await syncSource({ accountId: 'acc', source: 'connections', storage, getToken, fetch })
    expect(await storage.listAll()).toEqual([])
  })

  it.each([
    [401, ContactsAuthError],
    [403, ContactsScopeError],
  ])('HTTP %i throws typed error and keeps previous cache + sync record', async (status, ErrorType) => {
    const storage = createMemoryStorage()
    const fetch = fakeFetch({
      connections: [
        { status: 200, body: { connections: [person('1', 'a@x.com', 'Ann')], nextSyncToken: 'S1' } },
        { status },
      ],
    })
    await syncSource({ accountId: 'acc', source: 'connections', storage, getToken, fetch, now: () => 5 })
    const before = await storage.listAll()
    await expect(
      syncSource({ accountId: 'acc', source: 'connections', storage, getToken, fetch, now: () => 6 }),
    ).rejects.toBeInstanceOf(ErrorType)
    expect(await storage.listAll()).toEqual(before)
    expect(await storage.getSync('acc', 'connections')).toEqual({ syncToken: 'S1', lastSyncAt: 5 })
  })

  it('failure mid-pagination writes nothing (atomic per source)', async () => {
    const storage = createMemoryStorage()
    const fetch = fakeFetch({
      connections: [
        { status: 200, body: { connections: [person('1', 'a@x.com')], nextSyncToken: 'S1' } },
        { status: 200, body: { connections: [person('2', 'b@x.com')], nextPageToken: 'P2' } },
        { status: 500 },
      ],
    })
    await syncSource({ accountId: 'acc', source: 'connections', storage, getToken, fetch, now: () => 5 })
    await expect(
      syncSource({ accountId: 'acc', source: 'connections', storage, getToken, fetch, now: () => 6 }),
    ).rejects.toBeInstanceOf(ContactsFetchError)
    expect((await storage.listAll()).map((r) => r.resourceName)).toEqual(['people/1'])
    expect(await storage.getByEmail('b@x.com')).toEqual([])
    expect(await storage.getSync('acc', 'connections')).toEqual({ syncToken: 'S1', lastSyncAt: 5 })
  })
})

describe('syncAccount', () => {
  it('one source failing does not block the other; per-source status reported', async () => {
    const storage = createMemoryStorage()
    const fetch = fakeFetch({
      connections: [{ status: 403 }],
      otherContacts: [{ status: 200, body: { otherContacts: [{ ...person('9', 'o@x.com'), resourceName: 'otherContacts/9' }], nextSyncToken: 'O1' } }],
    })
    const status = await syncAccount({ accountId: 'acc', storage, getToken, fetch, now: () => 3 })
    expect(status.connections.ok).toBe(false)
    expect(status.connections.ok === false && status.connections.error).toBeInstanceOf(ContactsScopeError)
    expect(status.otherContacts).toEqual({ ok: true })
    expect((await storage.getByEmail('o@x.com')).map((r) => r.source)).toEqual(['otherContacts'])
    expect(await storage.getSync('acc', 'connections')).toBeUndefined()
    expect(await storage.getSync('acc', 'otherContacts')).toEqual({ syncToken: 'O1', lastSyncAt: 3 })
  })

  it('accounts are isolated: syncing one account leaves another untouched', async () => {
    const storage = createMemoryStorage()
    const full = (email: string, tok: string) =>
      fakeFetch({
        connections: [{ status: 200, body: { connections: [person('1', email)], nextSyncToken: tok } }],
        otherContacts: [{ status: 200, body: { nextSyncToken: tok } }],
      })
    await syncAccount({ accountId: 'A', storage, getToken, fetch: full('a@x.com', 'TA') })
    await syncAccount({ accountId: 'B', storage, getToken, fetch: full('b@x.com', 'TB') })
    expect((await storage.listAll()).map((r) => [r.accountId, r.resourceName]).sort()).toEqual([
      ['A', 'people/1'],
      ['B', 'people/1'],
    ])
    expect((await storage.getSync('A', 'connections'))?.syncToken).toBe('TA')
    expect((await storage.getSync('B', 'connections'))?.syncToken).toBe('TB')
  })
})
