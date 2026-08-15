import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync } from '../index.js'
import { connect as connectDirect, getConnection as getConnectionDirect } from '../connection.js'
import { acquireToken } from '../token.js'
import { getConn, getToken } from '../storage.js'
import { REQUIRED_SCOPES } from '../files.js'
import { DriveSyncError, NeedsReauthError, TransientError, WrongAccountError } from '../errors.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import { createDriveFake, type DriveFake } from '../testing/driveFake.js'

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

let idSeq = 0
function freshId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

/**
 * Wraps a driveFake's fetch with handling for the two "index.ts-owned"
 * endpoints (userinfo lookup + token revocation) that driveFake itself does
 * not understand, so `connect()`/`disconnect()` exercised through the
 * public API do not blow up on an "unhandled URL" error. Everything else is
 * forwarded to the driveFake unchanged.
 */
function createHostFetch(driveFake: DriveFake, emailByToken?: Map<string, string>): typeof fetch {
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request)?.url ?? String(input)

    if (url.startsWith(USERINFO_URL)) {
      const headers = init?.headers as Record<string, string> | undefined
      const auth = headers?.Authorization ?? headers?.authorization
      const token = auth?.replace(/^Bearer\s+/, '')
      const email = (token && emailByToken?.get(token)) || 'user@example.com'
      return new Response(JSON.stringify({ email }), {
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

describe('drive-sync regression suite', () => {
  let gisFake: GisFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
  })

  afterEach(() => {
    gisFake.uninstall()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('R1 — token client does not close over the first projectId', async () => {
    const appId = freshId('app')
    const driveFake = createDriveFake()
    const emailByToken = new Map([
      ['token-A', 'a@x.com'],
      ['token-B', 'b@x.com'],
    ])
    vi.stubGlobal('fetch', createHostFetch(driveFake, emailByToken))

    const ds = createDriveSync({ appId, clientId: 'client-1', folderPath: ['Root'] })

    gisFake.queueResponse({ access_token: 'token-A', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    const connA = await ds.project('proj-A').connect()

    gisFake.queueResponse({ access_token: 'token-B', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    const connB = await ds.project('proj-B').connect()

    expect(connA.email).toBe('a@x.com')
    expect(connB.email).toBe('b@x.com')

    // getConnection for each project independently reflects its own email —
    // neither was overwritten nor confused with the other.
    const gotA = await ds.project('proj-A').getConnection()
    const gotB = await ds.project('proj-B').getConnection()
    expect(gotA?.email).toBe('a@x.com')
    expect(gotB?.email).toBe('b@x.com')

    // Each project's durable record lives under its own db key
    // (owa-drive-{appId}-{projectId}), independent of the other.
    const rawA = await getConn(appId, 'proj-A')
    const rawB = await getConn(appId, 'proj-B')
    expect(rawA?.email).toBe('a@x.com')
    expect(rawB?.email).toBe('b@x.com')
  })

  it('R2 — scopes honored after the first call (no stale-singleton token client)', async () => {
    const appId = freshId('app')
    const projectId = freshId('proj')
    const S1 = ['scope-a']
    const S2 = ['scope-a', 'scope-b']

    gisFake.queueResponse({ access_token: 't1', expires_in: 3600, scope: S1.join(' ') })
    await acquireToken({ appId, projectId, clientId: 'client-1', scopes: S1, interactive: true })

    gisFake.queueResponse({ access_token: 't2', expires_in: 3600, scope: S2.join(' ') })
    await acquireToken({ appId, projectId, clientId: 'client-1', scopes: S2, interactive: true })

    expect(gisFake.calls.length).toBe(2)
    expect(gisFake.calls[1].scope).toBe(S2.join(' '))
    expect(gisFake.calls[1].scope).not.toBe(S1.join(' '))
  })

  it('R3 — in-flight coalescing is keyed by (projectId, scopes), not global', async () => {
    // Different projects, fired concurrently -> exactly 2 underlying GIS
    // calls, each project resolving with its own distinct token.
    const projectA = freshId('proj')
    const projectB = freshId('proj')
    gisFake.queueResponse({ access_token: 'token-proj-A', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    gisFake.queueResponse({ access_token: 'token-proj-B', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })

    const [tokenA, tokenB] = await Promise.all([
      acquireToken({ appId: freshId('app'), projectId: projectA, clientId: 'c', scopes: REQUIRED_SCOPES, interactive: true }),
      acquireToken({ appId: freshId('app'), projectId: projectB, clientId: 'c', scopes: REQUIRED_SCOPES, interactive: true }),
    ])

    expect(gisFake.calls.length).toBe(2)
    expect(tokenA.accessToken).toBe('token-proj-A')
    expect(tokenB.accessToken).toBe('token-proj-B')

    // Same project, identical scopes, 3 concurrent callers -> exactly 1
    // underlying GIS call, and all 3 receive the identical resolved token.
    const appId = freshId('app')
    const projectC = freshId('proj')
    gisFake.queueResponse({ access_token: 'shared-token', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })

    const opts = { appId, projectId: projectC, clientId: 'c', scopes: REQUIRED_SCOPES, interactive: true }
    const [t1, t2, t3] = await Promise.all([acquireToken(opts), acquireToken(opts), acquireToken(opts)])

    expect(gisFake.calls.length).toBe(3)
    expect(t1).toEqual(t2)
    expect(t2).toEqual(t3)
    expect(t1.accessToken).toBe('shared-token')
  })

  it('R4 — concurrent resolvers for different projects do not clobber each other', async () => {
    const projectA = freshId('proj')
    const projectB = freshId('proj')
    gisFake.queueResponse({ access_token: 'settle-a', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    gisFake.queueResponse({ access_token: 'settle-b', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })

    const resultA = acquireToken({ appId: freshId('app'), projectId: projectA, clientId: 'c', scopes: REQUIRED_SCOPES, interactive: true })
    const resultB = acquireToken({ appId: freshId('app'), projectId: projectB, clientId: 'c', scopes: REQUIRED_SCOPES, interactive: true })

    const settled = await Promise.all([
      resultA.then(
        (v) => ({ status: 'resolved' as const, value: v }),
        (e) => ({ status: 'rejected' as const, error: e })
      ),
      resultB.then(
        (v) => ({ status: 'resolved' as const, value: v }),
        (e) => ({ status: 'rejected' as const, error: e })
      ),
    ])

    expect(settled[0].status).toBe('resolved')
    expect(settled[1].status).toBe('resolved')
  })

  it('R5 — expiry is derived from expires_in, not a hardcoded 3600', async () => {
    const before = Date.now()
    gisFake.queueResponse({ access_token: 'tok', expires_in: 120, scope: REQUIRED_SCOPES.join(' ') })

    const token = await acquireToken({
      appId: freshId('app'),
      projectId: freshId('proj'),
      clientId: 'client-1',
      scopes: REQUIRED_SCOPES,
      interactive: true,
    })
    const after = Date.now()

    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 120_000)
    expect(token.expiresAt).toBeLessThanOrEqual(after + 120_000 + 50)
    // Definitely not the old hardcoded hour.
    expect(token.expiresAt).toBeLessThan(before + 3_600_000)
  })

  it('R6 — grantedScopes recorded exactly; getConnection reports needsReauth without any extra network/GIS call', async () => {
    const appId = freshId('app')
    const projectId = freshId('proj')
    const partialScope = 'https://www.googleapis.com/auth/drive.file'

    // Missing the userinfo.email scope the library requires.
    gisFake.queueResponse({ access_token: 'tok', expires_in: 3600, scope: partialScope })
    const fetchEmail = vi.fn().mockResolvedValue('scoped@example.com')

    await connectDirect({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: REQUIRED_SCOPES,
      fetchEmail,
    })

    const storedToken = await getToken(appId, projectId)
    expect(storedToken?.grantedScopes).toEqual([partialScope])

    const gisCallsBefore = gisFake.calls.length
    const result = await getConnectionDirect({ appId, projectId, requiredScopes: REQUIRED_SCOPES })

    expect(result?.needsReauth).toBe(true)
    expect(result?.email).toBe('scoped@example.com')
    // No additional network call or GIS call triggered just to determine this.
    expect(gisFake.calls.length).toBe(gisCallsBefore)
  })

  it('R7 — 401 surfaces as a typed NeedsReauthError after one silent retry, or succeeds transparently if the retry works', async () => {
    const driveFake = createDriveFake()
    vi.stubGlobal('fetch', driveFake.fetch)
    driveFake.files.set('file-1', {
      id: 'file-1',
      name: 'f.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'hello',
      contentType: 'text/plain',
    })

    const appId = freshId('app')
    const projectId = freshId('proj')
    const ds = createDriveSync({ appId, clientId: 'client-1', folderPath: ['Root'] })
    const project = ds.project(projectId)

    // Both the original attempt AND the post-refresh retry attempt 401 ->
    // the caller must see a typed NeedsReauthError, never a raw fetch/Response.
    driveFake.setStatusOverride('', 401, { times: 2 })
    gisFake.queueResponse({ access_token: 'tok-1', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    gisFake.queueResponse({ access_token: 'tok-2', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })

    await expect(project.files.read('file-1')).rejects.toBeInstanceOf(NeedsReauthError)

    // Only the FIRST attempt 401s; the silent-refresh retry succeeds -> the
    // call must succeed transparently, with no error surfaced at all.
    driveFake.setStatusOverride('', 401, { times: 1 })
    gisFake.queueResponse({ access_token: 'tok-3', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    gisFake.queueResponse({ access_token: 'tok-4', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })

    const result = await project.files.read('file-1')
    expect(result).toBe('hello')
  })

  it('R8 — silent refresh carries prompt: "none" and hint: <connected email>', async () => {
    const appId = freshId('app')
    const projectId = freshId('proj')

    gisFake.queueResponse({ access_token: 'tok-initial', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    const fetchEmail = vi.fn().mockResolvedValue('a@x.com')
    await connectDirect({ appId, projectId, clientId: 'client-1', scopes: REQUIRED_SCOPES, fetchEmail })

    const driveFake = createDriveFake()
    vi.stubGlobal('fetch', driveFake.fetch)
    driveFake.files.set('file-1', {
      id: 'file-1',
      name: 'f.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'hello',
      contentType: 'text/plain',
    })

    // A non-interactive call (default) goes through the silent-refresh path,
    // which should target the connection's known email via `hint`.
    gisFake.queueResponse({ access_token: 'tok-refresh', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    const ds = createDriveSync({ appId, clientId: 'client-1', folderPath: ['Root'] })
    await ds.project(projectId).files.read('file-1')

    const lastCall = gisFake.calls[gisFake.calls.length - 1]
    expect(lastCall.prompt).toBe('none')
    expect(lastCall.hint).toBe('a@x.com')

    // NOTE: WrongAccountError is defined in errors.ts but is not thrown
    // anywhere in the current source (connection.ts/http.ts/token.ts never
    // reference it) — wrong-account detection is not actually wired up yet.
    // The second half of R8 (asserting WrongAccountError on a mismatched
    // silent-refresh email) is therefore intentionally not implemented here;
    // see the final report for this gap.
  })

  it('R8b — a silent refresh that GIS hands back for a DIFFERENT account throws WrongAccountError and clears the bad token', async () => {
    const appId = freshId('app')
    const projectId = freshId('proj')

    const driveFake = createDriveFake()
    driveFake.files.set('file-1', {
      id: 'file-1',
      name: 'f.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'hello',
      contentType: 'text/plain',
    })

    // Maps GIS access tokens to the account they actually belong to, per the
    // userinfo lookup driveFetch's silent-refresh path performs. The token
    // handed back on the 401-triggered silent refresh below belongs to a
    // DIFFERENT account than the one that connected, simulating GIS honoring
    // a multi-login browser session's "hint" only loosely.
    const emailByToken = new Map([
      ['tok-initial', 'a@x.com'],
      ['tok-wrong-account', 'b@x.com'],
    ])
    vi.stubGlobal('fetch', createHostFetch(driveFake, emailByToken))

    const ds = createDriveSync({ appId, clientId: 'client-1', folderPath: ['Root'] })

    gisFake.queueResponse({ access_token: 'tok-initial', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    const conn = await ds.project(projectId).connect()
    expect(conn.email).toBe('a@x.com')

    // Force the very next Drive request to 401 once, which drives it into
    // http.ts's silent-refresh-and-retry path. GIS's response there resolves
    // to a token for b@x.com even though the hint asked for a@x.com.
    //
    // Two GIS responses are queued: the first is consumed by driveFetch's
    // own initial (pre-401) token acquisition — that attempt's account
    // doesn't matter, since it is the 401 that triggers the retry, not an
    // email mismatch — and the second is consumed by the 401-triggered
    // silent refresh itself, which is the one under test here.
    driveFake.setStatusOverride('', 401, { times: 1 })
    gisFake.queueResponse({ access_token: 'tok-initial', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    gisFake.queueResponse({ access_token: 'tok-wrong-account', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })

    const project = ds.project(projectId)
    const settled = await project.files.read('file-1').then(
      (v) => ({ status: 'resolved' as const, value: v }),
      (e) => ({ status: 'rejected' as const, error: e })
    )

    expect(settled.status).toBe('rejected')
    if (settled.status === 'rejected') {
      expect(settled.error).toBeInstanceOf(WrongAccountError)
      expect(settled.error.expectedEmail).toBe('a@x.com')
      expect(settled.error.actualEmail).toBe('b@x.com')
    }

    // The suspect token must not be left around for a subsequent call to
    // silently reuse.
    const tokenAfter = await getToken(appId, projectId)
    expect(tokenAfter).toBeUndefined()

    // The durable connection record's email is untouched — only the bad
    // token was cleared, not the (still-correct) known identity.
    const connAfter = await getConn(appId, projectId)
    expect(connAfter?.email).toBe('a@x.com')
  })

  it('R9 — every Drive operation checks response.ok and throws a typed error on a malformed 500, never returning corrupted data', async () => {
    // Real timers here: fake-indexeddb's internal scheduling does not play
    // well with vi.useFakeTimers(), so we accept the real ~1.5s backoff per
    // op (9 ops) and give the test a longer timeout instead.
    const driveFake = createDriveFake()
    vi.stubGlobal('fetch', driveFake.fetch)
    driveFake.files.set('file-1', {
      id: 'file-1',
      name: 'f.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'hello',
      contentType: 'text/plain',
    })
    driveFake.permissions.set(
      'file-1',
      new Map([['perm-1', { id: 'perm-1', type: 'user', role: 'reader', emailAddress: 'x@y.com' }]])
    )

    const appId = freshId('app')
    const projectId = freshId('proj')
    const ds = createDriveSync({ appId, clientId: 'client-1', folderPath: ['Root'] })
    const project = ds.project(projectId)

    const htmlBody = '<html><body>Internal Server Error</body></html>'

    const ops: Array<[string, () => Promise<unknown>]> = [
      ['files.read', () => project.files.read('file-1')],
      ['files.write (create)', () => project.files.write({ name: 'new.txt', content: 'x', mimeType: 'text/plain' })],
      ['files.write (update)', () => project.files.write({ fileId: 'file-1', content: 'x', mimeType: 'text/plain' })],
      ['files.list', () => project.files.list()],
      ['files.remove', () => project.files.remove('file-1')],
      ['permissions.list', () => project.permissions.list('file-1')],
      ['permissions.grant', () => project.permissions.grant({ fileId: 'file-1', type: 'anyone', role: 'reader' })],
      ['permissions.update', () => project.permissions.update({ fileId: 'file-1', permissionId: 'perm-1', role: 'writer' })],
      ['permissions.revoke', () => project.permissions.revoke({ fileId: 'file-1', permissionId: 'perm-1' })],
    ]

    for (const [label, run] of ops) {
      driveFake.setStatusOverride('', 500, { times: 3, body: htmlBody })
      gisFake.queueResponse({ access_token: `tok-${label}`, expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })

      const settled = await run().then(
        (v) => ({ status: 'resolved' as const, value: v }),
        (e) => ({ status: 'rejected' as const, error: e })
      )

      expect(settled.status).toBe('rejected')
      if (settled.status === 'rejected') {
        expect(settled.error).toBeInstanceOf(DriveSyncError)
        expect(settled.error).not.toHaveProperty('id', undefined)
        // Must not be a raw JSON.parse failure on the HTML body.
        expect(String(settled.error?.message ?? '')).not.toMatch(/Unexpected token/i)
      }
    }
  }, 30000)

  it('R10 — retry policy: 429 backs off then succeeds, 500x3 exhausts to TransientError, 400 retries zero times', async () => {
    // Real timers here (see R9): fake-indexeddb does not play well with
    // vi.useFakeTimers(), so we wait out the real (small, test-scale) delays
    // instead and rely on a longer test timeout.
    const driveFake = createDriveFake()
    let callCount = 0
    // Counts only content fetches. read() also issues a metadata request to
    // record its sync baseline, which is not part of the retry behaviour
    // under test here and would otherwise inflate these counts.
    let mediaCallCount = 0
    const countingFetch: typeof fetch = (async (input: any, init?: RequestInit) => {
      callCount++
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (url.includes('alt=media')) mediaCallCount++
      return driveFake.fetch(input, init)
    }) as typeof fetch
    vi.stubGlobal('fetch', countingFetch)

    driveFake.files.set('file-1', {
      id: 'file-1',
      name: 'f.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'hello',
      contentType: 'text/plain',
    })

    const appId = freshId('app')
    const projectId = freshId('proj')
    const ds = createDriveSync({ appId, clientId: 'client-1', folderPath: ['Root'] })
    const project = ds.project(projectId)

    // (a) 429 with Retry-After: 2 on attempt 1 only; attempt 2 succeeds.
    // Scoped to the content fetch: read() also issues a metadata request for
    // its sync baseline, and this case is about retrying the content GET.
    driveFake.setStatusOverride('alt=media', 429, { retryAfter: 2, times: 1 })
    gisFake.queueResponse({ access_token: 'tok-a', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    callCount = 0
    mediaCallCount = 0

    let settledA = false
    const pA = project.files.read('file-1')
    void pA.then(() => {
      settledA = true
    })

    await new Promise((r) => setTimeout(r, 1000))
    expect(settledA).toBe(false) // needed the ~2s Retry-After wait, not resolved after only 1s

    const resultA = await pA
    expect(resultA).toBe('hello')
    expect(mediaCallCount).toBe(2)

    // (b) three consecutive 500s -> TransientError after exactly 3 attempts.
    driveFake.setStatusOverride('', 500, { times: 3 })
    gisFake.queueResponse({ access_token: 'tok-b', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    callCount = 0

    const settledB = await project.files.read('file-1').then(
      (v) => ({ status: 'resolved' as const, value: v }),
      (e) => ({ status: 'rejected' as const, error: e })
    )

    expect(settledB.status).toBe('rejected')
    if (settledB.status === 'rejected') {
      expect(settledB.error).toBeInstanceOf(TransientError)
    }
    expect(callCount).toBe(3)

    // (c) a plain 400 -> zero retries.
    driveFake.setStatusOverride('', 400, { times: 1 })
    gisFake.queueResponse({ access_token: 'tok-c', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    callCount = 0

    await expect(project.files.read('file-1')).rejects.toBeInstanceOf(DriveSyncError)
    expect(callCount).toBe(1)
  }, 15000)

  it('R11 — multipart create uses FormData (fetch-computed boundary), never a hand-rolled boundary that content can collide with', async () => {
    const driveFake = createDriveFake()
    let capturedContentType: string | undefined
    const spyFetch: typeof fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      if (url.includes('uploadType=multipart')) {
        const headers = init?.headers as Record<string, string> | undefined
        capturedContentType = headers?.['Content-Type']
      }
      return driveFake.fetch(input, init)
    }) as typeof fetch
    vi.stubGlobal('fetch', spyFetch)

    const appId = freshId('app')
    const projectId = freshId('proj')
    const ds = createDriveSync({ appId, clientId: 'client-1', folderPath: ['Root'] })
    const project = ds.project(projectId)

    // The literal old hand-rolled boundary string, embedded inside content.
    const oldBoundary = '===============7330845974216740156=='
    const content = `before-${oldBoundary}-after`

    gisFake.queueResponse({ access_token: 'tok-write', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    const written = await project.files.write({ name: 'f.txt', content, mimeType: 'text/plain' })
    expect(written.id).toBeTruthy()

    gisFake.queueResponse({ access_token: 'tok-read', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    const readBack = await project.files.read(written.id)
    expect(readBack).toBe(content)

    // The actual request used a real multipart Content-Type with a
    // fetch-computed boundary that is NOT the literal string embedded in
    // the content (proving no collision/corruption).
    expect(capturedContentType).toBeDefined()
    expect(capturedContentType).toMatch(/multipart\/(form-data|related);\s*boundary=/i)
    expect(capturedContentType).not.toContain(oldBoundary)
  })
})
