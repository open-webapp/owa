import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshEnvelope } from '../envelope.js'
import { NeedsReauthError } from '../errors.js'
import {
  notifyExternalEnvelopeRefresh,
  consumeExternalEnvelopeRefresh,
} from '../token.js'
import {
  getConn,
  setConn,
  getEnvelope,
  setEnvelope,
  getToken,
  setToken,
} from '../storage.js'
import { createTokenExchangeFake, type TokenExchangeFake } from '../testing/index.js'
import type { Envelope } from '../types.js'

const TOKEN_EXCHANGE_URL = 'https://exchange.example/callback'
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const MINUTE = 60_000

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `renv-app-${idSeq}`, projectId: `renv-proj-${idSeq}` }
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

describe('refreshEnvelope (T4)', () => {
  let tokenExchange: TokenExchangeFake
  let postSpy: ReturnType<typeof vi.spyOn>

  // NOTE: this spec deliberately runs on REAL timers. It touches IndexedDB on
  // every case (via ../storage.js against `fake-indexeddb`), and
  // `fake-indexeddb`'s async request/transaction machinery depends on real
  // macrotask scheduling — installing `vi.useFakeTimers()` without pumping it
  // makes every IndexedDB read/write hang forever. None of the six scenarios
  // here assert on retry delays, so there is nothing that needs a fake clock
  // (mirrors token-coalescing.test.ts / refresh.test.ts, which also combine
  // storage with the module fakes on real timers).
  beforeEach(() => {
    tokenExchange = createTokenExchangeFake({ now: () => Date.now() })
    tokenExchange.install()
    postSpy = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
  })

  afterEach(() => {
    tokenExchange.uninstall()
    postSpy.mockRestore()
    vi.restoreAllMocks()
  })

  it('happy (fresh echo): returns the derived token with no network call and no broadcast', async () => {
    const { appId, projectId } = freshIds()
    const env = makeEnvelope(Date.now() + 30 * MINUTE)
    await setEnvelope(appId, projectId, env)

    const token = await refreshEnvelope({ appId, projectId, tokenExchangeUrl: TOKEN_EXCHANGE_URL })

    expect(token).toEqual({
      accessToken: env.payload.access_token,
      expiresAt: env.payload.expiry_date,
      grantedScopes: [SCOPE],
    })
    expect(tokenExchange.calls).toHaveLength(0)
    expect(postSpy).not.toHaveBeenCalled()
  })

  it('happy (stale refresh): POSTs { envelope }, persists envelope + derived token, broadcasts once', async () => {
    const { appId, projectId } = freshIds()
    const env = makeEnvelope(Date.now() + 2 * MINUTE)
    await setEnvelope(appId, projectId, env)

    const token = await refreshEnvelope({ appId, projectId, tokenExchangeUrl: TOKEN_EXCHANGE_URL })

    expect(tokenExchange.calls).toHaveLength(1)
    expect(tokenExchange.calls[0].kind).toBe('envelope')

    const returnedEnvelope = tokenExchange.lastEnvelope as Envelope
    expect(await getEnvelope(appId, projectId)).toEqual(returnedEnvelope)
    expect(await getToken(appId, projectId)).toEqual(token)
    expect(token.accessToken).toBe(returnedEnvelope.payload.access_token)

    const tokenBroadcasts = postSpy.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'token'
    )
    expect(tokenBroadcasts).toHaveLength(1)
    expect(tokenBroadcasts[0][0]).toMatchObject({ type: 'token', projectId })
  })

  it('edge (coalescing): two concurrent stale calls share one fetch and resolve to the same token', async () => {
    const { appId, projectId } = freshIds()
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 2 * MINUTE))

    const [a, b] = await Promise.all([
      refreshEnvelope({ appId, projectId, tokenExchangeUrl: TOKEN_EXCHANGE_URL }),
      refreshEnvelope({ appId, projectId, tokenExchangeUrl: TOKEN_EXCHANGE_URL }),
    ])

    expect(tokenExchange.calls).toHaveLength(1)
    expect(a).toBe(b)
  })

  it('edge (cross-tab): a pending external signal + fresh stored envelope returns from storage, no fetch', async () => {
    const { appId, projectId } = freshIds()
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 30 * MINUTE))

    notifyExternalEnvelopeRefresh(projectId)
    const token = await refreshEnvelope({ appId, projectId, tokenExchangeUrl: TOKEN_EXCHANGE_URL })

    expect(token.accessToken).toBe(`ya29.token-${idSeq}`)
    expect(tokenExchange.calls).toHaveLength(0)
    // The one-shot signal was drained.
    expect(consumeExternalEnvelopeRefresh(projectId)).toBe(false)
  })

  it('error (no envelope): rejects NeedsReauthError(exchange_failed) with no fetch', async () => {
    const { appId, projectId } = freshIds()

    await expect(
      refreshEnvelope({ appId, projectId, tokenExchangeUrl: TOKEN_EXCHANGE_URL })
    ).rejects.toMatchObject({ name: 'NeedsReauthError', reason: 'exchange_failed' })

    expect(tokenExchange.calls).toHaveLength(0)
  })

  it('error (410): clears conn + token + envelope and rejects NeedsReauthError(refresh_token_revoked)', async () => {
    const { appId, projectId } = freshIds()
    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: [SCOPE],
      connectedAt: Date.now(),
    })
    await setToken(appId, projectId, {
      accessToken: 'stale',
      expiresAt: Date.now() + 2 * MINUTE,
      grantedScopes: [SCOPE],
    })
    await setEnvelope(appId, projectId, makeEnvelope(Date.now() + 2 * MINUTE))
    tokenExchange.fail410()

    const err = await refreshEnvelope({
      appId,
      projectId,
      tokenExchangeUrl: TOKEN_EXCHANGE_URL,
    }).catch((e) => e)

    expect(err).toBeInstanceOf(NeedsReauthError)
    expect(err.reason).toBe('refresh_token_revoked')
    expect(await getConn(appId, projectId)).toBeUndefined()
    expect(await getToken(appId, projectId)).toBeUndefined()
    expect(await getEnvelope(appId, projectId)).toBeUndefined()
  })
})
