import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { driveFetch } from '../http.js'
import { getAccessToken } from '../connection.js'
import { warmUpIfNeeded } from '../refresh.js'
import { createDriveSync } from '../index.js'
import * as envelopeModule from '../envelope.js'
import { NeedsReauthError } from '../errors.js'
import { setConn, setToken, setEnvelope } from '../storage.js'
import { REQUIRED_SCOPES } from '../files.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import {
  createTokenExchangeFake,
  type TokenExchangeFake,
} from '../testing/tokenExchangeFake.js'
import type { Envelope } from '../types.js'

/**
 * T13 — call-site routing.
 *
 * Each of the three legacy silent-refresh call sites, plus the Picker path,
 * must route by the mere PRESENCE of `tokenExchangeUrl`:
 *
 *   - SET   -> the token-exchange fake sees the replay/refresh AND the GIS
 *             token stub sees NOTHING.
 *   - UNSET -> the reverse: GIS runs, the exchange fake is never touched.
 *
 * Plus: envelope mode with the stored envelope MISSING surfaces a
 * `NeedsReauthError` out of every call site.
 *
 * Real timers throughout: every case touches IndexedDB via ../storage.js
 * against `fake-indexeddb`, whose async machinery needs real macrotask
 * scheduling. No case asserts on retry delays.
 */

// Matched by createTokenExchangeFake via its `/callback` pathname rule.
const TOKEN_EXCHANGE_URL = 'https://exchange.example/callback'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const DRIVE_URL = 'https://www.googleapis.com/drive/v3/files/file-1?alt=media'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const MINUTE = 60_000

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `t13-app-${idSeq}`, projectId: `t13-proj-${idSeq}` }
}

function makeEnvelope(expiryDate: number): Envelope {
  return {
    v: 2,
    guid: `guid-${idSeq}`,
    payload: {
      access_token: `ya29.stored-${idSeq}`,
      expiry_date: expiryDate,
      token_type: 'Bearer',
      scope: SCOPE,
    },
    sig: 'sig==',
  }
}

/** A few macrotask turns — enough for the fake-indexeddb + fetch chain to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/** Polls `predicate` on real timers until it holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * A minimal Drive-endpoint fetch double: every call is recorded, and each
 * response status is taken from `queue` (default 200). Non-Drive URLs never
 * reach here — the tokenExchangeFake installed on top only delegates through
 * for URLs it does not own.
 */
