import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync } from '../index.js'
import { warmUpIfNeeded } from '../refresh.js'
import { setConn, setToken, setEnvelope, getToken } from '../storage.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import { createTokenExchangeFake, type TokenExchangeFake } from '../testing/index.js'
import type { Envelope, StoredToken } from '../types.js'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
]

// Matched by createTokenExchangeFake via its `/callback` pathname rule.
const TOKEN_EXCHANGE_URL = 'https://exchange.example/callback'
const REFRESH_BUFFER_MS = 5 * 60 * 1000

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `warmenv-app-${idSeq}`, projectId: `warmenv-proj-${idSeq}` }
}

function makeEnvelope(expiryDate: number): Envelope {
  return {
    v: 2,
    guid: `guid-${idSeq}`,
    payload: {
      access_token: `ya29.stored-${idSeq}`,
      expiry_date: expiryDate,
      token_type: 'Bearer',
      scope: SCOPES[0],
    },
    sig: 'sig==',
  }
}

/**
 * Node's `vitest.config.ts` environment for this package is 'node' (see
 * setup.ts) — no real `document`/`window`. To exercise the actual
 * visibilitychange listener wiring in `activate()` we stub in minimal
 * `document`/`window` doubles built on Node's built-in `EventTarget`, exactly
 * as refresh.test.ts does.
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

/** Polls `predicate` on real timers until it holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A few macrotask turns — enough for the fake-indexeddb + fetch chain to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

// This spec runs on REAL timers on purpose: every case touches IndexedDB via
// ../storage.js against `fake-indexeddb`, whose async machinery needs real
// macrotask scheduling (mirrors refresh.test.ts / refresh-envelope.test.ts).
describe('warm-up in envelope mode (T9)', () => {
  let gisFake: GisFake
  let tokenExchange: TokenExchangeFake
  let fakeDocument: FakeDocument
  let fakeWindow: EventTarget
  let postSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
    tokenExchange = createTokenExchangeFake({ now: () => Date.now() })
    tokenExchange.install()
    fakeDocument = createFakeDocument()
    fakeWindow = new EventTarget()
    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('window', fakeWindow)
    postSpy = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    tokenExchange.uninstall()
    gisFake.uninstall()
    postSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('happy: conn present + stale token + tab visible -> visibilitychange runs refreshEnvelope, token refreshed, no GIS', async () => {
    const { appId, projectId } = freshIds()

    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: SCOPES,
      connectedAt: Date.now(),
    })
    // Envelope well inside the refresh buffer -> refreshEnvelope must POST.
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 30_000))
    // No cached token at all -> warm-up gate treats it as stale.

    const sync = createDriveSync({
      appId,
      clientId: 'client-1',
      folderPath: [],
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    })
    sync.project(projectId) // registers projectId in the tracked set
    const dispose = sync.activate()

    try {
      fakeDocument.visibilityState = 'visible'
      fakeDocument.hidden = false
      fakeDocument.dispatchEvent(new Event('visibilitychange'))

      await waitFor(() => tokenExchange.calls.length === 1)

      expect(tokenExchange.calls[0].kind).toBe('envelope')
      // Envelope path was taken, not the legacy GIS silent refresh.
      expect(gisFake.calls.length).toBe(0)

      const stored = await getToken(appId, projectId)
      expect(stored?.accessToken).toBe(tokenExchange.lastEnvelope?.payload.access_token)

      const tokenBroadcasts = postSpy.mock.calls.filter(
        ([msg]) => (msg as { type?: string })?.type === 'token'
      )
      expect(tokenBroadcasts).toHaveLength(1)
      expect(tokenBroadcasts[0][0]).toMatchObject({ type: 'token', projectId })
    } finally {
      dispose()
    }
  })

  it('edge: a visibilitychange fired while document.hidden does NOT call refreshEnvelope', async () => {
    const { appId, projectId } = freshIds()

    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: SCOPES,
      connectedAt: Date.now(),
    })
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 30_000))

    const sync = createDriveSync({
      appId,
      clientId: 'client-1',
      folderPath: [],
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    })
    sync.project(projectId)
    const dispose = sync.activate()

    try {
      fakeDocument.visibilityState = 'hidden'
      fakeDocument.hidden = true
      fakeDocument.dispatchEvent(new Event('visibilitychange'))

      await settle()

      expect(tokenExchange.calls).toHaveLength(0)
      expect(gisFake.calls.length).toBe(0)
    } finally {
      dispose()
    }
  })

  it('edge: refreshEnvelope throwing is swallowed by warmUpIfNeeded — only logger.warn', async () => {
    const { appId, projectId } = freshIds()

    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: SCOPES,
      connectedAt: Date.now(),
    })
    // Conn present + no envelope + no token: the warm-up gate passes (stale),
    // then refreshEnvelope rejects with NeedsReauthError('No stored envelope').
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    await expect(
      warmUpIfNeeded({
        appId,
        projectId,
        clientId: 'client-1',
        tokenExchangeUrl: TOKEN_EXCHANGE_URL,
        logger,
      })
    ).resolves.toBeUndefined()

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][0]).toMatch(/warm-up failed/)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('edge (legacy): no tokenExchangeUrl -> legacy GIS silent-refresh path, one non-interactive warm-up', async () => {
    const { appId, projectId } = freshIds()

    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: SCOPES,
      connectedAt: Date.now(),
    })
    const staleToken: StoredToken = {
      accessToken: 'about-to-expire',
      // Inside the 5-minute refresh buffer (1 minute left).
      expiresAt: Date.now() + REFRESH_BUFFER_MS - 4 * 60 * 1000,
      grantedScopes: SCOPES,
    }
    await setToken(appId, projectId, staleToken)

    gisFake.queueResponse({
      access_token: 'refreshed-token',
      expires_in: 3600,
      scope: SCOPES.join(' '),
    })

    // No tokenExchangeUrl -> falls through to the legacy acquireToken path.
    await warmUpIfNeeded({ appId, projectId, clientId: 'client-1' })

    // Assertion copied from refresh.test.ts (test case 19).
    expect(gisFake.calls.length).toBe(1)
    expect(gisFake.calls[0]).toMatchObject({ prompt: 'none' })
    expect(tokenExchange.calls).toHaveLength(0)
  })
})
