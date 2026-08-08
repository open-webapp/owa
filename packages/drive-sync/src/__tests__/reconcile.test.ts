import { describe, expect, it } from 'vitest'
import { reconcile, dropProject } from '../reconcile.js'
import { openAuthDb } from '../storage.js'

let idSeq = 0
function freshAppId(): string {
  idSeq += 1
  return `recon-app-${idSeq}`
}

/** Opens (creating if necessary) the owa-drive DB for appId/projectId and waits for it to be ready. */
async function createDb(appId: string, projectId: string): Promise<void> {
  await openAuthDb(appId, projectId)
}

async function listDbNames(): Promise<string[]> {
  const dbs = await indexedDB.databases()
  return dbs.map((d) => d.name).filter((n): n is string => !!n)
}

describe('reconcile (test case 15)', () => {
  it('deletes DBs for projects not in knownProjectIds, keeping known ones', async () => {
    const appId = freshAppId()

    await createDb(appId, 'p1')
    await createDb(appId, 'p2')
    await createDb(appId, 'p3')

    let names = await listDbNames()
    expect(names).toContain(`owa-drive-${appId}-p1`)
    expect(names).toContain(`owa-drive-${appId}-p2`)
    expect(names).toContain(`owa-drive-${appId}-p3`)

    await reconcile(appId, ['p1'])

    names = await listDbNames()
    expect(names).toContain(`owa-drive-${appId}-p1`)
    expect(names).not.toContain(`owa-drive-${appId}-p2`)
    expect(names).not.toContain(`owa-drive-${appId}-p3`)
  })
})

describe('reconcile (test case 16)', () => {
  it('no-ops without throwing when indexedDB.databases is unsupported', async () => {
    const appId = freshAppId()
    await createDb(appId, 'p1')
    await createDb(appId, 'p2')

    const originalDatabases = indexedDB.databases
    // Simulate an environment (e.g. Firefox/older Safari) where
    // indexedDB.databases() does not exist. `databases` lives on
    // IDBFactory.prototype in fake-indexeddb, so `delete indexedDB.databases`
    // is a no-op (nothing own-property to delete) - shadow it with an own
    // `undefined` property instead so `typeof indexedDB.databases` really
    // reports 'undefined', matching reconcile.ts's feature check.
    // @ts-expect-error - intentionally shadowing with undefined for the test.
    indexedDB.databases = undefined

    try {
      await expect(reconcile(appId, ['p1'])).resolves.toBeUndefined()
    } finally {
      indexedDB.databases = originalDatabases
    }

    const names = await listDbNames()
    expect(names).toContain(`owa-drive-${appId}-p1`)
    expect(names).toContain(`owa-drive-${appId}-p2`)
  })
})

describe('dropProject (test case 17)', () => {
  it('deletes the target DB and evicts the cached handle', async () => {
    const appId = 'app'
    const projectId = 'p1'

    // Ensure a clean slate in case a prior test run left this DB behind.
    await dropProject(appId, projectId)

    const handleBefore = openAuthDb(appId, projectId)
    // Force the handle to actually open so the underlying DB exists.
    await handleBefore

    let names = await listDbNames()
    expect(names).toContain(`owa-drive-${appId}-${projectId}`)

    await dropProject(appId, projectId)

    names = await listDbNames()
    expect(names).not.toContain(`owa-drive-${appId}-${projectId}`)

    // The cached handle should have been evicted: requesting it again
    // returns a *new* promise/connection rather than the stale cached one.
    const handleAfter = openAuthDb(appId, projectId)
    expect(handleAfter).not.toBe(handleBefore)

    // And the fresh connection re-creates the DB (proving it's a real new
    // open, not just a distinct-but-pointing-at-the-same-closed-handle).
    await handleAfter
    names = await listDbNames()
    expect(names).toContain(`owa-drive-${appId}-${projectId}`)
  })
})
