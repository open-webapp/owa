import { describe, it, expect } from 'vitest'
import { createMemoryStorage } from '../testing'
import type { ContactRecord, Source } from '../core/types'

const rec = (accountId: string, resourceName: string, emails: string[], source: Source = 'connections'): ContactRecord => ({
  key: `${accountId}|${resourceName}`, accountId, source, resourceName, emails, emailsNorm: emails.map((e) => e.toLowerCase()),
})

describe('memoryStorage', () => {
  it('replaceSource then getByEmail', async () => {
    const s = createMemoryStorage()
    await s.replaceSource('a', 'connections', [rec('a', 'people/1', ['x@y.com'])])
    expect((await s.getByEmail('x@y.com')).map((r) => r.resourceName)).toEqual(['people/1'])
    await s.replaceSource('a', 'connections', [])
    expect(await s.getByEmail('x@y.com')).toEqual([])
  })
  it('applyDelta upserts and deletes', async () => {
    const s = createMemoryStorage()
    await s.replaceSource('a', 'connections', [rec('a', 'people/1', ['x@y.com']), rec('a', 'people/2', ['z@y.com'])])
    await s.applyDelta('a', 'connections', [rec('a', 'people/3', ['n@y.com'])], ['people/1'])
    expect((await s.listAll()).map((r) => r.resourceName).sort()).toEqual(['people/2', 'people/3'])
  })
  it('email in two records returns both', async () => {
    const s = createMemoryStorage()
    await s.replaceSource('a', 'connections', [rec('a', 'people/1', ['x@y.com'])])
    await s.replaceSource('b', 'connections', [rec('b', 'people/1', ['x@y.com'])])
    expect(await s.getByEmail('x@y.com')).toHaveLength(2)
  })
  it('clear only removes that account', async () => {
    const s = createMemoryStorage()
    await s.replaceSource('a', 'connections', [rec('a', 'people/1', ['x@y.com'])])
    await s.replaceSource('b', 'connections', [rec('b', 'people/1', ['x@y.com'])])
    await s.putSync('a', 'connections', { lastSyncAt: 1 })
    await s.putSync('b', 'connections', { lastSyncAt: 2 })
    await s.clear('a')
    expect((await s.listAll()).map((r) => r.accountId)).toEqual(['b'])
    expect(await s.getSync('a', 'connections')).toBeUndefined()
    expect(await s.getSync('b', 'connections')).toEqual({ lastSyncAt: 2 })
  })
})
