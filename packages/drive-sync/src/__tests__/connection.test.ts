import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, getConnection, disconnect } from '../connection.js'
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
})
