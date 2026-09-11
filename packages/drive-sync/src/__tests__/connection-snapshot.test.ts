import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync } from '../index.js'
import { setConn, setToken } from '../storage.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import type { StoredToken } from '../types.js'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
]

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

const REFRESH_BUFFER_MS = 5 * 60 * 1000

/**
 * index.ts's `createDriveSync` always resolves email via a real `fetch`
 * against the userinfo endpoint (and revokes via a real `fetch` too) — same
 * stub as broadcast.test.ts.
 */
function createHostFetch(): typeof fetch {
  return (async (input: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request)?.url ?? String(input)

    if (url.startsWith(USERINFO_URL)) {
      return new Response(JSON.stringify({ email: 'user@example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (url.startsWith(REVOKE_URL)) {
      return new Response(null, { status: 200 })
    }

    throw new Error(`unexpected fetch to ${url}`)
  }) as unknown as typeof fetch
}

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `snap-${idSeq}`, projectId: `snap-proj-${idSeq}` }
}

/** Flushes pending microtasks/timers used by the fire-and-forget re-reads. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Minimal `document`/`window` doubles built on Node's `EventTarget`, same
 * pattern as refresh.test.ts, so `visibilitychange` can be dispatched for
 * real to exercise index.ts's `activate()` warm-up wiring.
 */
interface FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden'
  hidden: boolean
}

function createFakeDocument(): FakeDocument {
  const target = new EventTarget() as FakeDocument
  target.visibilityState = 'visible'
  target.hidden = false
  return target
}

function createFakeWindow(): EventTarget {
  return new EventTarget()
}

/** Seeds a durable Connection + fresh (non-stale) token directly into storage. */
async function seedConnection(appId: string, projectId: string): Promise<void> {
  await setConn(appId, projectId, {
    email: 'user@example.com',
    grantedScopes: SCOPES,
    connectedAt: Date.now(),
  })
  const freshToken: StoredToken = {
    accessToken: 'seed-token',
    expiresAt: Date.now() + 60 * 60 * 1000,
    grantedScopes: SCOPES,
  }
  await setToken(appId, projectId, freshToken)
}

