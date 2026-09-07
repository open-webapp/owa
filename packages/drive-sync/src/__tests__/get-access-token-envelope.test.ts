import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getAccessToken } from '../connection.js'
import { getToken, setToken, setEnvelope } from '../storage.js'
import { NeedsReauthError } from '../errors.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import { createTokenExchangeFake, type TokenExchangeFake } from '../testing/index.js'
import type { Envelope } from '../types.js'

// This spec deliberately runs on REAL timers: every case touches IndexedDB via
// ../storage.js against `fake-indexeddb`, whose async request/transaction
// machinery needs real macrotask scheduling (installing fake timers without
// pumping them hangs every read/write). Nothing here asserts on retry delays.
// Mirrors token-coalescing.test.ts / refresh-envelope.test.ts.

const TOKEN_EXCHANGE_URL = 'https://exchange.example/callback'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const SCOPES = [SCOPE]
const MINUTE = 60_000

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `gate-app-${idSeq}`, projectId: `gate-proj-${idSeq}` }
}

function makeEnvelope(expiryDate: number): Envelope {
  return {
    v: 2,
    guid: `guid-${idSeq}`,
    payload: {
      access_token: `ya29.token-${idSeq}`,
      expiry_date: expiryDate,
      token_type: 'Bearer',
      scope: SCOPE,
    },
    sig: 'sig==',
  }
}

describe('getAccessToken — envelope (server-mediated) mode (T6)', () => {
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
  })

  it('happy (fresh cache): a comfortably-valid cached token is returned as-is, with no token-exchange call', async () => {
    const { appId, projectId } = freshIds()
    await setToken(appId, projectId, {
      accessToken: 'cached-tok',
      expiresAt: Date.now() + 60 * MINUTE,
      grantedScopes: SCOPES,
    })

    const token = await getAccessToken({
      appId,
      projectId,
      clientId: 'client-x',
      scopes: SCOPES,
      interactive: false,
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    })

    expect(token).toBe('cached-tok')
    expect(tokenExchange.calls).toHaveLength(0)
    expect(gisFake.calls).toHaveLength(0)
    expect(gisFake.codeCalls).toHaveLength(0)
  })

  it('happy (stale): a near-expiry cached token + stale stored envelope round-trips refreshEnvelope and returns the new access token', async () => {
    const { appId, projectId } = freshIds()
    await setToken(appId, projectId, {
      accessToken: 'stale-tok',
      expiresAt: Date.now() + 1 * MINUTE, // inside the 5-minute reuse buffer
      grantedScopes: SCOPES,
    })
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 2 * MINUTE))

    const token = await getAccessToken({
      appId,
      projectId,
      clientId: 'client-x',
      scopes: SCOPES,
      interactive: false,
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    })

    expect(tokenExchange.calls).toHaveLength(1)
    expect(tokenExchange.calls[0].kind).toBe('envelope')

    const refreshed = tokenExchange.lastEnvelope as Envelope
    expect(token).toBe(refreshed.payload.access_token)
    expect(token).not.toBe('stale-tok')
    // refreshEnvelope persisted the derived token.
    expect(await getToken(appId, projectId)).toEqual({
      accessToken: refreshed.payload.access_token,
      expiresAt: refreshed.payload.expiry_date,
      grantedScopes: [SCOPE],
    })
    // Never fell through to the interactive flow.
    expect(gisFake.calls).toHaveLength(0)
    expect(gisFake.codeCalls).toHaveLength(0)
  })

  it('error (not connected): no envelope and no token rejects NeedsReauthError, with no popup / initCodeClient', async () => {
    const { appId, projectId } = freshIds()

    const err = await getAccessToken({
      appId,
      projectId,
      clientId: 'client-x',
      scopes: SCOPES,
      interactive: true,
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(NeedsReauthError)
    expect(err.reason).toBe('exchange_failed')
    expect(tokenExchange.calls).toHaveLength(0)
    expect(gisFake.calls).toHaveLength(0)
    expect(gisFake.codeCalls).toHaveLength(0)
  })

  it('error (legacy path unaffected): with no tokenExchangeUrl and no cached token, the GIS token flow is still used', async () => {
    // Copied from connection.test.ts "acquires a fresh token when none is
    // cached, and returns the raw access token string".
    const { appId, projectId } = freshIds()
    gisFake.queueResponse({
      access_token: 'fresh-tok',
      expires_in: 3600,
      scope: SCOPES.join(' '),
    })

    const token = await getAccessToken({
      appId,
      projectId,
      clientId: 'client-y',
      scopes: SCOPES,
      interactive: true,
    })

    expect(token).toBe('fresh-tok')
    expect(gisFake.calls).toHaveLength(1)
    expect(tokenExchange.calls).toHaveLength(0)
  })
})
