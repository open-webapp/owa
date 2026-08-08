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
