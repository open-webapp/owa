// Handle-level suite for `createDriveAuth` (src/auth.ts).
//
// Every case drives a REAL `createDriveAuth` over the REAL `@open-webapp/drive-sync`
// facade wired to the GIS + Drive fakes via `makeHarness()`. No drive-sync
// internals are stubbed; the only test doubles are at the drive-sync facade
// boundary (`drive.project(...)`) where a case must force a rejection or count
// facade calls.
//
// `auth.ts` no longer exposes public `getStatus()`/`subscribe()`/`refresh()`.
// Status is read either through the `useDriveConnection(auth)` React hook
// (rendered here via `@testing-library/react`'s `renderHook`) or directly via
// `h.drive.project(id).getConnectionSync()` (the real drive-sync facade).
// `tokenValid` isn't part of the hook's output, so cases needing it reach for
// the internal `INTERNAL_STATUS` symbol's `getMergedSnapshot()` directly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { NeedsReauthError } from '@open-webapp/drive-sync'
import { createDriveAuth, INTERNAL_STATUS } from '../auth.js'
import { useDriveConnection } from '../useDriveConnection.js'
import { makeHarness } from './harness.js'
import type { DriveAuthHandle, DriveAuthStatus } from '../types.js'

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const USERINFO_SCOPE = 'https://www.googleapis.com/auth/userinfo.email'
const FULL_SCOPE = `${DRIVE_FILE_SCOPE} ${USERINFO_SCOPE}`

let seq = 0
/** A queued GIS success response covering both required scopes. */
function goodResponse(over: Record<string, unknown> = {}) {
  seq += 1
  return { access_token: `tok-${seq}`, expires_in: 3600, scope: FULL_SCOPE, ...over }
}

/** A couple of macrotask ticks — enough for fire-and-forget re-reads/lazy hydrate kicks to land. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** Reads the internal merged snapshot off a handle, bypassing the hook. */
function mergedSnapshot(handle: DriveAuthHandle): DriveAuthStatus {
  return (handle as any)[INTERNAL_STATUS].getMergedSnapshot()
}

/**
 * `getMergedSnapshot()` only recomputes on its very first call (lazy) or when
 * a live `subscribeMerged` listener's notify fires. A handle with no active
 * subscription returns a stale cached snapshot forever after that first
 * call, so any test that reads `mergedSnapshot()` more than once across a
 * state change must keep a listener attached — this does that.
 */
function keepStatusLive(handle: DriveAuthHandle): () => void {
  return (handle as any)[INTERNAL_STATUS].subscribeMerged(() => {})
}

let h: ReturnType<typeof makeHarness>
let auth: DriveAuthHandle

beforeEach(() => {
  h = makeHarness()
  auth = createDriveAuth({ drive: h.drive, projectId: h.projectId })
  keepStatusLive(auth)
})

afterEach(() => {
  // Restore before setup.ts's afterEach wipes IndexedDB (fake-indexeddb needs
  // real timers to settle its delete requests).
  vi.useRealTimers()
  vi.restoreAllMocks()
  h.cleanup()
})

