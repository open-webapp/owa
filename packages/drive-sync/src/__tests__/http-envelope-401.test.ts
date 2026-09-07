import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { driveFetch } from '../http.js'
import * as envelopeModule from '../envelope.js'
import * as tokenModule from '../token.js'
import * as storageModule from '../storage.js'
import { NeedsReauthError } from '../errors.js'
import {
  getConn,
  getEnvelope,
  getToken,
  setConn,
  setEnvelope,
  setToken,
} from '../storage.js'
import { createTokenExchangeFake, type TokenExchangeFake } from '../testing/index.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import { REQUIRED_SCOPES } from '../files.js'
import type { Envelope } from '../types.js'

const TOKEN_EXCHANGE_URL = 'https://exchange.example/callback'
const DRIVE_URL = 'https://www.googleapis.com/drive/v3/files/file-1?alt=media'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const MINUTE = 60_000

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `henv-app-${idSeq}`, projectId: `henv-proj-${idSeq}` }
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

/**
 * A minimal Drive-endpoint fetch double: every call is recorded, and each
 * response status is taken from `queue` (default 200). A 200 returns a small
 * JSON body; anything else returns a JSON error body with that status.
 * Non-Drive URLs never reach here — the tokenExchangeFake installed on top
 * only delegates through for URLs it does not own.
 */
function createDriveResponder() {
  const queue: number[] = []
  const requests: string[] = []
  const fetchImpl = (async (input: unknown, _init?: RequestInit): Promise<Response> => {
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

// Real timers throughout: every case touches IndexedDB via ../storage.js
// against fake-indexeddb, whose async machinery needs real macrotask
// scheduling, and none of these cases assert on retry delays (a 401 is not a
// retryable status in performFetch, so there is no backoff sleep to pump).
describe('driveFetch — envelope-mode 401 recovery (T8)', () => {
  let tokenExchange: TokenExchangeFake
  let drive: ReturnType<typeof createDriveResponder>
  let refreshEnvelopeSpy: ReturnType<typeof vi.spyOn>
  let acquireTokenSpy: ReturnType<typeof vi.spyOn>
  let clearTokenSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    drive = createDriveResponder()
    vi.stubGlobal('fetch', drive.fetchImpl)
    tokenExchange = createTokenExchangeFake({ now: () => Date.now() })
    tokenExchange.install()

    refreshEnvelopeSpy = vi.spyOn(envelopeModule, 'refreshEnvelope')
    acquireTokenSpy = vi.spyOn(tokenModule, 'acquireToken')
    clearTokenSpy = vi.spyOn(storageModule, 'clearToken')
  })

  afterEach(() => {
    tokenExchange.uninstall()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function envelopeFetch(overrides: Partial<Parameters<typeof driveFetch>[0]> = {}) {
    return driveFetch({
      appId: overrides.appId as string,
      projectId: overrides.projectId as string,
      clientId: 'client-1',
      url: DRIVE_URL,
      requiredScopes: [SCOPE],
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
      ...overrides,
    })
  }

  it('happy: Drive 401 once, then 200 — token cleared, refreshEnvelope drives the retry, original request retried once', async () => {
    const { appId, projectId } = freshIds()
    // Valid cached token so the fast path serves the first attempt; a stale
    // envelope so the 401-triggered refreshEnvelope actually POSTs.
    await setToken(appId, projectId, {
      accessToken: 'ya29.cached',
      expiresAt: Date.now() + 60 * MINUTE,
      grantedScopes: [SCOPE],
    })
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 2 * MINUTE))
    drive.queue.push(401, 200)

    const res = await envelopeFetch({ appId, projectId })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, id: 'file-1' })
    // token key cleared before the refresh (decision 4/8: token key ONLY).
    expect(clearTokenSpy).toHaveBeenCalledTimes(1)
    expect(clearTokenSpy).toHaveBeenCalledWith(appId, projectId)
    // Recovery went through refreshEnvelope, never GIS.
    expect(refreshEnvelopeSpy).toHaveBeenCalled()
    expect(acquireTokenSpy).not.toHaveBeenCalled()
    // Original request retried exactly once (2 Drive hits total).
    expect(drive.requests).toEqual([DRIVE_URL, DRIVE_URL])
    // The exchange was actually hit for a refresh.
    expect(tokenExchange.calls.map((c) => c.kind)).toEqual(['envelope'])
  })

  it('edge: Drive 401 then 401 — NeedsReauthError, refreshEnvelope called exactly once', async () => {
    const { appId, projectId } = freshIds()
    await setToken(appId, projectId, {
      accessToken: 'ya29.cached',
      expiresAt: Date.now() + 60 * MINUTE,
      grantedScopes: [SCOPE],
    })
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 2 * MINUTE))
    drive.queue.push(401, 401)

    await expect(envelopeFetch({ appId, projectId })).rejects.toBeInstanceOf(NeedsReauthError)

    expect(refreshEnvelopeSpy).toHaveBeenCalledTimes(1)
    expect(acquireTokenSpy).not.toHaveBeenCalled()
    // One retry only: original + one post-refresh attempt.
    expect(drive.requests).toEqual([DRIVE_URL, DRIVE_URL])
  })

  it('edge: refreshEnvelope hits a 410 — conn + token + envelope cleared, NeedsReauthError(refresh_token_revoked) propagates', async () => {
    const { appId, projectId } = freshIds()
    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: [SCOPE],
      connectedAt: Date.now(),
    })
    await setToken(appId, projectId, {
      accessToken: 'ya29.cached',
      expiresAt: Date.now() + 60 * MINUTE,
      grantedScopes: [SCOPE],
    })
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 2 * MINUTE))
    drive.queue.push(401)
    tokenExchange.fail410()

    const err = await envelopeFetch({ appId, projectId }).catch((e) => e)

    expect(err).toBeInstanceOf(NeedsReauthError)
    expect(err.reason).toBe('refresh_token_revoked')
    expect(acquireTokenSpy).not.toHaveBeenCalled()
    expect(await getConn(appId, projectId)).toBeUndefined()
    expect(await getToken(appId, projectId)).toBeUndefined()
    expect(await getEnvelope(appId, projectId)).toBeUndefined()
  })
})

// The legacy (GIS) branch must be untouched when `tokenExchangeUrl` is
// absent: a 401 that still 401s after one silent refresh surfaces as a typed
// NeedsReauthError, exactly as regressions.test.ts R7 asserts
// (`rejects.toBeInstanceOf(NeedsReauthError)`).
describe('driveFetch — legacy 401 path unchanged when tokenExchangeUrl absent', () => {
  let gisFake: GisFake
  let drive: ReturnType<typeof createDriveResponder>
  let refreshEnvelopeSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
    drive = createDriveResponder()
    vi.stubGlobal('fetch', drive.fetchImpl)
    refreshEnvelopeSpy = vi.spyOn(envelopeModule, 'refreshEnvelope')
  })

  afterEach(() => {
    gisFake.uninstall()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('error (legacy): 401 twice, no tokenExchangeUrl — NeedsReauthError, refreshEnvelope never called', async () => {
    const { appId, projectId } = freshIds()
    drive.queue.push(401, 401)
    gisFake.queueResponse({ access_token: 'tok-1', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    gisFake.queueResponse({ access_token: 'tok-2', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })

    await expect(
      driveFetch({
        appId,
        projectId,
        clientId: 'client-1',
        url: DRIVE_URL,
        requiredScopes: REQUIRED_SCOPES,
      })
    ).rejects.toBeInstanceOf(NeedsReauthError)

    expect(refreshEnvelopeSpy).not.toHaveBeenCalled()
  })
})
