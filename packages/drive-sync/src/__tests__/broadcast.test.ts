import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync } from '../index.js'
import { acquireToken } from '../token.js'
import { openAuthDb } from '../storage.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'

const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
]

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

/**
 * index.ts's `createDriveSync` always resolves email via a real `fetch`
 * against the userinfo endpoint (and revokes via a real `fetch` too) — it
 * has no injectable fetchEmail like connection.ts's lower-level `connect()`.
 * This stub answers just those two "index.ts-owned" endpoints so
 * `.project(id).connect()`/`.disconnect()` exercised through the public API
 * work offline in tests (same pattern as regressions.test.ts).
 */
function createHostFetch(): typeof fetch {
  return (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : (input as Request)?.url ?? String(input)

    if (url.startsWith(USERINFO_URL)) {
      return new Response(JSON.stringify({ email: 'user@example.com' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (url.startsWith(REVOKE_URL)) {
      return new Response(null, { status: 200 })
    }

    throw new Error(`unexpected fetch to ${url}`)
  }) as unknown as typeof fetch
}

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `bcast-app-${idSeq}`, projectId: `bcast-proj-${idSeq}` }
}

/** Flushes the BroadcastChannel's async message delivery. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('cross-tab broadcast (test case 14)', () => {
  let gisFake: GisFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
    vi.stubGlobal('fetch', createHostFetch())
  })

  afterEach(() => {
    gisFake.uninstall()
    vi.unstubAllGlobals()
  })

  it("a 'logout' broadcast from tab A is observed by tab B (via shared storage + handle eviction)", async () => {
    const { appId, projectId } = freshIds()
    gisFake.queueResponse({ access_token: 'tok-a', expires_in: 3600, scope: SCOPES.join(' ') })

    const tabA = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const tabB = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })

    const disposeA = tabA.activate()
    const disposeB = tabB.activate()

    try {
      await tabA.project(projectId).connect()

      // Sanity: tab B sees the connection tab A just made (shared IndexedDB).
      const connectedFromB = await tabB.project(projectId).getConnection()
      expect(connectedFromB).not.toBeNull()

      // Capture the DB handle identity before logout so we can confirm the
      // broadcast's `logout` handling actually evicted the in-memory handle
      // cache in storage.ts (dbCache is module-level and shared by both
      // "tabs" here, same as it would be shared within one real tab's JS
      // context — this checks that the handler calls evictDbHandle at all).
      const handleBefore = openAuthDb(appId, projectId)

      await tabA.project(projectId).disconnect()

      // Give the BroadcastChannel a turn to deliver the 'logout' message to
      // tab B's subscription (index.ts's activate()).
      await flush()

      const handleAfter = openAuthDb(appId, projectId)
      expect(handleAfter).not.toBe(handleBefore)

      // The practical, user-visible effect: tab B's next read reflects the
      // logged-out state. This is actually already true via shared
      // IndexedDB storage regardless of the broadcast — disconnect() clears
      // both durable records before ever posting the message — but we
      // assert it here as the acceptance-level behavior test case 14 cares
      // about.
      const afterLogoutFromB = await tabB.project(projectId).getConnection()
      expect(afterLogoutFromB).toBeNull()
    } finally {
      disposeA()
      disposeB()
    }
  })

  it("a 'token' broadcast from tab A lets tab B skip its own redundant GIS request", async () => {
    const { appId, projectId } = freshIds()
    gisFake.queueResponse({ access_token: 'tok-shared', expires_in: 3600, scope: SCOPES.join(' ') })

    const tabA = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })
    const tabB = createDriveSync({ appId, clientId: 'client-1', folderPath: [] })

    const disposeA = tabA.activate()
    const disposeB = tabB.activate()

    try {
      // Tab A connects interactively: exactly one GIS round-trip, and (per
      // token.ts's single choke point) a 'token' broadcast is posted once
      // the fresh token is durably in IndexedDB.
      await tabA.project(projectId).connect()
      expect(gisFake.calls.length).toBe(1)

      // Let tab B's broadcast subscription (index.ts's activate()) receive
      // the 'token' message and record it via notifyExternalTokenRefresh.
      await flush()

      // Tab B now performs whatever a silent refresh/warm-up would do: a
      // non-interactive acquireToken() call for the same project+scopes.
      // Without the broadcast, this would be a fresh GIS request (no
      // in-flight coalescing entry exists in tab B's own token.ts module
      // state — this simulates a genuinely separate tab). With the
      // broadcast consumed, it should instead resolve from the token tab A
      // already persisted to shared storage, with NO additional GIS call.
      const tokenFromB = await acquireToken({
        appId,
        projectId,
        clientId: 'client-1',
        scopes: SCOPES,
        interactive: false,
      })

      expect(gisFake.calls.length).toBe(1)
      expect(tokenFromB.accessToken).toBe('tok-shared')
    } finally {
      disposeA()
      disposeB()
    }
  })

  it("without a prior 'token' broadcast, a silent acquireToken still hits GIS as normal", async () => {
    const { appId, projectId } = freshIds()
    gisFake.queueResponse({ access_token: 'solo-token', expires_in: 3600, scope: SCOPES.join(' ') })

    const token = await acquireToken({
      appId,
      projectId,
      clientId: 'client-1',
      scopes: SCOPES,
      interactive: false,
      hint: 'user@example.com',
    })

    expect(gisFake.calls.length).toBe(1)
    expect(token.accessToken).toBe('solo-token')
  })
})