describe('connection snapshot (T6)', () => {
  let gisFake: GisFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
    vi.stubGlobal('fetch', createHostFetch())
  })

  afterEach(() => {
    gisFake.uninstall()
    vi.unstubAllGlobals()
  })

  it('referential stability: an unrelated re-read does not change the snapshot reference or over-notify', async () => {
    const { appId, projectId } = freshIds()
    await seedConnection(appId, projectId)

    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const handle = sync.project(projectId)

    const spy = vi.fn()
    const sub = handle.subscribeConnection(spy)
    await flush()

    expect(spy).toHaveBeenCalledTimes(1)
    const a = handle.getConnectionSync()
    expect(a).not.toBeNull()
    expect(a?.email).toBe('user@example.com')

    // A second subscription doesn't change the underlying data, so the
    // store's shallow-equal commit should be a no-op: same reference, no
    // extra notify to the first subscriber.
    const sub2 = handle.subscribeConnection(() => {})
    await flush()

    expect(handle.getConnectionSync()).toBe(a)
    expect(spy).toHaveBeenCalledTimes(1)

    sub()
    sub2()
  })

  it('notifies subscribers and clears the snapshot on disconnect()', async () => {
    const { appId, projectId } = freshIds()
    await seedConnection(appId, projectId)

    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const handle = sync.project(projectId)

    const spy = vi.fn()
    const sub = handle.subscribeConnection(spy)
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(handle.getConnectionSync()).not.toBeNull()

    await handle.disconnect()
    await flush()

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(handle.getConnectionSync()).toBeNull()

    sub()
  })

  it('getConnectionSync() lazily kicks off a re-read: null immediately, populated after a flush', async () => {
    const { appId, projectId } = freshIds()
    await seedConnection(appId, projectId)

    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const handle = sync.project(projectId)

    expect(handle.getConnectionSync()).toBeNull()

    await flush()

    const conn = handle.getConnectionSync()
    expect(conn).not.toBeNull()
    expect(conn?.email).toBe('user@example.com')
  })

  it('subscribeConnection() lazily kicks off a re-read: subscriber fires once after hydration', async () => {
    const { appId, projectId } = freshIds()
    await seedConnection(appId, projectId)

    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const handle = sync.project(projectId)

    const spy = vi.fn()
    const sub = handle.subscribeConnection(spy)

    await flush()

    expect(spy).toHaveBeenCalledTimes(1)
    expect(handle.getConnectionSync()?.email).toBe('user@example.com')

    sub()
  })

  it('connect() re-reads before resolving: getConnectionSync() is immediately non-null with no extra flush', async () => {
    const { appId, projectId } = freshIds()
    gisFake.queueResponse({ access_token: 'tok-connect', expires_in: 3600, scope: SCOPES.join(' ') })

    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const handle = sync.project(projectId)

    await handle.connect()

    const conn = handle.getConnectionSync()
    expect(conn).not.toBeNull()
    expect(conn?.email).toBe('user@example.com')
  })

  it('a warm-up re-read on visibilitychange leaves the snapshot reflecting a valid Connection with no spurious flapping', async () => {
    const { appId, projectId } = freshIds()
    await seedConnection(appId, projectId)
    // Overwrite with a near-expiry token so warmUpIfNeeded treats it as stale.
    const staleToken: StoredToken = {
      accessToken: 'about-to-expire',
      expiresAt: Date.now() + REFRESH_BUFFER_MS - 60 * 1000,
      grantedScopes: SCOPES,
    }
    await setToken(appId, projectId, staleToken)
    gisFake.queueResponse({ access_token: 'warmed-token', expires_in: 3600, scope: SCOPES.join(' ') })

    const fakeDocument = createFakeDocument()
    const fakeWindow = createFakeWindow()
    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('window', fakeWindow)

    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const handle = sync.project(projectId)

    const spy = vi.fn()
    const sub = handle.subscribeConnection(spy)
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)

    const dispose = sync.activate()

    fakeDocument.visibilityState = 'visible'
    fakeDocument.dispatchEvent(new Event('visibilitychange'))

    await flush()
    await flush()

    const conn = handle.getConnectionSync()
    expect(conn).not.toBeNull()
    expect(conn?.email).toBe('user@example.com')
    // At most 1 extra notify beyond the initial hydrate (the warm-up's
    // re-read commits a shallow-equal Connection so it should ideally be a
    // no-op, but allow for the token/expiresAt-driven refresh to change it
    // once).
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2)

    dispose()
    sub()
  })

  it('cross-tab logout: tab A disconnecting notifies tab B and clears its snapshot', async () => {
    const { appId, projectId } = freshIds()
    await seedConnection(appId, projectId)

    const tabA = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const tabB = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })

    const handleA = tabA.project(projectId)
    const handleB = tabB.project(projectId)

    const disposeB = tabB.activate()

    const spyB = vi.fn()
    const subB = handleB.subscribeConnection(spyB)
    await flush()
    expect(handleB.getConnectionSync()).not.toBeNull()

    await handleA.disconnect()
    await flush()

    expect(spyB).toHaveBeenCalled()
    expect(handleB.getConnectionSync()).toBeNull()

    disposeB()
    subB()
  })

  it('activate() re-reads every tracked project', async () => {
    const { appId, projectId } = freshIds()
    await seedConnection(appId, projectId)

    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const handle = sync.project(projectId) // tracks projectId

    const dispose = sync.activate()
    await flush()

    expect(handle.getConnectionSync()?.email).toBe('user@example.com')

    dispose()
  })

  it('unsubscribe stops further notifications', async () => {
    const { appId, projectId } = freshIds()
    await seedConnection(appId, projectId)

    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const handle = sync.project(projectId)

    const spy = vi.fn()
    const unsub = handle.subscribeConnection(spy)
    await flush()
    expect(spy).toHaveBeenCalledTimes(1)

    unsub()

    await handle.disconnect()
    await flush()

    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('getConnectionSync()/subscribeConnection() never throw, even right after a rejecting operation', async () => {
    const { appId, projectId } = freshIds()
    // No connection ever seeded, and no GIS response queued: any implicit
    // background operation for this project has nothing to succeed against.
    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const handle = sync.project(projectId)

    expect(() => handle.getConnectionSync()).not.toThrow()
    expect(() => handle.subscribeConnection(() => {})).not.toThrow()

    await flush()

    expect(() => handle.getConnectionSync()).not.toThrow()
    expect(() => handle.subscribeConnection(() => {})).not.toThrow()
  })
})
