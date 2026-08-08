import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync } from '../index.js'
import { warmUpIfNeeded } from '../refresh.js'
import { setConn, setToken } from '../storage.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import type { StoredToken } from '../types.js'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
]

const REFRESH_BUFFER_MS = 5 * 60 * 1000

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `refresh-app-${idSeq}`, projectId: `refresh-proj-${idSeq}` }
}

/** Flushes pending microtasks/timers used by async event handlers. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * The vitest.config.ts environment for this package is 'node' (see
 * setup.ts), so there is no real `document`/`window` global — index.ts and
 * refresh.ts both feature-detect via `typeof document === 'undefined'` and
 * no-op when absent (this is exercised by other tests, e.g. broadcast.test.ts,
 * where `.activate()` runs with no DOM at all).
 *
 * To exercise the actual listener-attachment behavior (test case 18) we
 * stub in minimal `document`/`window` doubles built on Node's built-in
 * `EventTarget` (available globally since Node 15.4), which supports real
 * `addEventListener`/`removeEventListener`/`dispatchEvent` semantics that we
 * can spy on directly with `vi.spyOn`.
 */
interface FakeDocument extends EventTarget {
  visibilityState: 'visible' | 'hidden'
  hidden: boolean
}

function createFakeDocument(): FakeDocument {
  const target = new EventTarget() as FakeDocument
  target.visibilityState = 'visible'
  target.hidden = false
  return target
}

function createFakeWindow(): EventTarget {
  return new EventTarget()
}

describe('refresh.ts / index.ts activate() listener wiring (test case 18)', () => {
  let fakeDocument: FakeDocument
  let fakeWindow: EventTarget
  let docAddSpy: ReturnType<typeof vi.spyOn>
  let docRemoveSpy: ReturnType<typeof vi.spyOn>
  let winAddSpy: ReturnType<typeof vi.spyOn>
  let winRemoveSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fakeDocument = createFakeDocument()
    fakeWindow = createFakeWindow()
    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('window', fakeWindow)
    docAddSpy = vi.spyOn(fakeDocument, 'addEventListener')
    docRemoveSpy = vi.spyOn(fakeDocument, 'removeEventListener')
    winAddSpy = vi.spyOn(fakeWindow, 'addEventListener')
    winRemoveSpy = vi.spyOn(fakeWindow, 'removeEventListener')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('constructing a DriveSync instance (module already imported) attaches no listeners', () => {
    // `createDriveSync` itself is documented to attach NO listeners and make
    // NO network calls until `.activate()` is actually called.
    createDriveSync({ appId: 'unused', clientId: 'client-1', folderPath: [] })

    expect(docAddSpy).not.toHaveBeenCalled()
    expect(winAddSpy).not.toHaveBeenCalled()
  })

  it('activate() attaches exactly one visibilitychange + one pageshow listener; the disposer removes exactly those two', () => {
    const sync = createDriveSync({ appId: 'app-18', clientId: 'client-1', folderPath: [] })

    const dispose = sync.activate()

    expect(docAddSpy).toHaveBeenCalledTimes(1)
    expect(docAddSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(winAddSpy).toHaveBeenCalledTimes(1)
    expect(winAddSpy).toHaveBeenCalledWith('pageshow', expect.any(Function))

    const [visEventName, visHandler] = docAddSpy.mock.calls[0]!
    const [pageShowEventName, pageShowHandler] = winAddSpy.mock.calls[0]!

    dispose()

    expect(docRemoveSpy).toHaveBeenCalledTimes(1)
    expect(docRemoveSpy).toHaveBeenCalledWith(visEventName, visHandler)
    expect(winRemoveSpy).toHaveBeenCalledTimes(1)
    expect(winRemoveSpy).toHaveBeenCalledWith(pageShowEventName, pageShowHandler)
  })
})

describe('warmUpIfNeeded refresh guard (test case 19)', () => {
  let gisFake: GisFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
  })

  afterEach(() => {
    gisFake.uninstall()
  })

  it('no connection at all -> no warm-up (zero GIS calls)', async () => {
    const { appId, projectId } = freshIds()

    await warmUpIfNeeded({ appId, projectId, clientId: 'client-1' })

    expect(gisFake.calls.length).toBe(0)
  })

  it('connection exists with a fresh (non-stale) token -> no warm-up', async () => {
    const { appId, projectId } = freshIds()

    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: SCOPES,
      connectedAt: Date.now(),
    })
    const freshToken: StoredToken = {
      accessToken: 'still-good',
      // Comfortably outside the 5-minute refresh buffer.
      expiresAt: Date.now() + 60 * 60 * 1000,
      grantedScopes: SCOPES,
    }
    await setToken(appId, projectId, freshToken)

    await warmUpIfNeeded({ appId, projectId, clientId: 'client-1' })

    expect(gisFake.calls.length).toBe(0)
  })

  it('connection exists with a token inside the refresh buffer -> exactly one non-interactive warm-up', async () => {
    const { appId, projectId } = freshIds()

    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: SCOPES,
      connectedAt: Date.now(),
    })
    const staleToken: StoredToken = {
      accessToken: 'about-to-expire',
      // Inside the 5-minute refresh buffer (1 minute left).
      expiresAt: Date.now() + REFRESH_BUFFER_MS - 4 * 60 * 1000,
      grantedScopes: SCOPES,
    }
    await setToken(appId, projectId, staleToken)

    gisFake.queueResponse({
      access_token: 'refreshed-token',
      expires_in: 3600,
      scope: SCOPES.join(' '),
    })

    await warmUpIfNeeded({ appId, projectId, clientId: 'client-1' })

    expect(gisFake.calls.length).toBe(1)
    expect(gisFake.calls[0]).toMatchObject({ prompt: 'none' })
  })

  it('connection exists with no cached token at all -> treated as stale, exactly one non-interactive warm-up', async () => {
    const { appId, projectId } = freshIds()

    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: SCOPES,
      connectedAt: Date.now(),
    })
    // Deliberately no setToken() call: connection exists, but no cached token.

    gisFake.queueResponse({
      access_token: 'first-token',
      expires_in: 3600,
      scope: SCOPES.join(' '),
    })

    await warmUpIfNeeded({ appId, projectId, clientId: 'client-1' })

    expect(gisFake.calls.length).toBe(1)
    expect(gisFake.calls[0]).toMatchObject({ prompt: 'none' })
  })
})

