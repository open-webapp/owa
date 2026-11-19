import { describe, expect, it } from 'vitest'
import type { StorageAdapter } from '../core/storage.js'
import type { ContactRecord, Source } from '../core/types.js'

/**
 * What a host supplies to run the contract.
 *
 * - `storage`: the adapter under test (fresh, empty per factory call).
 * - `seedRaw` (optional): writes a row EXACTLY as given, bypassing any normalisation the
 *   adapter's write path performs (legacy-format / corrupt rows). When omitted, the legacy
 *   and corrupt-row cases are skipped.
 * - `legacyRow` (optional): a legacy-shape row the host's on-disk format may contain
 *   (missing optional fields). Defaults to a minimal record.
 * - `corruptRow` (optional): a row the host considers corrupt (e.g. missing emailsNorm).
 */
export interface StorageContractHarness {
  storage: StorageAdapter
  seedRaw?: (row: unknown) => Promise<void>
  legacyRow?: ContactRecord
  corruptRow?: unknown
}

export const rec = (
  accountId: string,
  source: Source,
  id: string,
  emails: string[],
): ContactRecord => ({
  key: `${accountId}|${source}|people/${id}`,
  accountId,
  source,
  resourceName: `people/${id}`,
  name: id,
  emails,
  emailsNorm: emails.map((e) => e.trim().toLowerCase()),
})

export interface ContractCase {
  name: string
  run: (factory: HarnessFactory) => Promise<void>
}
type HarnessFactory = () => StorageContractHarness | Promise<StorageContractHarness>

const ids = (rs: ContactRecord[]) => rs.map((r) => r.resourceName).sort()

/** The contract as plain async cases (framework-agnostic; also used to prove the suite fails on broken adapters). */
export function storageContractCases(): ContractCase[] {
  return [
    {
      name: 'replaceSource then getByEmail/listAll returns the records',
      async run(factory) {
    const { storage } = await factory()
    await storage.replaceSource('a1', 'connections', [rec('a1', 'connections', 'x', ['x@e.com'])])
    expect(ids(await storage.getByEmail('x@e.com'))).toEqual(['people/x'])
    expect(ids(await storage.listAll())).toEqual(['people/x'])
      },
    },
    {
      name: 'replaceSource drops previous records of that account+source only',
      async run(factory) {
    const { storage } = await factory()
    await storage.replaceSource('a1', 'connections', [rec('a1', 'connections', 'old', ['o@e.com'])])
    await storage.replaceSource('a1', 'otherContacts', [rec('a1', 'otherContacts', 'oc', ['oc@e.com'])])
    await storage.replaceSource('a1', 'connections', [rec('a1', 'connections', 'new', ['n@e.com'])])
    expect(ids(await storage.listAll())).toEqual(['people/new', 'people/oc'])
      },
    },
    {
      name: 'applyDelta upserts and deletes by resourceName',
      async run(factory) {
    const { storage } = await factory()
    await storage.replaceSource('a1', 'connections', [
      rec('a1', 'connections', 'a', ['a@e.com']),
      rec('a1', 'connections', 'b', ['b@e.com']),
    ])
    await storage.applyDelta(
      'a1',
      'connections',
      [rec('a1', 'connections', 'c', ['c@e.com'])],
      ['people/a'],
    )
    expect(ids(await storage.listAll())).toEqual(['people/b', 'people/c'])
    expect(await storage.getByEmail('a@e.com')).toEqual([])
      },
    },
    {
      name: 'getByEmail is multi-entry: one email in several records returns all',
      async run(factory) {
    const { storage } = await factory()
    await storage.replaceSource('a1', 'connections', [
      rec('a1', 'connections', 'p', ['shared@e.com', 'p2@e.com']),
    ])
    await storage.replaceSource('a2', 'connections', [rec('a2', 'connections', 'q', ['shared@e.com'])])
    expect(ids(await storage.getByEmail('shared@e.com'))).toEqual(['people/p', 'people/q'])
    expect(ids(await storage.getByEmail('p2@e.com'))).toEqual(['people/p'])
      },
    },
    {
      name: 'putSync/getSync round-trips per account and source',
      async run(factory) {
    const { storage } = await factory()
    expect(await storage.getSync('a1', 'connections')).toBeUndefined()
    await storage.putSync('a1', 'connections', { syncToken: 't1', lastSyncAt: 5 })
    await storage.putSync('a1', 'otherContacts', { lastSyncAt: 6 })
    expect(await storage.getSync('a1', 'connections')).toEqual({ syncToken: 't1', lastSyncAt: 5 })
    expect((await storage.getSync('a1', 'otherContacts'))?.syncToken).toBeUndefined()
    expect(await storage.getSync('a2', 'connections')).toBeUndefined()
      },
    },
    {
      name: 'clear(account) removes only that account (records and sync)',
      async run(factory) {
    const { storage } = await factory()
    for (const a of ['a1', 'a2']) {
      await storage.replaceSource(a, 'connections', [rec(a, 'connections', a, [`${a}@e.com`])])
      await storage.putSync(a, 'connections', { syncToken: a, lastSyncAt: 1 })
    }
    await storage.clear('a1')
    expect(ids(await storage.listAll())).toEqual(['people/a2'])
    expect(await storage.getSync('a1', 'connections')).toBeUndefined()
    expect((await storage.getSync('a2', 'connections'))?.syncToken).toBe('a2')
      },
    },
    {
      name: 'tolerates a legacy row (optional fields missing) via seedRaw',
      async run(factory) {
    const h = await factory()
    if (!h.seedRaw) return
    const legacy: ContactRecord = h.legacyRow ?? {
      key: 'a1|connections|people/l',
      accountId: 'a1',
      source: 'connections',
      resourceName: 'people/l',
      emails: ['l@e.com'],
      emailsNorm: ['l@e.com'],
    }
    await h.seedRaw(legacy)
    expect(ids(await h.storage.getByEmail(legacy.emailsNorm[0] ?? ''))).toEqual([legacy.resourceName])
      },
    },
    {
      name: 'tolerates a corrupt row via seedRaw without throwing or hiding good rows',
      async run(factory) {
    const h = await factory()
    if (!h.seedRaw || h.corruptRow === undefined) return
    await h.storage.replaceSource('a1', 'connections', [rec('a1', 'connections', 'ok', ['ok@e.com'])])
    await h.seedRaw(h.corruptRow)
    expect(ids(await h.storage.getByEmail('ok@e.com'))).toEqual(['people/ok'])
    await expect(h.storage.listAll()).resolves.toBeDefined()
      },
    },
  ]
}

export function runStorageAdapterContract(factory: HarnessFactory): void {
  describe('StorageAdapter contract', () => {
    for (const c of storageContractCases()) it(c.name, () => c.run(factory))
  })
}
