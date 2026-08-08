import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireToken } from '../token.js'
import { getConnection, connect } from '../connection.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email'

let idSeq = 0
function freshId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

describe('token expiry and granted-scope recording', () => {
  let gisFake: GisFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
  })

  afterEach(() => {
    gisFake.uninstall()
  })

  it('derives expiresAt from the GIS response expires_in (not a hardcoded value)', async () => {
    const projectId = freshId('proj')
    gisFake.queueResponse({ access_token: 'tok', expires_in: 120, scope: DRIVE_SCOPE })

    const before = Date.now()
    const token = await acquireToken({
      appId: freshId('app'),
      projectId,
      clientId: 'client-1',
      scopes: [DRIVE_SCOPE],
      interactive: true,
    })
    const after = Date.now()

    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 120_000)
    expect(token.expiresAt).toBeLessThanOrEqual(after + 120_000 + 50)
  })

  it('records grantedScopes exactly as returned, without granting scopes that were not in the response', async () => {
    const appId = freshId('app')
    const projectId = freshId('proj')
    gisFake.queueResponse({ access_token: 'tok', expires_in: 3600, scope: DRIVE_SCOPE })

    const token = await acquireToken({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: [DRIVE_SCOPE, EMAIL_SCOPE],
      interactive: true,
    })

    expect(token.grantedScopes).toEqual([DRIVE_SCOPE])
  })

  it('a getConnection scope-coverage check reflects a partial grant with no additional network/GIS calls', async () => {
    const appId = freshId('app')
    const projectId = freshId('proj')
    gisFake.queueResponse({ access_token: 'tok', expires_in: 3600, scope: DRIVE_SCOPE })
    const fetchEmail = vi.fn().mockResolvedValue('scoped@example.com')

    await connect({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: [DRIVE_SCOPE, EMAIL_SCOPE],
      fetchEmail,
    })

    const callsBefore = gisFake.calls.length

    const result = await getConnection({
      appId,
      projectId,
      requiredScopes: [DRIVE_SCOPE, EMAIL_SCOPE],
    })

    expect(result?.needsReauth).toBe(true)
    expect(gisFake.calls.length).toBe(callsBefore)
  })
})
