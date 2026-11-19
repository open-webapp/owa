import { describe, it, expect } from 'vitest'
import { createMemoryStorage } from '../testing'
import { lookupByEmail } from '../core/lookup'
import type { ContactRecord, Source } from '../core/types'

const rec = (
  accountId: string,
  resourceName: string,
  emails: string[],
  extra: Partial<ContactRecord> = {},
  source: Source = 'connections',
): ContactRecord => ({
  key: `${accountId}|${resourceName}`,
  accountId,
  source,
  resourceName,
  emails,
  emailsNorm: emails.map((e) => e.trim().toLowerCase()),
  ...extra,
})

describe('lookupByEmail', () => {
  it('returns name and photoUrl on hit', async () => {
    const s = createMemoryStorage()
    await s.replaceSource('a', 'connections', [rec('a', 'people/1', ['x@y.com'], { name: 'Xa', photoUrl: 'u=s64' })])
    expect(await lookupByEmail(s, ['a'], 'x@y.com')).toEqual({ name: 'Xa', photoUrl: 'u=s64' })
  })
  it('is case-insensitive and trims input', async () => {
    const s = createMemoryStorage()
    await s.replaceSource('a', 'connections', [rec('a', 'people/1', ['x@y.com'], { name: 'Xa' })])
    expect(await lookupByEmail(s, ['a'], '  X@Y.COM ')).toEqual({ name: 'Xa' })
  })
  it('first account in order wins, whole record', async () => {
    const s = createMemoryStorage()
    await s.replaceSource('a', 'connections', [rec('a', 'people/1', ['x@y.com'], { name: 'A name' })])
    await s.replaceSource('b', 'connections', [rec('b', 'people/2', ['x@y.com'], { name: 'B name', photoUrl: 'bp' })])
    expect(await lookupByEmail(s, ['b', 'a'], 'x@y.com')).toEqual({ name: 'B name', photoUrl: 'bp' })
    expect(await lookupByEmail(s, ['a', 'b'], 'x@y.com')).toEqual({ name: 'A name' })
  })
  it('connections beats otherContacts', async () => {
    const s = createMemoryStorage()
    await s.replaceSource('a', 'otherContacts', [rec('a', 'otherContacts/1', ['x@y.com'], { name: 'Other' }, 'otherContacts')])
    await s.replaceSource('a', 'connections', [rec('a', 'people/1', ['x@y.com'], { name: 'Conn' })])
    expect(await lookupByEmail(s, ['a'], 'x@y.com')).toEqual({ name: 'Conn' })
  })
  it('matches secondary email', async () => {
    const s = createMemoryStorage()
    await s.replaceSource('a', 'connections', [rec('a', 'people/1', ['p@y.com', 'Second@y.com'], { name: 'N' })])
    expect(await lookupByEmail(s, ['a'], 'second@y.com')).toEqual({ name: 'N' })
  })
  it('no-name record gives photoUrl only', async () => {
    const s = createMemoryStorage()
    await s.replaceSource('a', 'connections', [rec('a', 'people/1', ['x@y.com'], { photoUrl: 'p' })])
    expect(await lookupByEmail(s, ['a'], 'x@y.com')).toEqual({ photoUrl: 'p' })
  })
  it('unknown email or unlisted account gives undefined', async () => {
    const s = createMemoryStorage()
    await s.replaceSource('a', 'connections', [rec('a', 'people/1', ['x@y.com'], { name: 'N' })])
    expect(await lookupByEmail(s, ['a'], 'no@y.com')).toBeUndefined()
    expect(await lookupByEmail(s, ['z'], 'x@y.com')).toBeUndefined()
  })
})
