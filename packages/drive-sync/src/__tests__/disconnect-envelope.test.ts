import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { disconnect } from '../connection.js'
import {
  getConn,
  getToken,
  getEnvelope,
  setConn,
  setToken,
  setEnvelope,
} from '../storage.js'
import type { Envelope } from '../types.js'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
]

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `dz-app-${idSeq}`, projectId: `dz-proj-${idSeq}` }
}

/** Flushes the BroadcastChannel's async message delivery. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * A minimal Envelope stand-in. `disconnect` never reads envelope contents
 * (it only calls `clearEnvelope`), so an opaque shape cast to the type is
 * all these tests need for storage round-tripping.
 */
function fakeEnvelope(accessToken: string): Envelope {
  return {
    payload: {
      access_token: accessToken,
      expires_in: 3600,
      scope: SCOPES.join(' '),
      token_type: 'Bearer',
    },
    signature: 'sig',
    exp: Date.now() + 3600_000,
  } as unknown as Envelope
}

async function seedEnvelopeMode(
  appId: string,
  projectId: string,
  accessToken: string
): Promise<void> {
  await setEnvelope(appId, projectId, fakeEnvelope(accessToken))
  await setToken(appId, projectId, {
    accessToken,
    expiresAt: Date.now() + 3600_000,
    grantedScopes: SCOPES,
  })
  await setConn(appId, projectId, {
    email: 'envelope@example.com',
    grantedScopes: SCOPES,
    connectedAt: Date.now(),
  })
}

describe('disconnect() — envelope-mode branch', () => {
  let postMessageSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    postMessageSpy = vi.spyOn(BroadcastChannel.prototype, 'postMessage')
  })

  afterEach(() => {
    postMessageSpy.mockRestore()
  })

  it('happy: revokes with payload.access_token and clears conn + token + envelope, then broadcasts logout', async () => {
    const { appId, projectId } = freshIds()
    await seedEnvelopeMode(appId, projectId, 'env-access-tok')

    // Sanity: all three keys are present before disconnect.
    expect(await getConn(appId, projectId)).not.toBeUndefined()
    expect(await getToken(appId, projectId)).not.toBeUndefined()
    expect(await getEnvelope(appId, projectId)).not.toBeUndefined()

    const revokeFn = vi.fn().mockResolvedValue(undefined)
    await disconnect({ appId, projectId, revokeFn })

    expect(revokeFn).toHaveBeenCalledWith('env-access-tok')
    expect(await getConn(appId, projectId)).toBeUndefined()
    expect(await getToken(appId, projectId)).toBeUndefined()
    expect(await getEnvelope(appId, projectId)).toBeUndefined()

    await flush()
    expect(postMessageSpy).toHaveBeenCalled()
  })

  it('edge: a rejecting revokeFn (wrapped to swallow, as index.ts wires it) still lets disconnect resolve and clears all three keys', async () => {
    const { appId, projectId } = freshIds()
    await seedEnvelopeMode(appId, projectId, 'env-access-tok-2')

    // index.ts wraps its revokeFn so a network failure never rejects into
    // disconnect(); mirror that contract here.
    const inner = vi.fn().mockRejectedValue(new Error('revoke network down'))
    const revokeFn = vi.fn(async (accessToken: string) => {
      try {
        await inner(accessToken)
      } catch {
        // swallowed, matching the index.ts wrapper
      }
    })

    await expect(disconnect({ appId, projectId, revokeFn })).resolves.toBeUndefined()

    expect(inner).toHaveBeenCalledWith('env-access-tok-2')
    expect(await getConn(appId, projectId)).toBeUndefined()
    expect(await getToken(appId, projectId)).toBeUndefined()
    expect(await getEnvelope(appId, projectId)).toBeUndefined()
  })

  it('edge (legacy): with no envelope key ever written, clearEnvelope is a no-op and disconnect still clears conn + token', async () => {
    const { appId, projectId } = freshIds()
    // Legacy client-side shape: conn + token only, no envelope.
    await setToken(appId, projectId, {
      accessToken: 'legacy-tok',
      expiresAt: Date.now() + 3600_000,
      grantedScopes: SCOPES,
    })
    await setConn(appId, projectId, {
      email: 'legacy@example.com',
      grantedScopes: SCOPES,
      connectedAt: Date.now(),
    })
    expect(await getEnvelope(appId, projectId)).toBeUndefined()

    const revokeFn = vi.fn().mockResolvedValue(undefined)
    await expect(disconnect({ appId, projectId, revokeFn })).resolves.toBeUndefined()

    expect(revokeFn).toHaveBeenCalledWith('legacy-tok')
    expect(await getConn(appId, projectId)).toBeUndefined()
    expect(await getToken(appId, projectId)).toBeUndefined()
    expect(await getEnvelope(appId, projectId)).toBeUndefined()
  })

  it('error: no token cached -> revokeFn is not called, and conn + token + envelope are cleared anyway', async () => {
    const { appId, projectId } = freshIds()
    // Envelope + conn present but the cached token key is absent.
    await setEnvelope(appId, projectId, fakeEnvelope('unused'))
    await setConn(appId, projectId, {
      email: 'no-token@example.com',
      grantedScopes: SCOPES,
      connectedAt: Date.now(),
    })
    expect(await getToken(appId, projectId)).toBeUndefined()

    const revokeFn = vi.fn().mockResolvedValue(undefined)
    await disconnect({ appId, projectId, revokeFn })

    expect(revokeFn).not.toHaveBeenCalled()
    expect(await getConn(appId, projectId)).toBeUndefined()
    expect(await getToken(appId, projectId)).toBeUndefined()
    expect(await getEnvelope(appId, projectId)).toBeUndefined()
  })
})
