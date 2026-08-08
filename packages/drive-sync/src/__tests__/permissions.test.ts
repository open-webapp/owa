import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync, type ProjectHandle } from '../index.js'
import { REQUIRED_SCOPES } from '../files.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import { createDriveFake, type DriveFake } from '../testing/driveFake.js'

/**
 * Coverage in this file has two sources:
 *
 * 1. A port of the meaningful cases from the old app-level
 *    notesdiary/app/src/__tests__/driveApi.test.ts (`listPermissions`,
 *    `createPermission`, `createAnyonePermission`, `updatePermission`,
 *    `deletePermission` describe blocks), rewritten against this library's
 *    public `p.permissions.*` API and its `driveFake` in-memory double.
 *    Dropped: the raw-fetch-shape assertions (exact URL substrings, method,
 *    Authorization header, hand-parsed request body) and the
 *    `sendNotificationEmail` query-param tests — that option does not exist
 *    on this library's `GrantPermissionOptions`, so there is nothing to
 *    port; and the "throws on non-ok response" cases, whose typed-error
 *    behavior is already covered generically for every op (including
 *    permissions.*) by regressions.test.ts's R9.
 *
 * 2. New coverage for plan item #24 ("Drive ops (library)"): a full
 *    list/grant(user)/grant(anyone)/update/revoke lifecycle against the
 *    in-memory fake.
 */

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

let idSeq = 0
function freshId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

function createHostFetch(driveFake: DriveFake): typeof fetch {
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
    return driveFake.fetch(input as any, init)
  }) as unknown as typeof fetch
}

