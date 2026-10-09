import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { driveFetch } from '../http.js'
import { createDriveSync, DriveSyncError, NeedsReauthError, RefreshDeferredError } from '../index.js'
import { setConn, setEnvelope, setToken } from '../storage.js'
import { createGisFake, createTokenExchangeFake, type GisFake, type TokenExchangeFake } from '../testing/index.js'
import type { Envelope, StoredToken } from '../types.js'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
]
const SCOPE_STR = SCOPES.join(' ')
const DRIVE_URL = 'https://www.googleapis.com/drive/v3/files/file-1?alt=media'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const EXCHANGE_URL = 'https://exchange.example/callback'
const HOUR = 60 * 60 * 1000

let idSeq = 0
function freshIds() {
  idSeq += 1
  return { appId: `iar-${idSeq}`, projectId: `iar-proj-${idSeq}` }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

interface FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden'
  hidden: boolean
  focused: boolean
  hasFocus(): boolean
}
function installDocument(state: { visible: boolean; focused: boolean }): FakeDocument {
  const doc = new EventTarget() as FakeDocument
  doc.visibilityState = state.visible ? 'visible' : 'hidden'
  doc.hidden = !state.visible
  doc.focused = state.focused
  doc.hasFocus = () => doc.focused
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', new EventTarget())
  return doc
}

/** Fetch double: userinfo always succeeds; Drive URL statuses come from `queue` (default 200). */
function createFetch() {
  const queue: number[] = []
  const driveRequests: string[] = []
  const impl = (async (input: unknown): Promise<Response> => {
    const url = typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? input)
    if (url.startsWith(USERINFO_URL)) {
      return new Response(JSON.stringify({ email: 'user@example.com' }), { status: 200 })
    }
    driveRequests.push(url)
    const status = queue.shift() ?? 200
    return new Response(JSON.stringify({ ok: true }), { status })
  }) as unknown as typeof fetch
  return { queue, driveRequests, impl }
}

async function seed(appId: string, projectId: string, expiresInMs: number, withConn = true) {
  if (withConn) {
    await setConn(appId, projectId, { email: 'user@example.com', grantedScopes: SCOPES, connectedAt: Date.now() })
  }
  const token: StoredToken = { accessToken: 'cached', expiresAt: Date.now() + expiresInMs, grantedScopes: SCOPES }
  await setToken(appId, projectId, token)
}

