import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForGoogleIdentityServices } from '../gis.js'
import { GisLoadError } from '../errors.js'

function installGis(): void {
  const w = globalThis as unknown as { google?: any }
  w.google = { accounts: { oauth2: { initTokenClient: () => ({ requestAccessToken() {} }) } } }
}

function uninstallGis(): void {
  delete (globalThis as any).google
}

describe('waitForGoogleIdentityServices', () => {
  beforeEach(() => {
    uninstallGis()
  })

  afterEach(() => {
    uninstallGis()
    vi.useRealTimers()
  })

  it('resolves quickly when GIS is already fully set up', async () => {
    installGis()
    await expect(waitForGoogleIdentityServices()).resolves.toBeUndefined()
  })

  it('polls and picks up GIS becoming available shortly after the call starts', async () => {
    vi.useFakeTimers()
    const promise = waitForGoogleIdentityServices()

    let settled = false
    promise.then(() => {
      settled = true
    })

    // First poll tick: GIS still not installed.
    await vi.advanceTimersByTimeAsync(100)
    expect(settled).toBe(false)

    // GIS becomes available between poll ticks.
    installGis()

    // Next poll tick should observe it and resolve.
    await vi.advanceTimersByTimeAsync(100)

    await expect(promise).resolves.toBeUndefined()
  })

  it('rejects with GisLoadError if GIS never becomes available within the timeout', async () => {
    vi.useFakeTimers()
    const promise = waitForGoogleIdentityServices()

    const expectation = expect(promise).rejects.toBeInstanceOf(GisLoadError)

    // Advance well past the 10s timeout, in poll-interval-sized steps so the
    // interval callback actually runs (a single huge jump would still fire
    // the timers, but stepping is more faithful to real polling behavior).
    for (let i = 0; i < 105; i++) {
      await vi.advanceTimersByTimeAsync(100)
    }

    await expectation
  })
})
