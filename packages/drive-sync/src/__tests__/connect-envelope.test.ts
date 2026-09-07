import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, getConnection } from '../connection.js'
import { getConn, getToken, getEnvelope } from '../storage.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import { createTokenExchangeFake, type TokenExchangeFake } from '../testing/tokenExchangeFake.js'
import { NeedsReauthError } from '../errors.js'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
]

const TOKEN_EXCHANGE_URL = 'https://exchange.test/callback'

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `env-app-${idSeq}`, projectId: `env-proj-${idSeq}` }
}

describe('connect() — envelope (server-mediated token exchange) branch', () => {
  let gisFake: GisFake
  let tokenExchange: TokenExchangeFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
    tokenExchange = createTokenExchangeFake()
    tokenExchange.install()
  })

  afterEach(() => {
    tokenExchange.uninstall()
    gisFake.uninstall()
  })

  it('happy: acquires a code, exchanges it for an envelope, and persists envelope + token + conn', async () => {
    const { appId, projectId } = freshIds()
    gisFake.queueCodeResponse({ code: 'abc' })
    const fetchEmail = vi.fn().mockResolvedValue('user@example.com')

    const connected = await connect({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: SCOPES,
      fetchEmail,
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    })

    // Return shape.
    expect(connected.email).toBe('user@example.com')
    expect(connected.needsReauth).toBe(false)
    expect(typeof connected.expiresAt).toBe('number')

    // The exchange saw a `code` body, once.
    expect(tokenExchange.calls).toHaveLength(1)
    expect(tokenExchange.calls[0].kind).toBe('code')
    expect(tokenExchange.calls[0].body).toEqual({ code: 'abc' })

    const minted = tokenExchange.lastEnvelope!
    expect(minted).not.toBeNull()

    // fetchEmail called exactly once, with the minted access token.
    expect(fetchEmail).toHaveBeenCalledTimes(1)
    expect(fetchEmail).toHaveBeenCalledWith(minted.payload.access_token)

    // Envelope persisted verbatim.
    expect(await getEnvelope(appId, projectId)).toEqual(minted)

    // Token derived from the envelope payload.
    expect(await getToken(appId, projectId)).toEqual({
      accessToken: minted.payload.access_token,
      expiresAt: minted.payload.expiry_date,
      grantedScopes: minted.payload.scope.split(' ').filter(Boolean),
    })

    // Durable conn record.
    expect(await getConn(appId, projectId)).toMatchObject({
      email: 'user@example.com',
      grantedScopes: minted.payload.scope.split(' ').filter(Boolean),
    })

    // Envelope path never touched the legacy token client.
    expect(gisFake.calls).toHaveLength(0)
    expect(gisFake.codeCalls).toHaveLength(1)
    expect(gisFake.codeCalls[0].hint).toBeUndefined()
  })

  it('edge: a second connect() runs a fresh code flow and overwrites the envelope (no short-circuit on existing conn)', async () => {
    const { appId, projectId } = freshIds()

    gisFake.queueCodeResponse({ code: 'code-1' })
    await connect({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: SCOPES,
      fetchEmail: vi.fn().mockResolvedValue('user@example.com'),
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    })
    const firstEnvelope = await getEnvelope(appId, projectId)
    expect(firstEnvelope).not.toBeUndefined()

    gisFake.queueCodeResponse({ code: 'code-2' })
    await connect({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: SCOPES,
      fetchEmail: vi.fn().mockResolvedValue('user@example.com'),
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    })
    const secondEnvelope = await getEnvelope(appId, projectId)

    // A fresh code flow ran both times.
    expect(gisFake.codeCalls).toHaveLength(2)
    expect(tokenExchange.calls.map((c) => c.body)).toEqual([{ code: 'code-1' }, { code: 'code-2' }])

    // New grant -> new guid, and setEnvelope overwrote the stored record.
    expect(secondEnvelope!.guid).not.toBe(firstEnvelope!.guid)
    expect(secondEnvelope).toEqual(tokenExchange.lastEnvelope)

    // Second run passed the first run's stored email to GIS as a hint.
    expect(gisFake.codeCalls[1].hint).toBe('user@example.com')
  })

  it('error: a 400 from the exchange rejects with NeedsReauthError (exchange_failed) and persists nothing', async () => {
    const { appId, projectId } = freshIds()
    gisFake.queueCodeResponse({ code: 'abc' })
    tokenExchange.failMalformed()
    const fetchEmail = vi.fn()

    const rejection = await connect({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: SCOPES,
      fetchEmail,
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    }).then(
      () => 'resolved' as const,
      (e: unknown) => e
    )

    expect(rejection).toBeInstanceOf(NeedsReauthError)
    expect((rejection as NeedsReauthError).reason).toBe('exchange_failed')

    expect(fetchEmail).not.toHaveBeenCalled()
    expect(await getEnvelope(appId, projectId)).toBeUndefined()
    expect(await getToken(appId, projectId)).toBeUndefined()
    expect(await getConn(appId, projectId)).toBeUndefined()
  })

  it('error (legacy): with no tokenExchangeUrl, connect() runs the legacy token-client flow unchanged', async () => {
    const { appId, projectId } = freshIds()
    // Mirrors connection.test.ts "connect -> getConnection -> disconnect round trip".
    gisFake.queueResponse({
      access_token: 'tok-1',
      expires_in: 3600,
      scope: SCOPES.join(' '),
    })
    const fetchEmail = vi.fn().mockResolvedValue('user@example.com')

    const connected = await connect({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: SCOPES,
      fetchEmail,
    })

    expect(connected.email).toBe('user@example.com')
    expect(connected.needsReauth).toBe(false)
    expect(typeof connected.expiresAt).toBe('number')
    expect(fetchEmail).toHaveBeenCalledWith('tok-1')

    const fetched = await getConnection({ appId, projectId, requiredScopes: SCOPES })
    expect(fetched).toEqual({
      email: connected.email,
      needsReauth: false,
      expiresAt: connected.expiresAt,
    })

    // Legacy path used the token client, not the code client, and did not
    // hit the token-exchange endpoint.
    expect(gisFake.calls).toHaveLength(1)
    expect(gisFake.codeCalls).toHaveLength(0)
    expect(tokenExchange.calls).toHaveLength(0)
    // Nothing persisted an envelope in legacy mode.
    expect(await getEnvelope(appId, projectId)).toBeUndefined()
  })
})