describe('inactive refresh gate (drive-sync 0.11.0)', () => {
  let gis: GisFake
  let net: ReturnType<typeof createFetch>

  beforeEach(() => {
    gis = createGisFake()
    gis.install()
    net = createFetch()
    vi.stubGlobal('fetch', net.impl)
  })
  afterEach(() => {
    gis.uninstall()
    vi.unstubAllGlobals()
  })

  function call(appId: string, projectId: string, extra: Partial<Parameters<typeof driveFetch>[0]> = {}) {
    return driveFetch({
      appId,
      projectId,
      clientId: 'client-1',
      url: DRIVE_URL,
      requiredScopes: SCOPES,
      fetchEmail: async () => 'user@example.com',
      ...extra,
    })
  }

  it('happy: 401 while hidden rejects RefreshDeferredError with zero GIS calls', async () => {
    installDocument({ visible: false, focused: true })
    const { appId, projectId } = freshIds()
    await seed(appId, projectId, HOUR)
    net.queue.push(401)
    await expect(call(appId, projectId)).rejects.toBeInstanceOf(RefreshDeferredError)
    expect(gis.calls.length).toBe(0)
  })

  it('happy: 401 while active refreshes once and retries to 200', async () => {
    installDocument({ visible: true, focused: true })
    const { appId, projectId } = freshIds()
    await seed(appId, projectId, HOUR)
    net.queue.push(401)
    gis.queueResponse({ access_token: 'fresh', expires_in: 3600, scope: SCOPE_STR })
    const res = await call(appId, projectId)
    expect(res.status).toBe(200)
    expect(gis.calls.length).toBe(1)
  })

  it('happy: no cached token, interactive:false, hidden => deferred, zero GIS calls', async () => {
    installDocument({ visible: false, focused: false })
    const { appId, projectId } = freshIds()
    await expect(call(appId, projectId)).rejects.toBeInstanceOf(RefreshDeferredError)
    expect(gis.calls.length).toBe(0)
    expect(net.driveRequests.length).toBe(0)
  })

  it('happy: reactivation runs warm-up once per tracked project, does not replay the deferred request, and a fresh call succeeds', async () => {
    const doc = installDocument({ visible: false, focused: false })
    const { appId, projectId } = freshIds()
    await seed(appId, projectId, 60 * 1000) // inside refresh buffer => stale
    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    sync.project(projectId)
    const dispose = sync.activate()

    await expect(call(appId, projectId)).rejects.toBeInstanceOf(RefreshDeferredError)
    const requestsBefore = net.driveRequests.length
    expect(gis.calls.length).toBe(0)

    gis.queueResponse({ access_token: 'warmed', expires_in: 3600, scope: SCOPE_STR })
    doc.visibilityState = 'visible'
    doc.hidden = false
    doc.focused = true
    doc.dispatchEvent(new Event('visibilitychange'))
    await flush()
    await flush()

    expect(gis.calls.length).toBe(1)
    expect(net.driveRequests.length).toBe(requestsBefore)

    const res = await call(appId, projectId)
    expect(res.status).toBe(200)
    dispose()
  })

  it('edge: deferral leaves connection state intact and emits no logout to subscribers', async () => {
    installDocument({ visible: false, focused: true })
    const { appId, projectId } = freshIds()
    await seed(appId, projectId, 60 * 1000)
    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const handle = sync.project(projectId)
    const spy = vi.fn()
    const unsub = handle.subscribeConnection(spy)
    await flush()
    const before = handle.getConnectionSync()
    expect(before?.email).toBe('user@example.com')
    const notifies = spy.mock.calls.length

    await expect(call(appId, projectId)).rejects.toBeInstanceOf(RefreshDeferredError)
    await flush()

    expect(handle.getConnectionSync()).toEqual(before)
    expect(spy.mock.calls.length).toBe(notifies)

    // Once active again the original stored connection still drives a refresh.
    vi.stubGlobal('document', undefined)
    gis.queueResponse({ access_token: 'later', expires_in: 3600, scope: SCOPE_STR })
    const res = await call(appId, projectId)
    expect(res.status).toBe(200)
    expect(gis.calls[0].hint).toBe('user@example.com')
    unsub()
  })

  it('edge: no document (node env) is treated as active: 401 => refresh + retry 200', async () => {
    expect(typeof document).toBe('undefined')
    const { appId, projectId } = freshIds()
    await seed(appId, projectId, HOUR)
    net.queue.push(401)
    gis.queueResponse({ access_token: 'fresh', expires_in: 3600, scope: SCOPE_STR })
    const res = await call(appId, projectId)
    expect(res.status).toBe(200)
    expect(gis.calls.length).toBe(1)
  })

  it.each([
    ['visible but unfocused', true, false],
    ['hidden but focused', false, true],
  ])('edge: %s => deferred', async (_name, visible, focused) => {
    installDocument({ visible, focused })
    const { appId, projectId } = freshIds()
    await seed(appId, projectId, HOUR)
    net.queue.push(401)
    await expect(call(appId, projectId)).rejects.toBeInstanceOf(RefreshDeferredError)
    expect(gis.calls.length).toBe(0)
  })

  it('edge: cached valid token while hidden => request proceeds, zero GIS calls', async () => {
    installDocument({ visible: false, focused: false })
    const { appId, projectId } = freshIds()
    await seed(appId, projectId, HOUR)
    const res = await call(appId, projectId)
    expect(res.status).toBe(200)
    expect(gis.calls.length).toBe(0)
  })

  it('edge: expired cached token hidden, non-interactive => deferred', async () => {
    installDocument({ visible: false, focused: false })
    const { appId, projectId } = freshIds()
    await seed(appId, projectId, -1000)
    await expect(call(appId, projectId)).rejects.toBeInstanceOf(RefreshDeferredError)
    expect(gis.calls.length).toBe(0)
    expect(net.driveRequests.length).toBe(0)
  })

  it('error: RefreshDeferredError identity', () => {
    const e = new RefreshDeferredError()
    expect(e).toBeInstanceOf(DriveSyncError)
    expect(e).not.toBeInstanceOf(NeedsReauthError)
    expect(e.name).toBe('RefreshDeferredError')
    expect(e.reason).toBe('refresh_deferred')
  })

  it('error: interactive:true while hidden is not deferred (existing behavior)', async () => {
    installDocument({ visible: false, focused: false })
    const { appId, projectId } = freshIds()
    gis.queueResponse({ access_token: 'interactive', expires_in: 3600, scope: SCOPE_STR })
    const res = await call(appId, projectId, { interactive: true })
    expect(res.status).toBe(200)
    expect(gis.calls.length).toBe(1)
  })

  describe('envelope mode', () => {
    let exchange: TokenExchangeFake
    beforeEach(() => {
      exchange = createTokenExchangeFake({ now: () => Date.now() })
      exchange.install()
    })
    afterEach(() => exchange.uninstall())

    async function seedEnvelope(appId: string, projectId: string) {
      await seed(appId, projectId, HOUR)
      const env: Envelope = {
        v: 2,
        guid: 'g',
        payload: { access_token: 'stored', expiry_date: Date.now() - 1000, token_type: 'Bearer', scope: SCOPE_STR },
        sig: 'sig==',
      }
      await setEnvelope(appId, projectId, env)
    }

    it('happy: hidden 401 => deferred, zero exchange calls, connection unchanged', async () => {
      installDocument({ visible: false, focused: true })
      const { appId, projectId } = freshIds()
      await seedEnvelope(appId, projectId)
      const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [], tokenExchangeUrl: EXCHANGE_URL })
      const handle = sync.project(projectId)
      await flush()
      const before = handle.getConnectionSync()
      net.queue.push(401)
      await expect(call(appId, projectId, { tokenExchangeUrl: EXCHANGE_URL })).rejects.toBeInstanceOf(
        RefreshDeferredError
      )
      expect(exchange.calls.length).toBe(0)
      expect(handle.getConnectionSync()).toEqual(before)
    })

    it('happy: active 401 => refreshes via exchange endpoint once and retry returns 200', async () => {
      installDocument({ visible: true, focused: true })
      const { appId, projectId } = freshIds()
      await seedEnvelope(appId, projectId)
      net.queue.push(401)
      const res = await call(appId, projectId, { tokenExchangeUrl: EXCHANGE_URL })
      expect(res.status).toBe(200)
      expect(exchange.calls.length).toBe(1)
    })
  })
})
