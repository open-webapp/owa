import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync, type ProjectHandle } from '../index.js'
import { REQUIRED_SCOPES } from '../files.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import { createDriveFake, type DriveFake } from '../testing/driveFake.js'

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

let idSeq = 0
function freshId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

function createHostFetch(driveFake: DriveFake): typeof fetch {
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request)?.url ?? String(input)
    if (url.startsWith(USERINFO_URL)) {
      return new Response(JSON.stringify({ email: 'user@example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.startsWith(REVOKE_URL)) {
      return new Response(null, { status: 200 })
    }
    return driveFake.fetch(input as any, init)
  }) as unknown as typeof fetch
}

describe('additionalScopes passthrough', () => {
  let gisFake: GisFake
  let driveFake: DriveFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
    driveFake = createDriveFake()
    vi.stubGlobal('fetch', createHostFetch(driveFake))
  })

  afterEach(() => {
    gisFake.uninstall()
    vi.unstubAllGlobals()
  })

  function makeProject(additionalScopes?: string[]): ProjectHandle {
    const appId = freshId('app')
    const projectId = freshId('proj')
    const sync = createDriveSync({
      appId,
      clientId: 'client-1',
      folderPath: ['Root'],
      additionalScopes,
    })
    return sync.project(projectId)
  }

  it('(a) with no additionalScopes, connect() requests exactly REQUIRED_SCOPES — byte-identical to before this option existed', async () => {
    const p = makeProject()
    gisFake.queueResponse({
      access_token: 'tok',
      expires_in: 3600,
      scope: REQUIRED_SCOPES.join(' '),
    })

    await p.connect()

    expect(gisFake.calls).toHaveLength(1)
    expect(gisFake.calls[0].scope).toBe(REQUIRED_SCOPES.join(' '))
  })

  it('(b) with additionalScopes set, connect() requests the base scopes plus the extra scope, in concatenated order', async () => {
    const p = makeProject([CALENDAR_SCOPE])
    const expectedScope = [...REQUIRED_SCOPES, CALENDAR_SCOPE].join(' ')
    gisFake.queueResponse({ access_token: 'tok', expires_in: 3600, scope: expectedScope })

    await p.connect()

    expect(gisFake.calls[0].scope).toBe(expectedScope)
  })

  it('(c) with additionalScopes set, a token missing the new scope is treated as needing reauth', async () => {
    const p = makeProject([CALENDAR_SCOPE])
    // Only the base scopes are granted — the new scope is genuinely required,
    // not just requested-and-ignored.
    gisFake.queueResponse({ access_token: 'tok', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })

    await p.connect()
    const conn = await p.getConnection()

    expect(conn?.needsReauth).toBe(true)
  })

  it('(d) getAccessToken() also requests EFFECTIVE_SCOPES', async () => {
    const p = makeProject([CALENDAR_SCOPE])
    const expectedScope = [...REQUIRED_SCOPES, CALENDAR_SCOPE].join(' ')
    gisFake.queueResponse({ access_token: 'tok', expires_in: 3600, scope: expectedScope })

    await p.getAccessToken()

    expect(gisFake.calls).toHaveLength(1)
    expect(gisFake.calls[0].scope).toBe(expectedScope)
  })
})
