import { describe, it, expect, vi } from 'vitest'
import { createMemoryStorage } from '../testing'
import { createContactsController } from '../core/controller'
import type { FetchFn } from '../core/fetch'
import type { Person } from '../core/types'

type Reply = { status: number; body?: unknown }
type Script = Record<string, Partial<Record<'connections' | 'otherContacts', Reply[]>>>

// Scripted fake keyed by bearer token (= account) and endpoint. Records every request.
function fakeFetch(script: Script) {
  const requests: string[] = []
  const fetch: FetchFn = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const token = String(headers.Authorization).replace('Bearer ', '')
    const source = url.includes('/otherContacts') ? 'otherContacts' : 'connections'
    requests.push(`${token}:${source}`)
    const reply = script[token]?.[source]?.shift()
    if (!reply) throw new Error(`unexpected request ${token} ${url}`)
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status })
  }
  return { fetch, requests }
}

const conn = (id: string, email: string, name?: string): Person => ({
  resourceName: `people/${id}`,
  emailAddresses: [{ value: email }],
  ...(name ? { names: [{ displayName: name }] } : {}),
})
const other = (id: string, email: string, name?: string): Person => ({
  ...conn(id, email, name),
  resourceName: `otherContacts/${id}`,
})
const ok = (source: 'connections' | 'otherContacts', people: Person[]): Reply => ({
  status: 200,
  body: { [source]: people, nextSyncToken: 'T' },
})
const account = (id: string) => ({ id, getToken: async () => id })

describe('createContactsController', () => {
  it('sync() runs every account x source and notifies subscribers', async () => {
    const { fetch, requests } = fakeFetch({
      a1: { connections: [ok('connections', [])], otherContacts: [ok('otherContacts', [])] },
      a2: { connections: [ok('connections', [])], otherContacts: [ok('otherContacts', [])] },
    })
    const c = createContactsController({ accounts: [account('a1'), account('a2')], storage: createMemoryStorage(), fetch })
    let calls = 0
    c.subscribe(() => calls++)
    await c.sync()
    expect(requests.sort()).toEqual(['a1:connections', 'a1:otherContacts', 'a2:connections', 'a2:otherContacts'])
    expect(calls).toBeGreaterThan(0)
  })

  it('lookupByEmail returns the synced contact', async () => {
    const { fetch } = fakeFetch({
      a1: { connections: [ok('connections', [conn('1', 'Ann@X.com', 'Ann')])], otherContacts: [ok('otherContacts', [])] },
    })
    const c = createContactsController({ accounts: [account('a1')], storage: createMemoryStorage(), fetch })
    await c.sync()
    expect(await c.lookupByEmail(' ann@x.com ')).toEqual({ name: 'Ann' })
    expect(await c.lookupByEmail('nobody@x.com')).toBeUndefined()
  })

  it('connections failing (500) does not block otherContacts; status is per source', async () => {
    const { fetch } = fakeFetch({
      a1: { connections: [{ status: 500 }], otherContacts: [ok('otherContacts', [other('9', 'oc@x.com', 'Oc')])] },
    })
    const c = createContactsController({ accounts: [account('a1')], storage: createMemoryStorage(), fetch })
    await c.sync()
    expect(await c.lookupByEmail('oc@x.com')).toEqual({ name: 'Oc' })
    const s = c.getStatus().accounts.a1
    expect(s?.otherContacts).toEqual({ ok: true })
    expect(s?.connections).toMatchObject({ ok: false, error: { name: 'ContactsFetchError', status: 500 } })
  })

  it('conflicting email across two accounts: first account in host order wins', async () => {
    const storage = createMemoryStorage()
    const { fetch } = fakeFetch({
      a1: { connections: [ok('connections', [conn('1', 'dup@x.com', 'From A1')])], otherContacts: [ok('otherContacts', [])] },
      a2: { connections: [ok('connections', [conn('1', 'dup@x.com', 'From A2')])], otherContacts: [ok('otherContacts', [])] },
    })
    await createContactsController({ accounts: [account('a1'), account('a2')], storage, fetch }).sync()
    const ab = createContactsController({ accounts: [account('a1'), account('a2')], storage, fetch })
    const ba = createContactsController({ accounts: [account('a2'), account('a1')], storage, fetch })
    expect(await ab.lookupByEmail('dup@x.com')).toEqual({ name: 'From A1' })
    expect(await ba.lookupByEmail('dup@x.com')).toEqual({ name: 'From A2' })
  })

  it('two concurrent sync() calls coalesce into one request set', async () => {
    const { fetch, requests } = fakeFetch({
      a1: { connections: [ok('connections', [])], otherContacts: [ok('otherContacts', [])] },
    })
    const c = createContactsController({ accounts: [account('a1')], storage: createMemoryStorage(), fetch })
    await Promise.all([c.sync(), c.sync()])
    expect(requests.sort()).toEqual(['a1:connections', 'a1:otherContacts'])
  })

  it('missing scope (403) surfaces ContactsScopeError in status; sync() does not throw', async () => {
    const { fetch } = fakeFetch({ a1: { connections: [{ status: 403 }], otherContacts: [{ status: 403 }] } })
    const c = createContactsController({ accounts: [account('a1')], storage: createMemoryStorage(), fetch })
    await expect(c.sync()).resolves.toBeUndefined()
    const s = c.getStatus().accounts.a1
    expect(s?.connections).toMatchObject({ ok: false, error: { name: 'ContactsScopeError' } })
    expect(s?.otherContacts).toMatchObject({ ok: false, error: { name: 'ContactsScopeError' } })
  })

  it('a throwing subscriber neither rejects sync() nor starves other subscribers', async () => {
    const { fetch } = fakeFetch({
      a1: { connections: [ok('connections', [])], otherContacts: [ok('otherContacts', [])] },
    })
    const c = createContactsController({ accounts: [account('a1')], storage: createMemoryStorage(), fetch })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let called = false
    c.subscribe(() => {
      throw new Error('boom')
    })
    c.subscribe(() => (called = true))
    await expect(c.sync()).resolves.toBeUndefined()
    expect(called).toBe(true)
    err.mockRestore()
  })

  it('after unsubscribe, a later sync does not call the listener', async () => {
    const { fetch } = fakeFetch({
      a1: { connections: [ok('connections', []), ok('connections', [])], otherContacts: [ok('otherContacts', []), ok('otherContacts', [])] },
    })
    const c = createContactsController({ accounts: [account('a1')], storage: createMemoryStorage(), fetch })
    let calls = 0
    const off = c.subscribe(() => calls++)
    await c.sync()
    const before = calls
    off()
    await c.sync()
    expect(calls).toBe(before)
  })

  it('dispose() drops listeners and makes later sync() a no-op', async () => {
    const { fetch, requests } = fakeFetch({})
    const c = createContactsController({ accounts: [account('a1')], storage: createMemoryStorage(), fetch })
    let calls = 0
    c.subscribe(() => calls++)
    c.dispose()
    await expect(c.sync()).resolves.toBeUndefined()
    expect(requests).toEqual([])
    expect(calls).toBe(0)
  })
})
