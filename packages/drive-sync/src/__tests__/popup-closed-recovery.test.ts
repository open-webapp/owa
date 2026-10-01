import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireToken, type AcquireTokenOptions } from '../token.js'
import { NeedsReauthError } from '../errors.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'

const SCOPES = ['https://www.googleapis.com/auth/drive.file']

let idSeq = 0
function baseOpts(): AcquireTokenOptions {
  idSeq += 1
  return {
    appId: `app-${idSeq}`,
    projectId: `project-${idSeq}`,
    clientId: 'client-1',
    scopes: SCOPES,
    interactive: true,
  }
}

describe('popup_closed cancellation', () => {
  let gisFake: GisFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
  })

  afterEach(() => {
    gisFake.uninstall()
  })

  it('reports cancellation without a silent follow-up request', async () => {
    gisFake.queuePopupError('popup_closed')

    const error = await acquireToken(baseOpts()).catch((err: unknown) => err)

    expect(error).toBeInstanceOf(NeedsReauthError)
    expect((error as NeedsReauthError).reason).toBe('popup_closed')
    expect(gisFake.calls).toHaveLength(1)
  })

  it('does not consume a queued silent grant after cancellation', async () => {
    gisFake.queuePopupError('popup_closed')
    gisFake.queueResponse({ access_token: 'must-not-be-used', expires_in: 3600, scope: SCOPES.join(' ') })

    await expect(acquireToken(baseOpts())).rejects.toMatchObject({ reason: 'popup_closed' })
    expect(gisFake.calls).toHaveLength(1)
  })
})
