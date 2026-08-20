import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireToken, type AcquireTokenOptions } from '../token.js'
import { NeedsReauthError } from '../errors.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'

const SCOPES = ['https://www.googleapis.com/auth/drive.file']

let idSeq = 0
function freshId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

function baseOpts(overrides: Partial<AcquireTokenOptions> = {}): AcquireTokenOptions {
  return {
    appId: freshId('app'),
    projectId: freshId('proj'),
    clientId: 'client-1',
    scopes: SCOPES,
    interactive: true,
    ...overrides,
  }
}

/**
 * Regression coverage for the field bug where a COMPLETED Google sign-in was
 * reported to the user as "Google sign-in popup was closed before completing".
 *
 * GIS reports `popup_closed` through error_callback even for flows the user
 * finished, and in the failing environments the success `callback` that would
 * contradict it never arrived at all — so no grace window, however long, could
 * recover it. What distinguishes a completed sign-in from a cancelled one is
 * that the completed one leaves a live grant at Google, which a `prompt: 'none'`
 * request can pick up with no popup.
 */
describe('popup_closed recovery via a completed-grant probe', () => {
  let gisFake: GisFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
  })

  afterEach(() => {
    gisFake.uninstall()
  })

  it('recovers a completed sign-in whose success callback never arrives', async () => {
    // The bug: GIS fires popup_closed and NEVER delivers a token on the
    // interactive request, but the consent did complete, so the follow-up
    // silent request finds a live grant.
    gisFake.queuePopupError('popup_closed')
    gisFake.queueResponse({ access_token: 'recovered-token', expires_in: 3600, scope: SCOPES.join(' ') })

    const token = await acquireToken(baseOpts())

    expect(token.accessToken).toBe('recovered-token')
    expect(gisFake.calls.length).toBe(2)
    // The probe must not open a second popup.
    expect(gisFake.calls[1].prompt).toBe('none')
  }, 10_000)

  it('still reports a genuinely cancelled sign-in as popup_closed', async () => {
    // No grant exists, so the probe fails the way GIS fails a prompt:'none'
    // request with nothing to satisfy it. The user must see the original
    // popup_closed error, not the probe's error.
    gisFake.queuePopupError('popup_closed')
    gisFake.queueResponse({ error: 'interaction_required' })

    const settled = await acquireToken(baseOpts()).then(
      () => 'resolved' as const,
      (e: unknown) => e
    )

    expect(settled).toBeInstanceOf(NeedsReauthError)
    expect((settled as NeedsReauthError).reason).toBe('popup_closed')
    expect((settled as NeedsReauthError).message).toContain('closed before completing')
    expect(gisFake.calls.length).toBe(2)
  }, 10_000)

  it('does not probe on the silent path, which is already a prompt:none request', async () => {
    gisFake.queuePopupError('popup_closed')
    gisFake.queueResponse({ access_token: 'should-not-be-used', expires_in: 3600, scope: '' })

    const settled = await acquireToken(baseOpts({ interactive: false, hint: 'a@example.com' })).then(
      () => 'resolved' as const,
      (e: unknown) => e
    )

    expect(settled).toBeInstanceOf(NeedsReauthError)
    expect((settled as NeedsReauthError).message).toBe('Silent token acquisition failed')
    expect(gisFake.calls.length).toBe(1)
  }, 10_000)

  it('does not probe when the popup was blocked rather than closed', async () => {
    gisFake.queuePopupError('popup_failed_to_open')
    gisFake.queueResponse({ access_token: 'should-not-be-used', expires_in: 3600, scope: '' })

    const settled = await acquireToken(baseOpts()).then(
      () => 'resolved' as const,
      (e: unknown) => e
    )

    expect(settled).toBeInstanceOf(NeedsReauthError)
    expect((settled as NeedsReauthError).reason).toBe('popup_failed_to_open')
    expect(gisFake.calls.length).toBe(1)
  }, 10_000)

  it('passes the connection hint to the probe so it targets the right account', async () => {
    gisFake.queuePopupError('popup_closed')
    gisFake.queueResponse({ access_token: 'hinted-token', expires_in: 3600, scope: SCOPES.join(' ') })

    await acquireToken(baseOpts({ hint: 'user@example.com' }))

    expect(gisFake.calls[1].hint).toBe('user@example.com')
  }, 10_000)
})
