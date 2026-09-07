import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGisFake } from '../testing/index.js'
import type { GisCodeResponse } from '../testing/index.js'
import { REQUIRED_SCOPES } from '../files.js'

/**
 * Covers the auth-code (server-side) client added to `createGisFake`:
 * `install()` must expose `window.google.accounts.oauth2.initCodeClient`
 * alongside the legacy `initTokenClient` stub.
 */
describe('createGisFake — initCodeClient', () => {
  let gis: ReturnType<typeof createGisFake>

  beforeEach(() => {
    gis = createGisFake()
    gis.install()
  })

  afterEach(() => {
    gis.uninstall()
    vi.useRealTimers()
  })

  function makeCodeClient(overrides: Record<string, unknown> = {}) {
    const w = globalThis as unknown as { google: any }
    const received: GisCodeResponse[] = []
    const errors: Array<{ type?: string }> = []
    const client = w.google.accounts.oauth2.initCodeClient({
      client_id: 'client-abc',
      scope: REQUIRED_SCOPES.join(' '),
      ux_mode: 'popup',
      callback: (r: GisCodeResponse) => received.push(r),
      error_callback: (e: { type?: string }) => errors.push(e),
      ...overrides,
    })
    return { client, received, errors }
  }

  it('install() exposes both the token client and the code client', () => {
    const w = globalThis as unknown as { google: any }
    expect(typeof w.google.accounts.oauth2.initTokenClient).toBe('function')
    expect(typeof w.google.accounts.oauth2.initCodeClient).toBe('function')
  })

  it('happy: queued code response is delivered to callback; codeCalls records the scope', async () => {
    gis.queueCodeResponse({ code: 'xyz' })
    const { client, received, errors } = makeCodeClient()

    client.requestCode()
    // Nothing synchronous — delivery is a microtask, mirroring the token stub.
    expect(received).toEqual([])

    await Promise.resolve()

    expect(received).toEqual([{ code: 'xyz' }])
    expect(errors).toEqual([])
    expect(gis.codeCalls).toHaveLength(1)
    expect(gis.codeCalls[0].scope).toBe(REQUIRED_SCOPES.join(' '))
    expect(gis.codeCalls[0].hint).toBeUndefined()
  })

  it('records the login hint when the config carries one', async () => {
    gis.queueCodeResponse({ code: 'abc' })
    const { client } = makeCodeClient({ hint: 'user@example.com' })

    client.requestCode()
    await Promise.resolve()

    expect(gis.codeCalls[0].hint).toBe('user@example.com')
  })

  it('edge: with no queued response, requestCode yields a default fake auth code', async () => {
    const { client, received } = makeCodeClient()

    client.requestCode()
    await Promise.resolve()

    expect(received).toEqual([{ code: 'fake-auth-code' }])
  })

  it('edge: queueCodeError fires error_callback and never the success callback', async () => {
    gis.queueCodeError('popup_closed')
    const { client, received, errors } = makeCodeClient()

    client.requestCode()
    await Promise.resolve()

    expect(errors).toEqual([{ type: 'popup_closed' }])
    expect(received).toEqual([])
  })

  it('delivers an in-band { error } via callback (not error_callback)', async () => {
    gis.queueCodeResponse({ error: 'access_denied' })
    const { client, received, errors } = makeCodeClient()

    client.requestCode()
    await Promise.resolve()

    expect(received).toEqual([{ error: 'access_denied' }])
    expect(errors).toEqual([])
  })

  it('queueSilence swallows the next requestCode: neither callback fires', async () => {
    gis.queueSilence()
    gis.queueCodeResponse({ code: 'not-delivered' })
    const { client, received, errors } = makeCodeClient()

    client.requestCode()
    await Promise.resolve()
    await Promise.resolve()

    expect(received).toEqual([])
    expect(errors).toEqual([])
    expect(gis.codeCalls).toHaveLength(1)
  })

  it('reset() clears codeCalls and the queued code responses/errors', async () => {
    gis.queueCodeResponse({ code: 'first' })
    const { client } = makeCodeClient()
    client.requestCode()
    await Promise.resolve()
    expect(gis.codeCalls).toHaveLength(1)

    gis.reset()
    expect(gis.codeCalls).toHaveLength(0)

    // No leftover queued response — falls back to the default.
    const second = makeCodeClient()
    second.client.requestCode()
    await Promise.resolve()
    expect(second.received).toEqual([{ code: 'fake-auth-code' }])
  })

  it('back-compat: the legacy token client still works after the code client is added', async () => {
    gis.queueResponse({ access_token: 'tok', expires_in: 3600, scope: 'a b' })
    const w = globalThis as unknown as { google: any }
    const received: unknown[] = []
    const tokenClient = w.google.accounts.oauth2.initTokenClient({
      client_id: 'c',
      scope: 'a b',
      callback: (r: unknown) => received.push(r),
    })

    tokenClient.requestAccessToken()
    await Promise.resolve()

    expect(received).toEqual([{ access_token: 'tok', expires_in: 3600, scope: 'a b' }])
    expect(gis.calls).toEqual([{ prompt: 'consent', hint: undefined, scope: 'a b' }])
  })
})