describe('permissions (ported coverage + plan item #24)', () => {
  let gisFake: GisFake
  let driveFake: DriveFake

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
    driveFake = createDriveFake()
    vi.stubGlobal('fetch', createHostFetch(driveFake))
  })

  afterEach(() => {
    gisFake.uninstall()
    vi.unstubAllGlobals()
  })

  function makeProject(): ProjectHandle {
    const appId = freshId('app')
    const projectId = freshId('proj')
    const ds = createDriveSync({ appId, clientId: 'client-1', folderPath: ['Root'] })
    return ds.project(projectId)
  }

  function queueToken(): void {
    gisFake.queueResponse({ access_token: freshId('tok'), expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
  }

  async function connect(project: ProjectHandle): Promise<void> {
    queueToken()
    await project.connect()
  }

  function seedFile(id: string): void {
    driveFake.files.set(id, {
      id,
      name: 'shared.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'shared content',
      contentType: 'text/plain',
    })
  }

  // ---------------------------------------------------------------------
  // Ported from driveApi.test.ts's `listPermissions` describe block.
  // ---------------------------------------------------------------------

  it('list() returns [] for a file with no permissions (ported: "returns [] when the response has no permissions key")', async () => {
    const project = makeProject()
    await connect(project)
    seedFile('file-1')

    queueToken()
    const result = await project.permissions.list('file-1')
    expect(result).toEqual([])
  })

  it('list() returns the permissions recorded against a file (ported: "returns the parsed permissions array from the response")', async () => {
    const project = makeProject()
    await connect(project)
    seedFile('file-1')
    driveFake.permissions.set(
      'file-1',
      new Map([
        ['perm-1', { id: 'perm-1', type: 'user', role: 'writer', emailAddress: 'a@example.com' }],
        ['perm-2', { id: 'perm-2', type: 'anyone', role: 'reader' }],
      ])
    )

    queueToken()
    const result = await project.permissions.list('file-1')
    expect(result).toEqual([
      { id: 'perm-1', type: 'user', role: 'writer', emailAddress: 'a@example.com' },
      { id: 'perm-2', type: 'anyone', role: 'reader' },
    ])
  })

  // ---------------------------------------------------------------------
  // Ported from driveApi.test.ts's `createPermission` describe block.
  // ---------------------------------------------------------------------

  it('grant() with type "user" sends the emailAddress and role, and the fake records them (ported: "sends type user with emailAddress and role")', async () => {
    const project = makeProject()
    await connect(project)
    seedFile('file-1')

    queueToken()
    const result = await project.permissions.grant({
      fileId: 'file-1',
      type: 'user',
      role: 'writer',
      emailAddress: 'a@example.com',
    })

    expect(result.type).toBe('user')
    expect(result.role).toBe('writer')
    expect(result.emailAddress).toBe('a@example.com')

    const stored = driveFake.permissions.get('file-1')?.get(result.id)
    expect(stored?.type).toBe('user')
    expect(stored?.role).toBe('writer')
    expect(stored?.emailAddress).toBe('a@example.com')
  })

  // ---------------------------------------------------------------------
  // Ported from driveApi.test.ts's `createAnyonePermission` describe block.
  // ---------------------------------------------------------------------

  it('grant() with type "anyone" omits emailAddress entirely (ported: "sends type anyone without an emailAddress key")', async () => {
    const project = makeProject()
    await connect(project)
    seedFile('file-1')

    queueToken()
    const result = await project.permissions.grant({ fileId: 'file-1', type: 'anyone', role: 'reader' })

    expect(result.type).toBe('anyone')
    expect(result.role).toBe('reader')
    expect(result).not.toHaveProperty('emailAddress')

    const stored = driveFake.permissions.get('file-1')?.get(result.id)
    expect(stored?.emailAddress).toBeUndefined()
  })

  // ---------------------------------------------------------------------
  // Ported from driveApi.test.ts's `updatePermission` describe block.
  // ---------------------------------------------------------------------

  it('update() changes the role, and the change is visible via a subsequent list() (ported: "sends a PATCH to permissions/{id} with body {role}")', async () => {
    const project = makeProject()
    await connect(project)
    seedFile('file-1')
    driveFake.permissions.set(
      'file-1',
      new Map([['perm-1', { id: 'perm-1', type: 'user', role: 'writer', emailAddress: 'a@example.com' }]])
    )

    queueToken()
    const updated = await project.permissions.update({ fileId: 'file-1', permissionId: 'perm-1', role: 'reader' })
    expect(updated.role).toBe('reader')

    queueToken()
    const afterList = await project.permissions.list('file-1')
    expect(afterList.find((p) => p.id === 'perm-1')?.role).toBe('reader')
  })

  // ---------------------------------------------------------------------
  // Ported from driveApi.test.ts's `deletePermission` describe block.
  // ---------------------------------------------------------------------

  it('revoke() removes the permission, and it no longer appears in a subsequent list() (ported: "sends a DELETE to permissions/{id}" / "resolves to undefined on success")', async () => {
    const project = makeProject()
    await connect(project)
    seedFile('file-1')
    driveFake.permissions.set(
      'file-1',
      new Map([['perm-1', { id: 'perm-1', type: 'anyone', role: 'reader' }]])
    )

    queueToken()
    await expect(project.permissions.revoke({ fileId: 'file-1', permissionId: 'perm-1' })).resolves.toBeUndefined()
    expect(driveFake.permissions.get('file-1')?.has('perm-1')).toBe(false)

    queueToken()
    const afterList = await project.permissions.list('file-1')
    expect(afterList).toEqual([])
  })

  // ---------------------------------------------------------------------
  // Plan #24 — list/grant(user)/grant(anyone)/update/revoke against the
  // in-memory fake, exercised end-to-end as one lifecycle.
  // ---------------------------------------------------------------------

  it('#24 — full permissions lifecycle: list, grant(user), grant(anyone), update, revoke', async () => {
    const project = makeProject()
    await connect(project)
    seedFile('file-1')

    queueToken()
    expect(await project.permissions.list('file-1')).toEqual([])

    queueToken()
    const userPerm = await project.permissions.grant({
      fileId: 'file-1',
      type: 'user',
      role: 'writer',
      emailAddress: 'a@example.com',
    })
    expect(userPerm.type).toBe('user')

    queueToken()
    const anyonePerm = await project.permissions.grant({ fileId: 'file-1', type: 'anyone', role: 'reader' })
    expect(anyonePerm.type).toBe('anyone')

    queueToken()
    const afterGrants = await project.permissions.list('file-1')
    expect(afterGrants.map((p) => p.id).sort()).toEqual([userPerm.id, anyonePerm.id].sort())

    queueToken()
    const updated = await project.permissions.update({ fileId: 'file-1', permissionId: userPerm.id, role: 'reader' })
    expect(updated.role).toBe('reader')

    queueToken()
    await project.permissions.revoke({ fileId: 'file-1', permissionId: anyonePerm.id })

    queueToken()
    const finalList = await project.permissions.list('file-1')
    expect(finalList).toEqual([{ id: userPerm.id, type: 'user', role: 'reader', emailAddress: 'a@example.com' }])
  })
})