describe('createDriveAuth handle', () => {
  it('1. no stored connection -> all-false status via the hook, no popup', async () => {
    const { result } = renderHook(() => useDriveConnection(auth))

    await waitFor(() => {
      expect(result.current).toMatchObject({
        connected: false,
        needsReauth: false,
        email: null,
      })
    })
    expect(h.gisFake.calls.length).toBe(0)
  })

  it('2. a seeded connection is visible via the hook, and the hook re-renders exactly once for it', async () => {
    const expectedExpiry = Date.now() + 3_600_000

    const { result, rerender } = renderHook(() => useDriveConnection(auth))
    await waitFor(() => expect(result.current.connected).toBe(false))

    // seedConnection drives a real connect() on a DIFFERENT handle path (the
    // facade directly, not through `auth`), which notifies the hook's
    // subscription outside of a React event handler — wrap it in `act` so
    // React flushes the resulting state update synchronously.
    await act(async () => {
      await h.seedConnection({ email: 'a@b.com', expiresAt: expectedExpiry })
    })
    await waitFor(() => expect(result.current.connected).toBe(true))

    expect(result.current.email).toBe('a@b.com')
    expect(result.current.needsReauth).toBe(false)

    const conn = h.drive.project(h.projectId).getConnectionSync()
    expect(conn).not.toBeNull()
    expect(Math.abs((conn?.expiresAt ?? 0) - expectedExpiry)).toBeLessThan(2000)

    rerender()
    expect(result.current.connected).toBe(true)
  })

  it('3. ensureFresh() token-runway boundary: interactive connect iff the cached token is not usable', async () => {
    // Freeze the clock so the strict `expiresAt > now + bufferMs` boundary is
    // exact. setImmediate is left real so fake-indexeddb keeps working.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const now = Date.now()
      const bufferMs = 5 * 60 * 1000

      // Row A — expiresAt exactly at (now + bufferMs): NOT usable (strict `>`) -> interactive.
      {
        const a = createDriveAuth({ drive: h.drive, projectId: h.projectId })
        await h.seedConnection({ expiresAt: now + bufferMs })
        const before = h.gisFake.calls.length
        h.gisFake.queueResponse(goodResponse())
        await a.ensureFresh()
        expect(h.gisFake.calls.length - before).toBe(1)
      }

      // Row B — one whole second past the buffer: usable -> NO interactive.
      // NOTE: the plan's `now + bufferMs + 1` (sub-second) cannot be expressed
      // through the harness. `seedConnection` routes expiry through GIS's
      // integer-seconds `expires_in`, so +1000ms is the smallest increment
      // past the buffer that survives the round-trip.
      {
        const b = createDriveAuth({ drive: h.drive, projectId: h.projectId })
        await h.seedConnection({ expiresAt: now + bufferMs + 1000 })
        const before = h.gisFake.calls.length
        await b.ensureFresh()
        expect(h.gisFake.calls.length - before).toBe(0)
      }

      // Row C — `expiresAt: null` is not expressible: `seedConnection` always
      // persists a token with a numeric expiry and the harness exposes no hook
      // for a connection with no token / null expiry. The "not usable ->
      // interactive" path it would exercise is covered by Row D through the
      // other real unusable-token signal (needsReauth).

      // Row D — needsReauth:true (userinfo scope withheld) with plenty of
      // runway: NOT usable -> interactive.
      {
        const d = createDriveAuth({ drive: h.drive, projectId: h.projectId })
        await h.seedConnection({ needsReauth: true, expiresAt: now + 3_600_000 })
        const before = h.gisFake.calls.length
        h.gisFake.queueResponse(goodResponse())
        await d.ensureFresh()
        expect(h.gisFake.calls.length - before).toBe(1)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('4. concurrent connect() calls fold into one popup and resolve the same Connection', async () => {
    h.gisFake.queueResponse(goodResponse())

    const [c1, c2] = await Promise.all([auth.connect(), auth.connect()])

    expect(h.gisFake.calls.length).toBe(1)
    expect(c1).toBe(c2)
  })

  it('5. ensureFresh() + connect() in parallel fold into one popup', async () => {
    h.gisFake.queueResponse(goodResponse())

    const [a, b] = await Promise.all([auth.ensureFresh(), auth.connect()])

    expect(h.gisFake.calls.length).toBe(1)
    expect(a).toBe(b)
  })

  it('6. a failed connect() sets the error status and resets the in-flight guard', async () => {
    h.gisFake.queuePopupError('access_denied')

    await expect(auth.connect()).rejects.toThrow(/access_denied/)

    const failed = mergedSnapshot(auth)
    expect(failed.connected).toBe(false)
    expect(typeof failed.error).toBe('string')
    expect(failed.error).toBeTruthy()
    expect(h.gisFake.calls.length).toBe(1)

    // Guard was cleared in `finally` -> a second connect starts a fresh flow.
    h.gisFake.queueResponse(goodResponse())
    const conn = await auth.connect()
    expect(conn).toBeTruthy()
    expect(h.gisFake.calls.length).toBe(2)
    expect(mergedSnapshot(auth).connected).toBe(true)
    expect(mergedSnapshot(auth).error).toBeNull()
  })

  it('7. connect() rejects with "Google auth timed out" after 10s of GIS silence', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      h.gisFake.queueSilence()

      const settled = auth.connect().then(
        () => 'resolved' as const,
        (e: unknown) => e,
      )

      await vi.advanceTimersByTimeAsync(10_000)

      const err = await settled
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toBe('Google auth timed out')

      const status = mergedSnapshot(auth)
      expect(status.connected).toBe(false)
      expect(status.error).toBe('Google auth timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('8. beforeInteractive wraps connect() and disconnect() only', async () => {
    const wrap = vi.fn((fn: () => Promise<unknown>) => fn()) as unknown as <T>(
      fn: () => Promise<T>,
    ) => Promise<T>
    const a = createDriveAuth({
      drive: h.drive,
      projectId: h.projectId,
      beforeInteractive: wrap,
    })
    await h.seedConnection({ email: 'x@y.com', expiresAt: Date.now() + 3_600_000 })
    await flush()

    expect(wrap).toHaveBeenCalledTimes(0)

    // Cached token still has runway -> fast path, no wrap.
    await a.ensureFresh()
    expect(wrap).toHaveBeenCalledTimes(0)

    h.gisFake.queueResponse(goodResponse())
    await a.connect()
    expect(wrap).toHaveBeenCalledTimes(1)

    await a.disconnect()
    expect(wrap).toHaveBeenCalledTimes(2)
  })

  it('9. disconnect() clears status on success; keeps the connection on failure', async () => {
    // Success path.
    await h.seedConnection({ email: 'z@z.com', expiresAt: Date.now() + 3_600_000 })
    await flush()
    expect(h.drive.project(h.projectId).getConnectionSync()).not.toBeNull()
    expect(mergedSnapshot(auth).connected).toBe(true)

    await auth.disconnect()
    expect(mergedSnapshot(auth)).toMatchObject({ connected: false, email: null, connecting: false, error: null })

    // Failure path — force `project().disconnect()` to reject at the drive-sync
    // facade boundary (no internals stubbed).
    const failure = new Error('revoke failed')
    const realProject = h.drive.project.bind(h.drive)
    h.drive.project = ((id: string) => {
      const handle = realProject(id)
      return { ...handle, disconnect: () => Promise.reject(failure) }
    }) as typeof h.drive.project

    const a = createDriveAuth({ drive: h.drive, projectId: h.projectId })
    keepStatusLive(a)
    await h.seedConnection({ email: 'z@z.com', expiresAt: Date.now() + 3_600_000 })
    await flush()
    expect(mergedSnapshot(a).connected).toBe(true)

    await expect(a.disconnect()).rejects.toBe(failure)

    const after = mergedSnapshot(a)
    expect(after.error).toBe('revoke failed')
    expect(after.connecting).toBe(false)
    expect(after.connected).toBe(true)
    expect(after.email).toBe('z@z.com')
  })

  it('10. activate() forwards to drive.activate(); no other handle method calls it', async () => {
    const spy = vi.spyOn(h.drive, 'activate')

    mergedSnapshot(auth)
    h.gisFake.queueResponse(goodResponse())
    await auth.connect()
    await auth.ensureFresh()
    await auth.disconnect()

    expect(spy).not.toHaveBeenCalled()

    const teardown = auth.activate()
    expect(typeof teardown).toBe('function')
    expect(() => teardown()).not.toThrow()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('11. never calls window.alert (connect ok, connect fail, disconnect fail)', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})

    h.gisFake.queueResponse(goodResponse())
    await auth.connect()

    h.gisFake.queuePopupError('access_denied')
    await auth.connect().catch(() => {})

    const realProject = h.drive.project.bind(h.drive)
    h.drive.project = ((id: string) => {
      const handle = realProject(id)
      return { ...handle, disconnect: () => Promise.reject(new Error('boom')) }
    }) as typeof h.drive.project
    const a = createDriveAuth({ drive: h.drive, projectId: h.projectId })
    await a.disconnect().catch(() => {})

    expect(alertSpy).not.toHaveBeenCalled()
  })

  it('12. drive-sync popup_closed error propagates unchanged; no extra facade getConnection() call', async () => {
    // Wrap the facade to count `getConnection()` calls without stubbing internals.
    let getConnectionCalls = 0
    const realProject = h.drive.project.bind(h.drive)
    h.drive.project = ((id: string) => {
      const handle = realProject(id)
      const realGetConnection = handle.getConnection.bind(handle)
      return {
        ...handle,
        getConnection: () => {
          getConnectionCalls += 1
          return realGetConnection()
        },
      }
    }) as typeof h.drive.project

    const a = createDriveAuth({ drive: h.drive, projectId: h.projectId })

    // popup_closed with NO recoverable grant: drive-sync's own prompt:'none'
    // probe runs 3 times, every attempt fails, and it rethrows its original
    // NeedsReauthError(reason:'popup_closed') — the state exercised by
    // drive-sync's "still reports a genuinely cancelled sign-in" test.
    h.gisFake.queuePopupError('popup_closed')
    h.gisFake.queueResponse({ error: 'interaction_required' })
    h.gisFake.queueResponse({ error: 'interaction_required' })
    h.gisFake.queueResponse({ error: 'interaction_required' })

    const err = await a.connect().then(
      () => {
        throw new Error('connect() should have rejected')
      },
      (e: unknown) => e,
    )

    expect(err).toBeInstanceOf(NeedsReauthError)
    expect((err as NeedsReauthError).name).toBe('NeedsReauthError')
    expect((err as NeedsReauthError).reason).toBe('popup_closed')
    expect((err as Error).message).toContain('closed before completing')
    expect(mergedSnapshot(a).error).toBe((err as Error).message)
    expect(mergedSnapshot(a).connected).toBe(false)

    const failPathGetConnectionCalls = getConnectionCalls

    // Guard reset -> a fresh connect opens a new flow and succeeds.
    getConnectionCalls = 0
    h.gisFake.queueResponse(goodResponse())
    const conn = await a.connect()
    expect(conn).toBeTruthy()
    const successPathGetConnectionCalls = getConnectionCalls

    // `connect()` no longer calls `refresh()` (removed): drive-sync's internal
    // post-connect re-read goes through `getConnectionImpl` directly, NOT the
    // facade's public `getConnection()`. Neither path issues a facade
    // `getConnection()` call any more.
    expect(failPathGetConnectionCalls).toBe(0)
    expect(successPathGetConnectionCalls).toBe(0)
  }, 15_000)

  it('13. handle has no refresh/getStatus/subscribe methods', () => {
    expect((auth as any).refresh).toBeUndefined()
    expect((auth as any).getStatus).toBeUndefined()
    expect((auth as any).subscribe).toBeUndefined()
  })

  it("14. hook's merged snapshot returns a stable reference across renders with no state change", async () => {
    // The hook's own return value is a fresh literal every render (by
    // design — see useDriveConnection.ts), so reference stability is
    // asserted on the underlying merged snapshot `useSyncExternalStore`
    // actually reads (`getMergedSnapshot()`), which is what gates whether
    // React treats the store as "changed" and re-renders at all.
    const { result, rerender } = renderHook(() => useDriveConnection(auth))
    await waitFor(() => expect(result.current.connected).toBe(false))

    const snapshotBefore = mergedSnapshot(auth)
    const fieldsBefore = result.current
    rerender()
    const snapshotAfter = mergedSnapshot(auth)

    expect(snapshotAfter).toBe(snapshotBefore)
    expect(result.current).toEqual(fieldsBefore)
  })

  it('15. hook fans in drive-sync connection changes made outside of auth', async () => {
    await h.seedConnection({ email: 'fan@in.com' })

    const { result } = renderHook(() => useDriveConnection(auth))
    await waitFor(() => expect(result.current.connected).toBe(true))
    expect(result.current.email).toBe('fan@in.com')

    // Bypass `auth` entirely — disconnect via the raw drive-sync facade.
    await act(async () => {
      await h.drive.project(h.projectId).disconnect()
    })

    await waitFor(() => expect(result.current.connected).toBe(false))
    expect(result.current.email).toBeNull()
  })

  it('16. tokenValid on the internal merged snapshot is frozen between notifies', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const bufferMs = 5 * 60 * 1000
      const now = Date.now()
      await h.seedConnection({ expiresAt: now + bufferMs + 1000 })

      // First read hydrates + caches the snapshot: token has runway -> valid.
      expect(mergedSnapshot(auth).tokenValid).toBe(true)

      // Advance real time past the buffer with NO intervening
      // connect/disconnect/warm-up/broadcast: the cached snapshot must not
      // recompute on a bare read.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
      expect(mergedSnapshot(auth).tokenValid).toBe(true)

      // Force a notify: disconnect() then reconnect flips overlay/connection
      // state, which recomputes the merged snapshot from scratch.
      await auth.disconnect()
      expect(mergedSnapshot(auth).tokenValid).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('barrel exports', () => {
  it('re-exports the 3 runtime symbols as functions', async () => {
    const pkg = await import('../index.js')
    expect(typeof pkg.createDriveAuth).toBe('function')
    expect(typeof pkg.useDriveConnection).toBe('function')
    expect(typeof pkg.GoogleDriveWidget).toBe('function')
  })

  it('imports cleanly at module scope and exposes exactly the 3 runtime keys', async () => {
    const pkg = await import('../index.js')
    expect(Object.keys(pkg).sort()).toEqual(
      ['GoogleDriveWidget', 'createDriveAuth', 'useDriveConnection'].sort(),
    )
  })

  it('does not re-export statusStore internals', async () => {
    const pkg = (await import('../index.js')) as Record<string, unknown>
    expect(pkg.createStatusStore).toBeUndefined()
    expect(pkg.isTokenUsable).toBeUndefined()
  })
})
