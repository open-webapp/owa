import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForGoogleIdentityServices } from '../gis.js'
import { GisLoadError } from '../errors.js'
import type { Logger } from '../logger.js'

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

    // Reproduces the old googleAuth.ts regression: callers used to see a raw
    // TypeError ("Cannot read properties of undefined (reading 'accounts')")
    // instead of a clear, typed failure. Assert the concrete error shape
    // (not just "some rejection") so a regression back to an untyped/blank
    // error would be caught here.
    const expectation = expect(promise).rejects.toMatchObject({
      name: 'GisLoadError',
      message: 'Google Identity Services failed to load in time',
    })

    // Advance well past the 10s timeout, in poll-interval-sized steps so the
    // interval callback actually runs (a single huge jump would still fire
    // the timers, but stepping is more faithful to real polling behavior).
    for (let i = 0; i < 105; i++) {
      await vi.advanceTimersByTimeAsync(100)
    }

    await expectation
    await expect(promise).rejects.toBeInstanceOf(GisLoadError)

    // The polling interval must be cleared on rejection, or it would keep
    // firing (and leak) after the promise has already settled.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the polling interval once GIS becomes available (no leaked timers)', async () => {
    vi.useFakeTimers()
    const promise = waitForGoogleIdentityServices()

    await vi.advanceTimersByTimeAsync(100)
    installGis()
    await vi.advanceTimersByTimeAsync(100)

    await expect(promise).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports polling progress via the optional logger while GIS is not yet available', async () => {
    vi.useFakeTimers()
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    const promise = waitForGoogleIdentityServices(logger)

    await vi.advanceTimersByTimeAsync(100)
    expect(logger.debug).toHaveBeenCalled()

    installGis()
    await vi.advanceTimersByTimeAsync(100)

    await expect(promise).resolves.toBeUndefined()
  })
})
