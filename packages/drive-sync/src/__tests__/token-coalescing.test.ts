import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireToken, type AcquireTokenOptions } from '../token.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'

const SCOPES_A = ['https://www.googleapis.com/auth/drive.file']
const SCOPES_B = ['https://www.googleapis.com/auth/calendar']

let idSeq = 0
function freshId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

function baseOpts(overrides: Partial<AcquireTokenOptions> & { projectId: string }): AcquireTokenOptions {
  return {
    appId: freshId('app'),
    clientId: 'client-1',
    scopes: SCOPES_A,
    interactive: true,
    ...overrides,
  }
}

describe('acquireToken in-flight coalescing', () => {
  let gisFake: GisFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
  })

  afterEach(() => {
    gisFake.uninstall()
  })

  it('coalesces concurrent calls for the same (projectId, scopes) onto a single GIS request', async () => {
    const projectId = freshId('proj')
    gisFake.queueResponse({ access_token: 'shared-token', expires_in: 3600, scope: SCOPES_A.join(' ') })

    const opts = baseOpts({ projectId })
    const [tokenA, tokenB] = await Promise.all([acquireToken(opts), acquireToken(opts)])

    expect(gisFake.calls.length).toBe(1)
    expect(tokenA).toEqual(tokenB)
    expect(tokenA.accessToken).toBe('shared-token')
  })

  it('does not coalesce concurrent calls for different projectIds', async () => {
    const projectIdOne = freshId('proj')
    const projectIdTwo = freshId('proj')
    gisFake.queueResponse({ access_token: 'token-one', expires_in: 3600, scope: SCOPES_A.join(' ') })
    gisFake.queueResponse({ access_token: 'token-two', expires_in: 3600, scope: SCOPES_A.join(' ') })

    const [tokenOne, tokenTwo] = await Promise.all([
      acquireToken(baseOpts({ projectId: projectIdOne })),
      acquireToken(baseOpts({ projectId: projectIdTwo })),
    ])

    expect(gisFake.calls.length).toBe(2)
    expect(tokenOne.accessToken).toBe('token-one')
    expect(tokenTwo.accessToken).toBe('token-two')
    expect(tokenOne.accessToken).not.toBe(tokenTwo.accessToken)
  })

  it('does not coalesce concurrent calls for the same projectId but different scope sets', async () => {
    const projectId = freshId('proj')
    gisFake.queueResponse({ access_token: 'token-scopes-a', expires_in: 3600, scope: SCOPES_A.join(' ') })
    gisFake.queueResponse({ access_token: 'token-scopes-b', expires_in: 3600, scope: SCOPES_B.join(' ') })

    const [tokenA, tokenB] = await Promise.all([
      acquireToken(baseOpts({ projectId, scopes: SCOPES_A })),
      acquireToken(baseOpts({ projectId, scopes: SCOPES_B })),
    ])

    expect(gisFake.calls.length).toBe(2)
    expect(tokenA.accessToken).toBe('token-scopes-a')
    expect(tokenB.accessToken).toBe('token-scopes-b')
  })

  it('starts a new GIS request for a later call with the same key after the first has settled', async () => {
    const projectId = freshId('proj')
    gisFake.queueResponse({ access_token: 'first-token', expires_in: 3600, scope: SCOPES_A.join(' ') })

    const opts = baseOpts({ projectId })
    const first = await acquireToken(opts)
    expect(gisFake.calls.length).toBe(1)
    expect(first.accessToken).toBe('first-token')

    gisFake.queueResponse({ access_token: 'second-token', expires_in: 3600, scope: SCOPES_A.join(' ') })
    const second = await acquireToken(opts)

    expect(gisFake.calls.length).toBe(2)
    expect(second.accessToken).toBe('second-token')
  })

  it('sync-style fan-out: 5 concurrent callers for identical scopes trigger exactly one GIS request, all resolving to the identical token', async () => {
    // Mirrors a scheduled sync fanning out one acquireToken() call per filter
    // rule (e.g. via Promise.all) — many concurrent call-sites, not just two.
    const projectId = freshId('proj')
    gisFake.queueResponse({ access_token: 'fan-out-token', expires_in: 3600, scope: SCOPES_A.join(' ') })

    const opts = baseOpts({ projectId })
    const results = await Promise.all([
      acquireToken(opts),
      acquireToken(opts),
      acquireToken(opts),
      acquireToken(opts),
      acquireToken(opts),
    ])

    expect(gisFake.calls.length).toBe(1)
    for (const token of results) {
      expect(token).toEqual(results[0])
      expect(token.accessToken).toBe('fan-out-token')
    }
  })

  it('mixed-scope racing: interleaved concurrent calls for two different scopes on the same project each get their own token, with no cross-contamination', async () => {
    // Regression guard for the old googleAuth.ts bug class: a shared
    // module-level resolve/reject clobbered by a second concurrent request,
    // which could hand one caller's token to another caller entirely. Here
    // three callers race for SCOPES_A and two race for SCOPES_B, interleaved
    // (not grouped), on the same project.
    const projectId = freshId('proj')
    gisFake.queueResponse({ access_token: 'token-a-shared', expires_in: 3600, scope: SCOPES_A.join(' ') })
    gisFake.queueResponse({ access_token: 'token-b-shared', expires_in: 3600, scope: SCOPES_B.join(' ') })

    const callA1 = acquireToken(baseOpts({ projectId, scopes: SCOPES_A }))
    const callB1 = acquireToken(baseOpts({ projectId, scopes: SCOPES_B }))
    const callA2 = acquireToken(baseOpts({ projectId, scopes: SCOPES_A }))
    const callB2 = acquireToken(baseOpts({ projectId, scopes: SCOPES_B }))
    const callA3 = acquireToken(baseOpts({ projectId, scopes: SCOPES_A }))

    const [a1, b1, a2, b2, a3] = await Promise.all([callA1, callB1, callA2, callB2, callA3])

    // Exactly one GIS request per distinct scope set, despite 5 interleaved callers.
    expect(gisFake.calls.length).toBe(2)

    // Every SCOPES_A caller got the SCOPES_A token, and only that token.
    for (const token of [a1, a2, a3]) {
      expect(token.accessToken).toBe('token-a-shared')
    }
    // Every SCOPES_B caller got the SCOPES_B token, and only that token.
    for (const token of [b1, b2]) {
      expect(token.accessToken).toBe('token-b-shared')
    }
  })

  it('a shared in-flight rejection is propagated to every coalesced caller, and the key is cleared so the next call starts a fresh GIS request', async () => {
    const projectId = freshId('proj')
    gisFake.queueResponse({ error: 'access_denied' })

    const opts = baseOpts({ projectId })
    const settled = await Promise.all([
      acquireToken(opts).then(
        (v) => ({ status: 'resolved' as const, value: v }),
        (e) => ({ status: 'rejected' as const, error: e })
      ),
      acquireToken(opts).then(
        (v) => ({ status: 'resolved' as const, value: v }),
        (e) => ({ status: 'rejected' as const, error: e })
      ),
      acquireToken(opts).then(
        (v) => ({ status: 'resolved' as const, value: v }),
        (e) => ({ status: 'rejected' as const, error: e })
      ),
    ])

    expect(gisFake.calls.length).toBe(1)
    for (const outcome of settled) {
      expect(outcome.status).toBe('rejected')
    }

    // The failed in-flight entry must have been removed from the coalescing
    // map (not left stuck), so a subsequent call for the same key retries
    // against GIS instead of hanging or replaying the old rejection forever.
    gisFake.queueResponse({ access_token: 'recovered-token', expires_in: 3600, scope: SCOPES_A.join(' ') })
    const recovered = await acquireToken(opts)

    expect(gisFake.calls.length).toBe(2)
    expect(recovered.accessToken).toBe('recovered-token')
  })

  it('both overlapping requests for different projects actually settle (neither hangs)', async () => {
    const projectIdOne = freshId('proj')
    const projectIdTwo = freshId('proj')
    gisFake.queueResponse({ access_token: 'settle-one', expires_in: 3600, scope: SCOPES_A.join(' ') })
    gisFake.queueResponse({ access_token: 'settle-two', expires_in: 3600, scope: SCOPES_A.join(' ') })

    const resultOne = acquireToken(baseOpts({ projectId: projectIdOne }))
    const resultTwo = acquireToken(baseOpts({ projectId: projectIdTwo }))

    const settled = await Promise.all([
      resultOne.then(
        (v) => ({ status: 'resolved' as const, value: v }),
        (e) => ({ status: 'rejected' as const, error: e })
      ),
      resultTwo.then(
        (v) => ({ status: 'resolved' as const, value: v }),
        (e) => ({ status: 'rejected' as const, error: e })
      ),
    ])

    expect(settled[0].status).toBe('resolved')
    expect(settled[1].status).toBe('resolved')
  })
})
