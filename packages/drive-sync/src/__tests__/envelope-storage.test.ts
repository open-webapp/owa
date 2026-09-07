import { describe, expect, it } from 'vitest'
import { getEnvelope, setEnvelope, clearEnvelope, openAuthDb } from '../storage.js'
import type { Envelope } from '../types.js'

let idSeq = 0
function freshAppId(): string {
  idSeq += 1
  return `env-app-${idSeq}`
}

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

describe('envelope storage helpers', () => {
  it('happy: setEnvelope then getEnvelope round-trips the exact object', async () => {
    const appId = freshAppId()
    const env = makeEnvelope()

    await setEnvelope(appId, 'p1', env)
    const read = await getEnvelope(appId, 'p1')

    expect(read).toEqual(env)
    expect(read?.sig).toBe(env.sig)
  })

  it('edge: getEnvelope on a project that never stored one returns undefined', async () => {
    const appId = freshAppId()
    await openAuthDb(appId, 'p1')

    await expect(getEnvelope(appId, 'p1')).resolves.toBeUndefined()
  })

  it('error: clearEnvelope on an empty store does not throw; subsequent getEnvelope is undefined', async () => {
    const appId = freshAppId()

    await expect(clearEnvelope(appId, 'p1')).resolves.toBeUndefined()
    await expect(getEnvelope(appId, 'p1')).resolves.toBeUndefined()
  })
})
