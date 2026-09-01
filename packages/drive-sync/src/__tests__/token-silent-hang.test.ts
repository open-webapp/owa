import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireToken, type AcquireTokenOptions } from '../token.js'
import { NeedsReauthError } from '../errors.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'

const SCOPES = ['https://www.googleapis.com/auth/drive.file']

let idSeq = 0
const freshId = (prefix: string): string => `${prefix}-${(idSeq += 1)}`

function baseOpts(overrides: Partial<AcquireTokenOptions> & { projectId: string }): AcquireTokenOptions {
  return {
    appId: freshId('app'),
    clientId: 'client-1',
    scopes: SCOPES,
    interactive: true,
    ...overrides,
  }
}

describe('a GIS request that is never answered', () => {
  let gisFake: GisFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
  })

  afterEach(() => {
    vi.useRealTimers()
    gisFake.uninstall()
  })

  it('rejects the interactive request instead of hanging forever', async () => {
    vi.useFakeTimers()
    gisFake.queueSilence()

    const pending = acquireToken(baseOpts({ projectId: freshId('proj') }))
    const settled = vi.fn()
    void pending.then(settled, settled)

    // Well past any plausible OAuth round-trip, and still nothing: without a
    // ceiling this promise never settles and the caller is stuck mid-connect.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await expect(pending).rejects.toMatchObject({
      name: 'NeedsReauthError',
      reason: 'gis_timeout',
    })
  })

  it('rejects a silent refresh in seconds, not minutes', async () => {
    vi.useFakeTimers()
    gisFake.queueSilence()

    const pending = acquireToken(baseOpts({ projectId: freshId('proj'), interactive: false }))
    const assertion = expect(pending).rejects.toBeInstanceOf(NeedsReauthError)

    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
  })

  it('lets a later connect run a fresh flow after one request times out', async () => {
    vi.useFakeTimers()
    const projectId = freshId('proj')
    const appId = freshId('app')
    gisFake.queueSilence()

    const dead = acquireToken(baseOpts({ projectId, appId }))
    const deadAssertion = expect(dead).rejects.toBeInstanceOf(NeedsReauthError)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await deadAssertion

    // Storing the retry's token goes through fake-indexeddb, which needs real
    // timers to settle its transactions.
    vi.useRealTimers()

    // The retry must reach GIS on its own — not join the corpse of the first
    // request still sitting in the in-flight map.
    gisFake.queueResponse({ access_token: 'retry-token', expires_in: 3600, scope: SCOPES.join(' ') })
    const retry = acquireToken(baseOpts({ projectId, appId }))

    await expect(retry).resolves.toMatchObject({ accessToken: 'retry-token' })
    expect(gisFake.calls.length).toBe(2)
  })

  it('never hands a user-initiated connect the outcome of an in-flight silent refresh', async () => {
    const projectId = freshId('proj')
    const appId = freshId('app')
    gisFake.queueSilence()

    // Left pending on purpose: the silent request GIS never answers is exactly
    // the state the user's click has to survive.
    const refresh = acquireToken(baseOpts({ projectId, appId, interactive: false }))
    refresh.catch(() => {})

    gisFake.queueResponse({ access_token: 'connect-token', expires_in: 3600, scope: SCOPES.join(' ') })
    const connect = acquireToken(baseOpts({ projectId, appId, interactive: true }))

    await expect(connect).resolves.toMatchObject({ accessToken: 'connect-token' })
    expect(gisFake.calls.length).toBe(2)
    expect(gisFake.calls[1]?.prompt).toBe('')
  })
})
