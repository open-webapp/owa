import { describe, expect, it } from 'vitest'
import { personToRecord } from '../normalize.js'

describe('personToRecord', () => {
  it('maps a person with two emails, indexing both lowercased', () => {
    const rec = personToRecord(
      {
        resourceName: 'people/c1',
        names: [{ displayName: 'Ada Lovelace' }],
        emailAddresses: [{ value: 'Ada@Example.com' }, { value: 'ada@work.org' }],
      },
      'acct1',
      'connections',
    )
    expect(rec).toEqual({
      key: 'acct1:people/c1',
      accountId: 'acct1',
      source: 'connections',
      resourceName: 'people/c1',
      name: 'Ada Lovelace',
      nameNorm: 'ada lovelace',
      emails: ['ada@example.com', 'ada@work.org'],
      emailsNorm: ['ada@example.com', 'ada@work.org'],
    })
  })

  const base = { resourceName: 'people/c2', emailAddresses: [{ value: 'x@y.com' }] }

  it('trims and lowercases emails for the norm index', () => {
    const rec = personToRecord(
      { ...base, emailAddresses: [{ value: '  Bob@EXAMPLE.com ' }] },
      'a',
      'otherContacts',
    )
    expect(rec?.emails).toEqual(['bob@example.com'])
    expect(rec?.emailsNorm).toEqual(['bob@example.com'])
    expect(rec?.source).toBe('otherContacts')
  })

  it('folds diacritics in nameNorm', () => {
    const rec = personToRecord({ ...base, names: [{ displayName: ' José Ñúñez ' }] }, 'a', 'connections')
    expect(rec?.name).toBe('José Ñúñez')
    expect(rec?.nameNorm).toBe('jose nunez')
  })

  it('skips default photos', () => {
    const rec = personToRecord(
      { ...base, photos: [{ url: 'https://h/d=s100', default: true }] },
      'a',
      'connections',
    )
    expect(rec).not.toHaveProperty('photoUrl')
  })

  it('uses first non-default photo and normalizes =s100 to =s64', () => {
    const rec = personToRecord(
      {
        ...base,
        photos: [
          { url: 'https://h/d=s100', default: true },
          { url: 'https://h/p=s100' },
        ],
      },
      'a',
      'connections',
    )
    expect(rec?.photoUrl).toBe('https://h/p=s64')
  })

  it('appends =s64 when the photo URL has no size', () => {
    const rec = personToRecord({ ...base, photos: [{ url: 'https://h/p' }] }, 'a', 'connections')
    expect(rec?.photoUrl).toBe('https://h/p=s64')
  })

  it('skips a person without email', () => {
    expect(personToRecord({ resourceName: 'people/c3', names: [{ displayName: 'N' }] }, 'a', 'connections')).toBeUndefined()
  })

  it('skips a malformed person without resourceName without throwing', () => {
    expect(() => personToRecord({ emailAddresses: [{ value: 'a@b.c' }] }, 'a', 'connections')).not.toThrow()
    expect(personToRecord({ emailAddresses: [{ value: 'a@b.c' }] }, 'a', 'connections')).toBeUndefined()
  })
})
