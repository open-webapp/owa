import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, getConnection, disconnect, getAccessToken } from '../connection.js'
import { getConn, getToken, clearToken, setToken } from '../storage.js'
import { createBroadcast } from '../broadcast.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
]

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `app-${idSeq}`, projectId: `proj-${idSeq}` }
}

/** Flushes the BroadcastChannel's async message delivery (same helper used by broadcast.test.ts). */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('connection round trip (connect / getConnection / disconnect)', () => {
  let gisFake: GisFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
  })

  afterEach(() => {
    gisFake.uninstall()
  })

  it('getConnection() before any connect() call returns null', async () => {
    const { appId, projectId } = freshIds()
    const result = await getConnection({ appId, projectId, requiredScopes: SCOPES })
    expect(result).toBeNull()
  })

  it('connect -> getConnection -> disconnect round trip', async () => {
    const { appId, projectId } = freshIds()
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

    const revokeFn = vi.fn().mockResolvedValue(undefined)
    await disconnect({ appId, projectId, revokeFn })
    expect(revokeFn).toHaveBeenCalledWith('tok-1')

    const afterDisconnect = await getConnection({ appId, projectId, requiredScopes: SCOPES })
    expect(afterDisconnect).toBeNull()
  })

  it('needsReauth is true when granted scopes do not cover requiredScopes, with no network calls', async () => {
    const { appId, projectId } = freshIds()
    // Only grant one of the two scopes.
    gisFake.queueResponse({
      access_token: 'tok-2',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/drive.file',
    })
    const fetchEmail = vi.fn().mockResolvedValue('partial@example.com')

    await connect({
      appId,
      projectId,
      clientId: 'client-2',
      scopes: SCOPES,
      fetchEmail,
    })

    const callsBefore = gisFake.calls.length

    const result = await getConnection({ appId, projectId, requiredScopes: SCOPES })

    expect(result?.needsReauth).toBe(true)
    expect(result?.email).toBe('partial@example.com')
    // getConnection must not have triggered any additional GIS/network calls.
    expect(gisFake.calls.length).toBe(callsBefore)
  })

  it('disconnect() with nothing connected does not throw and does not call revokeFn', async () => {
    const { appId, projectId } = freshIds()
    const revokeFn = vi.fn().mockResolvedValue(undefined)

    await expect(disconnect({ appId, projectId, revokeFn })).resolves.toBeUndefined()
    expect(revokeFn).not.toHaveBeenCalled()
  })

  it('#12 — expiry clears only the token key; the durable conn record survives and getConnection() still resolves the email, with expiresAt reflecting the missing token', async () => {
    const { appId, projectId } = freshIds()
    gisFake.queueResponse({
      access_token: 'tok-3',
      expires_in: 3600,
      scope: SCOPES.join(' '),
    })
    const fetchEmail = vi.fn().mockResolvedValue('expiring@example.com')

    await connect({ appId, projectId, clientId: 'client-3', scopes: SCOPES, fetchEmail })

    // Sanity: both durable and ephemeral records exist right after connect().
    expect(await getConn(appId, projectId)).not.toBeUndefined()
    expect(await getToken(appId, projectId)).not.toBeUndefined()

    // Simulate token expiry: clear ONLY the ephemeral token key, leaving the
    // durable `conn` record (email + grantedScopes) untouched — mirrors what
    // an expired/evicted cached token looks like in storage.
    await clearToken(appId, projectId)
    expect(await getConn(appId, projectId)).not.toBeUndefined()
    expect(await getToken(appId, projectId)).toBeUndefined()

    const afterExpiry = await getConnection({ appId, projectId, requiredScopes: SCOPES })
    expect(afterExpiry?.email).toBe('expiring@example.com')
    // needsReauth is derived purely from granted-vs-required scope coverage
    // on the surviving conn record, not from token presence — still false.
    expect(afterExpiry?.needsReauth).toBe(false)
    // No cached token -> expiresAt is null, reflecting that a refresh is
    // needed before the next authenticated call.
    expect(afterExpiry?.expiresAt).toBeNull()
  })

  it('#13 — disconnect() clears both conn and token keys, POSTs the revoke via revokeFn, and broadcasts a logout; early-returns the revoke call when no token is cached', async () => {
    const { appId, projectId } = freshIds()
    gisFake.queueResponse({
      access_token: 'tok-4',
      expires_in: 3600,
      scope: SCOPES.join(' '),
    })
    const fetchEmail = vi.fn().mockResolvedValue('logout@example.com')
    await connect({ appId, projectId, clientId: 'client-4', scopes: SCOPES, fetchEmail })

    expect(await getConn(appId, projectId)).not.toBeUndefined()
    expect(await getToken(appId, projectId)).not.toBeUndefined()

    const bc = createBroadcast(appId)
    let logoutProjectId: string | undefined
    const disposeBc = bc.onMessage((msg) => {
      if (msg.type === 'logout') logoutProjectId = msg.projectId
    })

    const revokeFn = vi.fn().mockResolvedValue(undefined)
    await disconnect({ appId, projectId, revokeFn })

    expect(revokeFn).toHaveBeenCalledWith('tok-4')
    expect(await getConn(appId, projectId)).toBeUndefined()
    expect(await getToken(appId, projectId)).toBeUndefined()

    await flush()
    expect(logoutProjectId).toBe(projectId)
    disposeBc()

    // Early-return path: with nothing cached (no conn, no token), a second
    // disconnect() must not invoke revokeFn at all.
    const revokeFn2 = vi.fn().mockResolvedValue(undefined)
    await disconnect({ appId, projectId, revokeFn: revokeFn2 })
    expect(revokeFn2).not.toHaveBeenCalled()
  })
})

describe('getAccessToken', () => {
  let gisFake: GisFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
  })

  afterEach(() => {
    gisFake.uninstall()
  })

  it('returns the cached token as-is when it is still comfortably valid, with no GIS round trip', async () => {
    const { appId, projectId } = freshIds()
    await setToken(appId, projectId, {
      accessToken: 'cached-tok',
      expiresAt: Date.now() + 60 * 60 * 1000,
      grantedScopes: SCOPES,
    })

    const callsBefore = gisFake.calls.length
    const token = await getAccessToken({
      appId,
      projectId,
      clientId: 'client-x',
      scopes: SCOPES,
      interactive: true,
    })

    expect(token).toBe('cached-tok')
    expect(gisFake.calls.length).toBe(callsBefore)
  })

  it('acquires a fresh token when none is cached, and returns the raw access token string', async () => {
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
  })

  it('acquires a fresh token when the cached one is within the reuse buffer of expiring', async () => {
    const { appId, projectId } = freshIds()
    await setToken(appId, projectId, {
      accessToken: 'stale-tok',
      expiresAt: Date.now() + 60 * 1000, // within the 5-minute reuse buffer
      grantedScopes: SCOPES,
    })
    gisFake.queueResponse({
      access_token: 'renewed-tok',
      expires_in: 3600,
      scope: SCOPES.join(' '),
    })

    const token = await getAccessToken({
      appId,
      projectId,
      clientId: 'client-z',
      scopes: SCOPES,
      interactive: false,
    })

    expect(token).toBe('renewed-tok')
  })
})
