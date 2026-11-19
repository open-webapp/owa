import { describe, expect, it } from 'vitest'
import { createMemoryStorage, runStorageAdapterContract, storageContractCases } from '../testing'
import type { StorageContractHarness } from '../testing'
import type { StorageAdapter } from '../core/storage'
import type { ContactRecord } from '../core/types'

function harnessFor(wrap: (s: StorageAdapter) => StorageAdapter = (s) => s): StorageContractHarness {
  const base = createMemoryStorage()
  return {
    storage: wrap(base),
    // Plants rows as-is (no normalisation) through the delta path.
    seedRaw: async (row) => base.applyDelta('seed', 'connections', [row as ContactRecord], []),
    corruptRow: { key: 'bad', accountId: 'seed', source: 'connections', resourceName: 'people/bad' },
  }
}

runStorageAdapterContract(() => harnessFor())

async function failures(wrap: (s: StorageAdapter) => StorageAdapter): Promise<string[]> {
  const out: string[] = []
  for (const c of storageContractCases()) {
    try {
      await c.run(() => harnessFor(wrap))
    } catch {
      out.push(c.name)
    }
  }
  return out
}

describe('contract is not vacuous', () => {
  it('fails when delete is not applied', async () => {
    const bad = await failures((s) => ({ ...s, applyDelta: (a, src, up) => s.applyDelta(a, src, up, []) }))
    expect(bad).toContain('applyDelta upserts and deletes by resourceName')
  })

  it('fails when clear leaks another account', async () => {
    const bad = await failures((s) => ({
      ...s,
      clear: async (a) => {
        await s.clear(a)
        await s.clear('a2')
      },
    }))
    expect(bad).toContain('clear(account) removes only that account (records and sync)')
  })
})
