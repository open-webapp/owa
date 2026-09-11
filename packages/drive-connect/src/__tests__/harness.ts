// Shared test harness for @open-webapp/drive-connect.
//
// Wires the REAL `@open-webapp/drive-sync` facade to the GIS + Drive fakes
// exported from `@open-webapp/drive-sync/testing`, so drive-connect code can
// be exercised against genuine drive-sync behavior with no network.

import {
  createDriveFake,
  createGisFake,
  type DriveFake,
  type GisFake,
} from '@open-webapp/drive-sync/testing'
import { createDriveSync, type DriveSync } from '@open-webapp/drive-sync'

/** Scopes drive-sync's `connect()` requests and checks coverage against. */
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const USERINFO_SCOPE = 'https://www.googleapis.com/auth/userinfo.email'
const FULL_SCOPE = `${DRIVE_FILE_SCOPE} ${USERINFO_SCOPE}`

/**
 * Endpoints `createDriveSync` resolves with a plain `fetch` (no injectable
 * seam): the userinfo lookup during `connect()` and the token revocation
 * during `disconnect()`. The Drive fake does not understand these, so the
 * harness's global `fetch` answers them itself and forwards everything else
 * to the Drive fake (same pattern as drive-sync's own `regressions.test.ts`).
 */
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

export interface SeedConnectionOptions {
  /** Email the userinfo endpoint should report for this connection. */
  email?: string
  /**
   * Absolute epoch-ms expiry for the cached access token. Realized through
   * the real code path by translating to GIS's `expires_in` seconds.
   */
  expiresAt?: number
  /**
   * When true, the seeded grant covers only `drive.file` (not the userinfo
   * scope), so drive-sync's own scope-coverage check makes
   * `getConnection().needsReauth` true — produced through the real path.
   */
  needsReauth?: boolean
}

export interface Harness {
  /** The real drive-sync facade, backed by the fakes. */
  drive: DriveSync
  gisFake: GisFake
  driveFake: DriveFake
  /** Fixed test project id. */
  projectId: string
  /** Establish a stored connection by running a real fake-backed `connect()`. */
  seedConnection(opts?: SeedConnectionOptions): Promise<void>
  /** Uninstall both fakes and restore global fetch. Safe to call twice. */
  cleanup(): void
  /** Simulates another tab logging out, via the same channel drive-sync's `createBroadcast('test-app')` uses. */
  crossTabLogout(): void
}

export function makeHarness(): Harness {
  const projectId = 'app'

  const gisFake = createGisFake()
  const driveFake = createDriveFake()

  // Email the fake userinfo endpoint returns for the next / current
  // connection. seedConnection() sets this before driving `connect()`.
  let currentEmail = 'user@example.com'

  const hostFetch = (async (
    input: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : ((input as Request)?.url ?? String(input))

    if (url.startsWith(USERINFO_URL)) {
      return new Response(JSON.stringify({ email: currentEmail }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (url.startsWith(REVOKE_URL)) {
      return new Response(null, { status: 200 })
    }

    return driveFake.fetch(input as Parameters<typeof fetch>[0], init)
  }) as unknown as typeof fetch

  const hadFetch = 'fetch' in globalThis
  const originalFetch = globalThis.fetch

  gisFake.install()
  globalThis.fetch = hostFetch

  const drive = createDriveSync({
    appId: 'test-app',
    clientId: 'test-client',
    folderPath: ['Test'],
  })

  let tokenSeq = 0

  async function seedConnection(opts: SeedConnectionOptions = {}): Promise<void> {
    if (opts.email !== undefined) currentEmail = opts.email

    tokenSeq += 1
    const accessToken = `seed-tok-${tokenSeq}`
    const expiresIn =
      opts.expiresAt !== undefined
        ? Math.max(1, Math.round((opts.expiresAt - Date.now()) / 1000))
        : 3600

    gisFake.queueResponse({
      access_token: accessToken,
      expires_in: expiresIn,
      // Withholding the userinfo scope is the real signal drive-sync uses to
      // compute needsReauth in getConnection() — no direct store write needed.
      scope: opts.needsReauth ? DRIVE_FILE_SCOPE : FULL_SCOPE,
    })

    await drive.project(projectId).connect()
  }

  let cleanedUp = false
  function cleanup(): void {
    if (cleanedUp) return
    cleanedUp = true
    gisFake.uninstall()
    if (hadFetch) {
      globalThis.fetch = originalFetch
    } else {
      delete (globalThis as { fetch?: typeof fetch }).fetch
    }
  }

  function crossTabLogout(): void {
    new BroadcastChannel('owa-drive-test-app').postMessage({
      type: 'logout',
      projectId,
    })
  }

  return {
    drive,
    gisFake,
    driveFake,
    projectId,
    seedConnection,
    cleanup,
    crossTabLogout,
  }
}