describe('visibilitychange never starts a refresh while hidden (test case 20)', () => {
  let fakeDocument: FakeDocument
  let fakeWindow: EventTarget
  let gisFake: GisFake

  beforeEach(() => {
    fakeDocument = createFakeDocument()
    fakeWindow = createFakeWindow()
    vi.stubGlobal('document', fakeDocument)
    vi.stubGlobal('window', fakeWindow)
    gisFake = createGisFake()
    gisFake.install()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    gisFake.uninstall()
  })

  it('a visibilitychange fired while the document is hidden does not trigger any warm-up, even for a project with a stale token', async () => {
    const { appId, projectId } = freshIds()

    await setConn(appId, projectId, {
      email: 'user@example.com',
      grantedScopes: SCOPES,
      connectedAt: Date.now(),
    })
    const staleToken: StoredToken = {
      accessToken: 'about-to-expire',
      expiresAt: Date.now() + REFRESH_BUFFER_MS - 4 * 60 * 1000,
      grantedScopes: SCOPES,
    }
    await setToken(appId, projectId, staleToken)
    // If a warm-up were (incorrectly) triggered, this queued response would
    // be consumed and gisFake.calls would grow.
    gisFake.queueResponse({
      access_token: 'should-not-be-used',
      expires_in: 3600,
      scope: SCOPES.join(' '),
    })

    const sync = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    sync.project(projectId) // registers projectId in the tracked set
    const dispose = sync.activate()

    try {
      fakeDocument.visibilityState = 'hidden'
      fakeDocument.hidden = true
      fakeDocument.dispatchEvent(new Event('visibilitychange'))

      await flush()

      expect(gisFake.calls.length).toBe(0)
    } finally {
      dispose()
    }
  })

  // NOTE on the second half of test case 20 ("a refresh already retrying
  // when the tab hides is allowed to finish"): this is a property of
  // warmUpIfNeeded() simply never being re-invoked while hidden (see the
  // doc comment on warmUpIfNeeded in refresh.ts) rather than any explicit
  // in-flight/abort tracking - there is no internal state (no AbortController,
  // no "in-flight" flag) exposed by refresh.ts or index.ts to distinguish "a
  // warm-up that started before the tab hid, still running" from "no warm-up
  // running" from outside. warmUpIfNeeded also swallows all errors via its
  // top-level try/catch, so there's no observable signal (rejection, thrown
  // error, telemetry) if hiding the tab *did* interrupt something - the
  // guarantee here is architectural (visibility is only ever checked before
  // starting, never polled mid-flight) rather than something a black-box test
  // can distinguish from a implementation that (incorrectly) aborted and
  // silently swallowed the abort. We rely on the visible-vs-hidden guard test
  // above plus code review of warmUpIfNeeded/activate for this half.
})
