import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deriveToken,
  postExchange,
  postExchangeWithRetry,
  EnvelopeRevokedError,
} from '../envelope.js'
import { refreshEnvelope } from '../envelope.js'
import { NeedsReauthError } from '../errors.js'
import { connect, disconnect, getAccessToken } from '../connection.js'
import {
  getConn,
  getEnvelope,
  getToken,
  setConn,
  setEnvelope,
  setToken,
} from '../storage.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import {
  createTokenExchangeFake,
  type TokenExchangeFake,
} from '../testing/index.js'
import type { Logger } from '../logger.js'
import type { Envelope } from '../types.js'

const URL = 'https://exchange.example/token'

function makeEnvelope(): Envelope {
  return {
    v: 2,
    guid: 'guid-abc-123',
    payload: {
      access_token: 'ya29.a0-access-token',
      expiry_date: 1_900_000_000_000,
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/drive.file',
    },
    sig: 'deadbeefsignature==',
  }
}

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function badBodyRes(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON')
    },
  } as unknown as Response
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe('envelope.ts unit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('deriveToken', () => {
    it('maps payload fields onto StoredToken and splits scope on spaces', () => {
      const token = deriveToken({
        access_token: 'tok',
        expiry_date: 123,
        token_type: 'Bearer',
        scope: 'https://a/scope1  https://a/scope2 ',
      })
      expect(token).toEqual({
        accessToken: 'tok',
        expiresAt: 123,
        grantedScopes: ['https://a/scope1', 'https://a/scope2'],
      })
    })
  })

  describe('postExchange', () => {
    it('happy: resolves the envelope object from a 200 { envelope } body unchanged', async () => {
      const envelope = makeEnvelope()
      const fetchMock = vi.fn().mockResolvedValue(jsonRes(200, { envelope }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(postExchange(URL, { code: 'auth-code' })).resolves.toBe(envelope)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [calledUrl, init] = fetchMock.mock.calls[0]
      expect(calledUrl).toBe(URL)
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(init.body).toBe(JSON.stringify({ code: 'auth-code' }))
      expect(init.credentials).toBeUndefined()
    })

    it('error: 400 with an error code -> NeedsReauthError(exchange_failed), no retry, logger.error once', async () => {
      const logger = makeLogger()
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonRes(400, { error: { code: 'malformed_request' } }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        postExchange(URL, { code: 'bad' }, logger)
      ).rejects.toMatchObject({ name: 'NeedsReauthError', reason: 'exchange_failed' })

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(logger.error).toHaveBeenCalledTimes(1)
    })

    it('error: 410 refresh_token_revoked -> EnvelopeRevokedError (reason refresh_token_revoked), no retry', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonRes(410, { error: { code: 'refresh_token_revoked' } }))
      vi.stubGlobal('fetch', fetchMock)

      const err = await postExchange(URL, { envelope: makeEnvelope() }).catch((e) => e)
      expect(err).toBeInstanceOf(EnvelopeRevokedError)
      expect(err).toBeInstanceOf(NeedsReauthError)
      expect(err.reason).toBe('refresh_token_revoked')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('edge: bare 410 (no structured body) still maps to EnvelopeRevokedError', async () => {
      const fetchMock = vi.fn().mockResolvedValue(badBodyRes(410))
      vi.stubGlobal('fetch', fetchMock)

      await expect(postExchange(URL, { code: 'c' })).rejects.toBeInstanceOf(
        EnvelopeRevokedError
      )
    })
  })

  describe('postExchangeWithRetry', () => {
    it('edge: network TypeError then 200 -> resolves after one 500ms wait', async () => {
      const envelope = makeEnvelope()
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(jsonRes(200, { envelope }))
      vi.stubGlobal('fetch', fetchMock)

      const p = postExchangeWithRetry(URL, { code: 'c' })

      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(500)
      await expect(p).resolves.toBe(envelope)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('edge: 502, 502, 200 -> resolves after 500ms then 1500ms waits', async () => {
      const envelope = makeEnvelope()
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonRes(502, { error: { code: 'bad_gateway' } }))
        .mockResolvedValueOnce(jsonRes(502, { error: { code: 'bad_gateway' } }))
        .mockResolvedValueOnce(jsonRes(200, { envelope }))
      vi.stubGlobal('fetch', fetchMock)

      const p = postExchangeWithRetry(URL, { code: 'c' })

      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(500)
      expect(fetchMock).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(1500)
      await expect(p).resolves.toBe(envelope)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('error: 502 x3 -> rejects NeedsReauthError(exchange_unavailable)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonRes(502, { error: { code: 'bad_gateway' } }))
      vi.stubGlobal('fetch', fetchMock)

      const p = postExchangeWithRetry(URL, { code: 'c' })
      const assertion = expect(p).rejects.toMatchObject({
        name: 'NeedsReauthError',
        reason: 'exchange_unavailable',
      })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(500)
      await vi.advanceTimersByTimeAsync(1500)

      await assertion
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('error: 400 propagates immediately without retrying', async () => {
      const logger = makeLogger()
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonRes(400, { error: { code: 'malformed_request' } }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        postExchangeWithRetry(URL, { code: 'c' }, logger)
      ).rejects.toMatchObject({ name: 'NeedsReauthError', reason: 'exchange_failed' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('error: 410 propagates immediately as EnvelopeRevokedError without retrying', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonRes(410, { error: { code: 'refresh_token_revoked' } }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        postExchangeWithRetry(URL, { envelope: makeEnvelope() })
      ).rejects.toBeInstanceOf(EnvelopeRevokedError)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})

// ---------------------------------------------------------------------------
// T12 — a standalone core-paths spec for the server-mediated token-exchange
// ("envelope") feature: connect(code)->envelope, refreshEnvelope freshness
// gating / coalescing / 410 handling, postExchangeWithRetry 502 backoff,
// disconnect revoke+clear, and a guard that the legacy client-side flow is
// untouched when `tokenExchangeUrl` is absent. Every case but the 502-backoff
// one runs on REAL timers: it touches IndexedDB via ../storage.js against
// `fake-indexeddb`, whose async request/transaction machinery needs real
// macrotask scheduling (mirrors refresh-envelope.test.ts). The 502 case
// drives `postExchangeWithRetry` directly under `vi.useFakeTimers()`, exactly
// like the `postExchangeWithRetry` cases in the block above.
// ---------------------------------------------------------------------------
describe('envelope mode — core paths (T12)', () => {
  const EXCHANGE_URL = 'https://exchange.example/callback'
  const SCOPE = 'https://www.googleapis.com/auth/drive.file'
  const SCOPES = [SCOPE, 'https://www.googleapis.com/auth/userinfo.email']
  const MIN = 60_000

  let seq = 0
  function nextIds(): { appId: string; projectId: string } {
    seq += 1
    return { appId: `t12-app-${seq}`, projectId: `t12-proj-${seq}` }
  }

  function envelopeExpiring(expiryDate: number): Envelope {
    return {
      v: 2,
      guid: `t12-guid-${seq}`,
      payload: {
        access_token: `ya29.t12-${seq}`,
        expiry_date: expiryDate,
        token_type: 'Bearer',
        scope: SCOPE,
      },
      sig: 'sig==',
    }
  }

  function tokenBroadcasts(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
    return spy.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'token'
    )
  }

  let gis: GisFake
  let exchange: TokenExchangeFake
  let postSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    gis = createGisFake()
    gis.install()
    exchange = createTokenExchangeFake({ now: () => Date.now() })
    exchange.install()
    postSpy = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
  })

  afterEach(() => {
    exchange.uninstall()
    gis.uninstall()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('connect(code) -> envelope: persists envelope + token + conn, calls fetchEmail exactly once', async () => {
    const { appId, projectId } = nextIds()
    gis.queueCodeResponse({ code: 'auth-code-xyz' })
    const fetchEmail = vi.fn().mockResolvedValue('user@example.com')

    const conn = await connect({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: SCOPES,
      fetchEmail,
      tokenExchangeUrl: EXCHANGE_URL,
    })

    expect(conn).toMatchObject({ email: 'user@example.com', needsReauth: false })
    expect(typeof conn.expiresAt).toBe('number')
    expect(fetchEmail).toHaveBeenCalledTimes(1)

    // Exchange saw a single `code` body.
    expect(exchange.calls).toHaveLength(1)
    expect(exchange.calls[0].kind).toBe('code')
    expect(exchange.calls[0].body).toEqual({ code: 'auth-code-xyz' })

    const minted = exchange.lastEnvelope!
    expect(minted).not.toBeNull()
    expect(fetchEmail).toHaveBeenCalledWith(minted.payload.access_token)

    // All three keys persisted.
    expect(await getEnvelope(appId, projectId)).toEqual(minted)
    expect(await getToken(appId, projectId)).toEqual({
      accessToken: minted.payload.access_token,
      expiresAt: minted.payload.expiry_date,
      grantedScopes: minted.payload.scope.split(' ').filter(Boolean),
    })
    expect(await getConn(appId, projectId)).toMatchObject({
      email: 'user@example.com',
      grantedScopes: minted.payload.scope.split(' ').filter(Boolean),
    })

    // Legacy token client never touched.
    expect(gis.calls).toHaveLength(0)
    expect(gis.codeCalls).toHaveLength(1)
  })

  it('refreshEnvelope fresh echo: stored envelope 30min out -> no fetch, no broadcast', async () => {
    const { appId, projectId } = nextIds()
    const env = envelopeExpiring(Date.now() + 30 * MIN)
    await setEnvelope(appId, projectId, env)

    const token = await refreshEnvelope({
      appId,
      projectId,
      tokenExchangeUrl: EXCHANGE_URL,
    })

    expect(token).toEqual({
      accessToken: env.payload.access_token,
      expiresAt: env.payload.expiry_date,
      grantedScopes: [SCOPE],
    })
    expect(exchange.calls).toHaveLength(0)
    expect(tokenBroadcasts(postSpy)).toHaveLength(0)
  })

  it('refreshEnvelope stale refresh: envelope 2min out -> POST { envelope }, persist, one token broadcast', async () => {
    const { appId, projectId } = nextIds()
    await setEnvelope(appId, projectId, envelopeExpiring(Date.now() + 2 * MIN))

    const token = await refreshEnvelope({
      appId,
      projectId,
      tokenExchangeUrl: EXCHANGE_URL,
    })

    expect(exchange.calls).toHaveLength(1)
    expect(exchange.calls[0].kind).toBe('envelope')

    const refreshed = exchange.lastEnvelope!
    expect(token.accessToken).toBe(refreshed.payload.access_token)
    expect(await getEnvelope(appId, projectId)).toEqual(refreshed)
    expect(await getToken(appId, projectId)).toEqual(token)

    const broadcasts = tokenBroadcasts(postSpy)
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0][0]).toMatchObject({ type: 'token', projectId })
  })

  it('refreshEnvelope 410: clears envelope + token + conn, throws NeedsReauthError(refresh_token_revoked)', async () => {
    const { appId, projectId } = nextIds()
    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: [SCOPE],
      connectedAt: Date.now(),
    })
    await setToken(appId, projectId, {
      accessToken: 'stale',
      expiresAt: Date.now() + 2 * MIN,
      grantedScopes: [SCOPE],
    })
    await setEnvelope(appId, projectId, envelopeExpiring(Date.now() + 2 * MIN))
    exchange.fail410()

    const err = await refreshEnvelope({
      appId,
      projectId,
      tokenExchangeUrl: EXCHANGE_URL,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(NeedsReauthError)
    expect(err.reason).toBe('refresh_token_revoked')
    expect(await getEnvelope(appId, projectId)).toBeUndefined()
    expect(await getToken(appId, projectId)).toBeUndefined()
    expect(await getConn(appId, projectId)).toBeUndefined()
  })

  it('postExchangeWithRetry 502x3: waits 500ms then 1500ms, then throws NeedsReauthError(exchange_unavailable)', async () => {
    vi.useFakeTimers()
    exchange.fail502(3)

    const p = postExchangeWithRetry(EXCHANGE_URL, {
      envelope: envelopeExpiring(Date.now() + 2 * MIN),
    })
    const assertion = expect(p).rejects.toMatchObject({
      name: 'NeedsReauthError',
      reason: 'exchange_unavailable',
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(exchange.calls).toHaveLength(1)

    // First backoff is exactly 500ms.
    await vi.advanceTimersByTimeAsync(499)
    expect(exchange.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(exchange.calls).toHaveLength(2)

    // Second backoff is exactly 1500ms.
    await vi.advanceTimersByTimeAsync(1499)
    expect(exchange.calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(exchange.calls).toHaveLength(3)

    await assertion
  })

  it('disconnect (envelope mode): revokes payload.access_token and clears envelope + token + conn', async () => {
    const { appId, projectId } = nextIds()
    const env = envelopeExpiring(Date.now() + 30 * MIN)
    await setEnvelope(appId, projectId, env)
    await setToken(appId, projectId, {
      accessToken: env.payload.access_token,
      expiresAt: env.payload.expiry_date,
      grantedScopes: [SCOPE],
    })
    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: [SCOPE],
      connectedAt: Date.now(),
    })

    const revokeFn = vi.fn().mockResolvedValue(undefined)
    await disconnect({ appId, projectId, revokeFn, tokenExchangeUrl: EXCHANGE_URL })

    expect(revokeFn).toHaveBeenCalledWith(env.payload.access_token)
    expect(await getEnvelope(appId, projectId)).toBeUndefined()
    expect(await getToken(appId, projectId)).toBeUndefined()
    expect(await getConn(appId, projectId)).toBeUndefined()
  })

  it('refreshEnvelope coalescing: two concurrent stale calls for one projectId -> a single exchange fetch, same token', async () => {
    const { appId, projectId } = nextIds()
    await setEnvelope(appId, projectId, envelopeExpiring(Date.now() + 2 * MIN))

    const [a, b] = await Promise.all([
      refreshEnvelope({ appId, projectId, tokenExchangeUrl: EXCHANGE_URL }),
      refreshEnvelope({ appId, projectId, tokenExchangeUrl: EXCHANGE_URL }),
    ])

    expect(exchange.calls).toHaveLength(1)
    expect(exchange.calls[0].kind).toBe('envelope')
    expect(a).toBe(b)
  })

  it('legacy connect() (no tokenExchangeUrl): uses initTokenClient; exchange fake stays empty', async () => {
    const { appId, projectId } = nextIds()
    gis.queueResponse({
      access_token: 'legacy-tok',
      expires_in: 3600,
      scope: SCOPES.join(' '),
    })
    const fetchEmail = vi.fn().mockResolvedValue('user@example.com')

    const conn = await connect({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: SCOPES,
      fetchEmail,
    })

    expect(conn.email).toBe('user@example.com')
    expect(fetchEmail).toHaveBeenCalledWith('legacy-tok')
    expect(gis.calls).toHaveLength(1)
    expect(gis.codeCalls).toHaveLength(0)
    expect(exchange.calls).toHaveLength(0)
    expect(await getEnvelope(appId, projectId)).toBeUndefined()
  })

  it('legacy getAccessToken() (no tokenExchangeUrl): uses the GIS token flow; exchange fake stays empty', async () => {
    const { appId, projectId } = nextIds()
    gis.queueResponse({
      access_token: 'fresh-legacy-tok',
      expires_in: 3600,
      scope: SCOPES.join(' '),
    })

    const token = await getAccessToken({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: SCOPES,
      interactive: true,
    })

    expect(token).toBe('fresh-legacy-tok')
    expect(gis.calls).toHaveLength(1)
    expect(gis.codeCalls).toHaveLength(0)
    expect(exchange.calls).toHaveLength(0)
  })
})