function createDriveResponder() {
  const queue: number[] = []
  const requests: string[] = []
  const fetchImpl = (async (input: unknown): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? input)
    requests.push(url)
    const status = queue.shift() ?? 200
    if (status === 200) {
      return new Response(JSON.stringify({ ok: true, id: 'file-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: { code: status } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { queue, requests, fetchImpl }
}

// ---------------------------------------------------------------------------
// Call site 1 — http.ts driveFetch 401 retry
// ---------------------------------------------------------------------------
describe('T13 · call site: http.ts driveFetch 401 retry', () => {
  let gisFake: GisFake
  let tokenExchange: TokenExchangeFake
  let drive: ReturnType<typeof createDriveResponder>

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
    drive = createDriveResponder()
    vi.stubGlobal('fetch', drive.fetchImpl)
    tokenExchange = createTokenExchangeFake({ now: () => Date.now() })
    tokenExchange.install()
  })

  afterEach(() => {
    tokenExchange.uninstall()
    gisFake.uninstall()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('SET: 401 then 200 — refreshEnvelope drives the retry, GIS token stub untouched', async () => {
    const { appId, projectId } = freshIds()
    // Valid cached token so the first attempt is served from the fast path;
    // a stale envelope so the 401-triggered refreshEnvelope actually POSTs.
    await setToken(appId, projectId, {
      accessToken: 'ya29.cached',
      expiresAt: Date.now() + 60 * MINUTE,
      grantedScopes: [SCOPE],
    })
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 2 * MINUTE))
    drive.queue.push(401, 200)

    const res = await driveFetch({
      appId,
      projectId,
      clientId: 'client-1',
      url: DRIVE_URL,
      requiredScopes: [SCOPE],
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    })

    expect(res.status).toBe(200)
    expect(tokenExchange.calls.map((c) => c.kind)).toEqual(['envelope'])
    // Other path's fake never called.
    expect(gisFake.calls).toHaveLength(0)
    expect(gisFake.codeCalls).toHaveLength(0)
    expect(drive.requests).toEqual([DRIVE_URL, DRIVE_URL])
  })

  it('UNSET: 401 then 200 — GIS silent refresh drives the retry, exchange fake untouched', async () => {
    const { appId, projectId } = freshIds()
    await setToken(appId, projectId, {
      accessToken: 'ya29.cached',
      expiresAt: Date.now() + 60 * MINUTE,
      grantedScopes: [SCOPE],
    })
    drive.queue.push(401, 200)
    gisFake.queueResponse({
      access_token: 'ya29.silent-refresh',
      expires_in: 3600,
      scope: REQUIRED_SCOPES.join(' '),
    })

    const res = await driveFetch({
      appId,
      projectId,
      clientId: 'client-1',
      url: DRIVE_URL,
      requiredScopes: REQUIRED_SCOPES,
    })

    expect(res.status).toBe(200)
    expect(gisFake.calls).toHaveLength(1)
    // Other path's fake never called.
    expect(tokenExchange.calls).toHaveLength(0)
    expect(drive.requests).toEqual([DRIVE_URL, DRIVE_URL])
  })

  it('SET but envelope missing: 401 surfaces NeedsReauthError, neither fake used for GIS', async () => {
    const { appId, projectId } = freshIds()
    await setToken(appId, projectId, {
      accessToken: 'ya29.cached',
      expiresAt: Date.now() + 60 * MINUTE,
      grantedScopes: [SCOPE],
    })
    // No setEnvelope() — envelope mode, but nothing stored.
    drive.queue.push(401)

    const err = await driveFetch({
      appId,
      projectId,
      clientId: 'client-1',
      url: DRIVE_URL,
      requiredScopes: [SCOPE],
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(NeedsReauthError)
    expect(err.reason).toBe('exchange_failed')
    // getEnvelope() returned nothing -> no POST was ever made.
    expect(tokenExchange.calls).toHaveLength(0)
    expect(gisFake.calls).toHaveLength(0)
    expect(gisFake.codeCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Call site 2 — refresh.ts warmUpIfNeeded
// ---------------------------------------------------------------------------
describe('T13 · call site: refresh.ts warmUpIfNeeded', () => {
  let gisFake: GisFake
  let tokenExchange: TokenExchangeFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
    tokenExchange = createTokenExchangeFake({ now: () => Date.now() })
    tokenExchange.install()
  })

  afterEach(() => {
    tokenExchange.uninstall()
    gisFake.uninstall()
    vi.restoreAllMocks()
  })

  it('SET: conn present + token stale — refreshEnvelope replays, GIS token stub untouched', async () => {
    const { appId, projectId } = freshIds()
    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: REQUIRED_SCOPES,
      connectedAt: Date.now(),
    })
    // Envelope well inside the refresh buffer -> refreshEnvelope must POST.
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 30_000))
    // No cached token at all -> warm-up gate treats it as stale.

    await warmUpIfNeeded({
      appId,
      projectId,
      clientId: 'client-1',
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    })

    expect(tokenExchange.calls.map((c) => c.kind)).toEqual(['envelope'])
    // Other path's fake never called.
    expect(gisFake.calls).toHaveLength(0)
    expect(gisFake.codeCalls).toHaveLength(0)
  })

  it('UNSET: conn present + token stale — legacy GIS silent refresh, exchange fake untouched', async () => {
    const { appId, projectId } = freshIds()
    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: REQUIRED_SCOPES,
      connectedAt: Date.now(),
    })
    await setToken(appId, projectId, {
      accessToken: 'about-to-expire',
      // Inside the 5-minute refresh buffer (1 minute left).
      expiresAt: Date.now() + MINUTE,
      grantedScopes: REQUIRED_SCOPES,
    })
    gisFake.queueResponse({
      access_token: 'refreshed-token',
      expires_in: 3600,
      scope: REQUIRED_SCOPES.join(' '),
    })

    // No tokenExchangeUrl and no fetchEmail -> legacy acquireToken path.
    await warmUpIfNeeded({ appId, projectId, clientId: 'client-1' })

    expect(gisFake.calls).toHaveLength(1)
    expect(gisFake.calls[0]).toMatchObject({ prompt: 'none' })
    // Other path's fake never called.
    expect(tokenExchange.calls).toHaveLength(0)
  })

  it('SET but envelope missing: refreshEnvelope rejects NeedsReauthError (swallowed to logger.warn)', async () => {
    const { appId, projectId } = freshIds()
    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: REQUIRED_SCOPES,
      connectedAt: Date.now(),
    })
    // Conn present + no envelope + no token: warm-up gate passes (stale),
    // then the envelope call site rejects with NeedsReauthError.
    const refreshEnvelopeSpy = vi.spyOn(envelopeModule, 'refreshEnvelope')
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

    expect(refreshEnvelopeSpy).toHaveBeenCalledTimes(1)
    await expect(refreshEnvelopeSpy.mock.results[0].value).rejects.toBeInstanceOf(NeedsReauthError)
    // The typed error is what warmUpIfNeeded reports.
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0][1].err).toBeInstanceOf(NeedsReauthError)
    // Neither GIS path was touched.
    expect(gisFake.calls).toHaveLength(0)
    expect(gisFake.codeCalls).toHaveLength(0)
    expect(tokenExchange.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Call site 3 — index.ts activate() visibility handler -> runWarmUps
// ---------------------------------------------------------------------------
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

describe('T13 · call site: index.ts activate() visibility handler', () => {
  let gisFake: GisFake
  let tokenExchange: TokenExchangeFake
  let fakeDocument: FakeDocument
  let fakeWindow: EventTarget

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
    fakeDocument = createFakeDocument()
    fakeWindow = new EventTarget()
    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('window', fakeWindow)
    // Base fetch: only the userinfo endpoint (index.ts wires a real fetchEmail
    // into every warm-up). The token-exchange fake installs on top and owns
    // `/callback`; everything else falls through to here.
    vi.stubGlobal(
      'fetch',
      (async (input: unknown): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : String((input as { url?: unknown })?.url ?? input)
        if (url.startsWith(USERINFO_URL)) {
          return new Response(JSON.stringify({ email: 'user@example.com' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        throw new Error(`unexpected fetch in T13 index.ts suite: ${url}`)
      }) as unknown as typeof fetch
    )
    tokenExchange = createTokenExchangeFake({ now: () => Date.now() })
    tokenExchange.install()
  })

  afterEach(() => {
    tokenExchange.uninstall()
    gisFake.uninstall()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('SET: visibilitychange while visible triggers the envelope warm-up, GIS token stub untouched', async () => {
    const { appId, projectId } = freshIds()
    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: REQUIRED_SCOPES,
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
      fakeDocument.visibilityState = 'visible'
      fakeDocument.hidden = false
      fakeDocument.dispatchEvent(new Event('visibilitychange'))

      await waitFor(() => tokenExchange.calls.length === 1)

      expect(tokenExchange.calls[0].kind).toBe('envelope')
      // Other path's fake never called.
      expect(gisFake.calls).toHaveLength(0)
      expect(gisFake.codeCalls).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('UNSET: visibilitychange while visible runs the legacy GIS silent refresh, exchange fake untouched', async () => {
    const { appId, projectId } = freshIds()
    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: REQUIRED_SCOPES,
      connectedAt: Date.now(),
    })
    await setToken(appId, projectId, {
      accessToken: 'about-to-expire',
      expiresAt: Date.now() + MINUTE,
      grantedScopes: REQUIRED_SCOPES,
    })
    gisFake.queueResponse({
      access_token: 'refreshed-token',
      expires_in: 3600,
      scope: REQUIRED_SCOPES.join(' '),
    })

    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    sync.project(projectId)
    const dispose = sync.activate()

    try {
      fakeDocument.visibilityState = 'visible'
      fakeDocument.hidden = false
      fakeDocument.dispatchEvent(new Event('visibilitychange'))

      await waitFor(() => gisFake.calls.length === 1)

      // Other path's fake never called.
      expect(tokenExchange.calls).toHaveLength(0)
      expect(gisFake.codeCalls).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('SET: a visibilitychange fired while document.hidden calls NEITHER fake', async () => {
    const { appId, projectId } = freshIds()
    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: REQUIRED_SCOPES,
      connectedAt: Date.now(),
    })
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 30_000))
    gisFake.queueResponse({
      access_token: 'should-not-be-used',
      expires_in: 3600,
      scope: REQUIRED_SCOPES.join(' '),
    })

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
      expect(gisFake.calls).toHaveLength(0)
      expect(gisFake.codeCalls).toHaveLength(0)
    } finally {
      dispose()
    }
  })

  it('SET but envelope missing: warm-up call site rejects NeedsReauthError (swallowed to logger.warn)', async () => {
    const { appId, projectId } = freshIds()
    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: REQUIRED_SCOPES,
      connectedAt: Date.now(),
    })
    // Conn present, no envelope, no token.
    const refreshEnvelopeSpy = vi.spyOn(envelopeModule, 'refreshEnvelope')
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    const sync = createDriveSync({
      appId,
      clientId: 'client-1',
      folderPath: [],
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
      logger,
    })
    sync.project(projectId)
    const dispose = sync.activate()

    try {
      fakeDocument.visibilityState = 'visible'
      fakeDocument.hidden = false
      fakeDocument.dispatchEvent(new Event('visibilitychange'))

      await waitFor(() => logger.warn.mock.calls.length === 1)

      expect(refreshEnvelopeSpy).toHaveBeenCalledTimes(1)
      await expect(refreshEnvelopeSpy.mock.results[0].value).rejects.toBeInstanceOf(NeedsReauthError)
      expect(logger.warn.mock.calls[0][1].err).toBeInstanceOf(NeedsReauthError)
      expect(gisFake.calls).toHaveLength(0)
      expect(gisFake.codeCalls).toHaveLength(0)
      expect(tokenExchange.calls).toHaveLength(0)
    } finally {
      dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Call site 4 — connection.ts getAccessToken (Picker path)
// ---------------------------------------------------------------------------
describe('T13 · call site: connection.ts getAccessToken (Picker path)', () => {
  let gisFake: GisFake
  let tokenExchange: TokenExchangeFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
    tokenExchange = createTokenExchangeFake({ now: () => Date.now() })
    tokenExchange.install()
  })

  afterEach(() => {
    tokenExchange.uninstall()
    gisFake.uninstall()
    vi.restoreAllMocks()
  })

  it('SET: stale token + stale envelope -> refreshEnvelope, never initCodeClient / initTokenClient', async () => {
    const { appId, projectId } = freshIds()
    await setToken(appId, projectId, {
      accessToken: 'stale-tok',
      expiresAt: Date.now() + MINUTE, // inside the 5-minute reuse buffer
      grantedScopes: [SCOPE],
    })
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 2 * MINUTE))

    const token = await getAccessToken({
      appId,
      projectId,
      clientId: 'client-x',
      scopes: [SCOPE],
      interactive: true,
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    })

    expect(token).toBe(tokenExchange.lastEnvelope?.payload.access_token)
    expect(tokenExchange.calls.map((c) => c.kind)).toEqual(['envelope'])
    // Other path's fake never called — no popup, no code client.
    expect(gisFake.calls).toHaveLength(0)
    expect(gisFake.codeCalls).toHaveLength(0)
  })

  it('UNSET: no cached token -> legacy GIS token flow, exchange fake untouched', async () => {
    const { appId, projectId } = freshIds()
    gisFake.queueResponse({
      access_token: 'fresh-tok',
      expires_in: 3600,
      scope: [SCOPE].join(' '),
    })

    const token = await getAccessToken({
      appId,
      projectId,
      clientId: 'client-y',
      scopes: [SCOPE],
      interactive: true,
    })

    expect(token).toBe('fresh-tok')
    expect(gisFake.calls).toHaveLength(1)
    // Other path's fake never called.
    expect(tokenExchange.calls).toHaveLength(0)
    expect(gisFake.codeCalls).toHaveLength(0)
  })

  it('SET but envelope missing: NeedsReauthError, no popup / initCodeClient / exchange POST', async () => {
    const { appId, projectId } = freshIds()

    const err = await getAccessToken({
      appId,
      projectId,
      clientId: 'client-x',
      scopes: [SCOPE],
      interactive: true,
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(NeedsReauthError)
    expect(err.reason).toBe('exchange_failed')
    expect(tokenExchange.calls).toHaveLength(0)
    expect(gisFake.calls).toHaveLength(0)
    expect(gisFake.codeCalls).toHaveLength(0)
  })
})
