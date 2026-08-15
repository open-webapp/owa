import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync, type ProjectHandle } from '../index.js'
import { REQUIRED_SCOPES } from '../files.js'
import { NeedsReauthError } from '../errors.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import { createDriveFake, type DriveFake } from '../testing/driveFake.js'

/**
 * Coverage in this file has two sources:
 *
 * 1. A port of the meaningful cases from the old app-level
 *    notesdiary/app/src/__tests__/driveApi.test.ts (uploadNamedFile,
 *    deleteFile, findOrCreateSubfolder describe blocks), rewritten against
 *    this library's public `p.files.*` / `p.ensureFolderPath()` API and its
 *    `driveFake` in-memory double instead of the old app's raw
 *    `vi.fn().mockResolvedValueOnce(...)` fetch mocks. Cases that only
 *    asserted the OLD implementation's raw request shape (exact fetch args,
 *    Authorization header string, hand-rolled query URL substrings) were
 *    dropped — that class of bug is already covered by this library's own
 *    regressions.test.ts (R9 for typed-error normalization, R11 for the
 *    multipart-boundary fix). The old `ensureJsonExtension` describe block
 *    was dropped entirely: it tested an app-specific filename convention
 *    that has no equivalent in this library's API surface.
 *
 * 2. New coverage for plan items #21, #22, #25, #26, #27 ("Drive ops
 *    (library)"), each labeled below with its plan number.
 */

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'

let idSeq = 0
function freshId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

/**
 * Wraps driveFake's fetch with handling for the two "index.ts-owned"
 * endpoints (userinfo lookup + token revocation) that index.ts always calls
 * with a real `fetch` and that driveFake itself does not understand — same
 * pattern as regressions.test.ts / broadcast.test.ts.
 */
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

describe('files (ported coverage + plan items #21, #22, #25, #26, #27)', () => {
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

  function makeProject(folderPath: string[] = ['Root']): ProjectHandle {
    const appId = freshId('app')
    const projectId = freshId('proj')
    const ds = createDriveSync({ appId, clientId: 'client-1', folderPath })
    return ds.project(projectId)
  }

  /** A single successful GIS response, good enough for one driveFetch call. */
  function queueToken(): void {
    gisFake.queueResponse({ access_token: freshId('tok'), expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
  }

  async function connect(project: ProjectHandle): Promise<void> {
    queueToken()
    await project.connect()
  }

  // ---------------------------------------------------------------------
  // Ported from driveApi.test.ts's `uploadNamedFile` describe block.
  // ---------------------------------------------------------------------

  it('write() creates a new file via multipart upload when no fileId is given, and the content round-trips (ported: "creates new file with multipart upload when no existingFileId")', async () => {
    const project = makeProject()
    await connect(project)

    // NOTE: mimeType is deliberately text/plain, not application/json — the
    // driveFake's multipart parser disambiguates the metadata part from the
    // media part by Content-Type, and the metadata part is always
    // application/json, so a media mimeType of application/json would
    // collide with that heuristic. text/plain (or any non-JSON type)
    // exercises the real create path without tripping over that fake-only
    // limitation.
    queueToken()
    const written = await project.files.write({ name: 'custom-rule.txt', content: 'hello world', mimeType: 'text/plain' })
    expect(written.id).toBeTruthy()

    queueToken()
    const readBack = await project.files.read(written.id)
    expect(readBack).toBe('hello world')
  })

  it('write() by name updates the file already in use instead of creating a new one on every sync', async () => {
    const project = makeProject()
    await connect(project)

    queueToken()
    const first = await project.files.write({ name: 'sync.txt', content: 'v1', mimeType: 'text/plain' })

    queueToken()
    const second = await project.files.write({ name: 'sync.txt', content: 'v2', mimeType: 'text/plain' })

    queueToken()
    const third = await project.files.write({ name: 'sync.txt', content: 'v3', mimeType: 'text/plain' })

    // Same Drive file throughout — no duplicates minted per sync.
    expect(second.id).toBe(first.id)
    expect(third.id).toBe(first.id)

    queueToken()
    const matches = await project.files.list({ nameEquals: 'sync.txt' })
    expect(matches).toHaveLength(1)

    queueToken()
    expect(await project.files.read(first.id)).toBe('v3')
  })

  it('write() updates an existing file via media upload when fileId is given, and the content round-trips (ported: "updates existing file with PATCH when existingFileId provided")', async () => {
    const project = makeProject()
    await connect(project)
    driveFake.files.set('existing-file-456', {
      id: 'existing-file-456',
      name: 'custom-rule.json',
      mimeType: 'application/json',
      parents: [],
      content: 'old content',
      contentType: 'application/json',
    })

    queueToken()
    const written = await project.files.write({ fileId: 'existing-file-456', content: 'new content', mimeType: 'application/json' })
    expect(written.id).toBe('existing-file-456')

    queueToken()
    const readBack = await project.files.read('existing-file-456')
    expect(readBack).toBe('new content')
  })

  // ---------------------------------------------------------------------
  // Ported from driveApi.test.ts's `deleteFile` describe block.
  // ---------------------------------------------------------------------

  it('remove() deletes the file; a subsequent read() then reports null, not an error (ported: "calls DELETE endpoint" / "resolves without return value on success")', async () => {
    const project = makeProject()
    await connect(project)
    driveFake.files.set('file-to-delete', {
      id: 'file-to-delete',
      name: 'f.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'content',
      contentType: 'text/plain',
    })

    queueToken()
    await expect(project.files.remove('file-to-delete')).resolves.toBeUndefined()
    expect(driveFake.files.has('file-to-delete')).toBe(false)

    queueToken()
    const readBack = await project.files.read('file-to-delete')
    expect(readBack).toBeNull()
  })

  // ---------------------------------------------------------------------
  // Ported from driveApi.test.ts's `findOrCreateSubfolder` describe block
  // (folded into #21/#27 below, plus the quote-escaping case kept separate).
  // ---------------------------------------------------------------------

  it("ensureFolderPath escapes a single quote in a folder name end-to-end (ported: \"escapes single quotes in folder name\")", async () => {
    const project = makeProject(["My' Folder"])
    await connect(project)

    queueToken()
    const leafId = await project.ensureFolderPath()

    const folder = driveFake.files.get(leafId)
    expect(folder?.name).toBe("My' Folder")
    expect(folder?.mimeType).toBe(FOLDER_MIME_TYPE)
  })

  // ---------------------------------------------------------------------
  // Plan #21 — ensureFolderPath(['OpenWebApp', 'Planning']): finds existing
  // at both levels; creates only the missing level; nests correctly.
  // ---------------------------------------------------------------------

  it('#21a — ensureFolderPath finds an existing folder at every level and creates nothing', async () => {
    const project = makeProject(['OpenWebApp', 'Planning'])
    await connect(project)

    const rootId = 'folder-root'
    const childId = 'folder-child'
    driveFake.files.set(rootId, { id: rootId, name: 'OpenWebApp', mimeType: FOLDER_MIME_TYPE, parents: [], content: '' })
    driveFake.files.set(childId, { id: childId, name: 'Planning', mimeType: FOLDER_MIME_TYPE, parents: [rootId], content: '' })

    queueToken()
    const leafId = await project.ensureFolderPath()

    expect(leafId).toBe(childId)
    // Nothing new was created — the fake still only has the two pre-seeded folders.
    expect(driveFake.files.size).toBe(2)
  })

  it('#21b — ensureFolderPath creates only the missing level and nests it correctly under the existing parent', async () => {
    const project = makeProject(['OpenWebApp', 'Planning'])
    await connect(project)

    const rootId = 'folder-root'
    driveFake.files.set(rootId, { id: rootId, name: 'OpenWebApp', mimeType: FOLDER_MIME_TYPE, parents: [], content: '' })

    queueToken()
    const leafId = await project.ensureFolderPath()

    expect(leafId).not.toBe(rootId)
    const leaf = driveFake.files.get(leafId)
    expect(leaf?.name).toBe('Planning')
    expect(leaf?.mimeType).toBe(FOLDER_MIME_TYPE)
    // Nested directly under the existing (not recreated) OpenWebApp folder.
    expect(leaf?.parents).toEqual([rootId])
    expect([...driveFake.files.values()].filter((f) => f.name === 'OpenWebApp')).toHaveLength(1)
  })

  it('#21c — a second ensureFolderPath call is idempotent: no duplicate folders are created', async () => {
    const project = makeProject(['OpenWebApp', 'Planning'])
    await connect(project)

    queueToken()
    const firstId = await project.ensureFolderPath()

    queueToken()
    const secondId = await project.ensureFolderPath()

    expect(secondId).toBe(firstId)
    expect([...driveFake.files.values()].filter((f) => f.mimeType === FOLDER_MIME_TYPE)).toHaveLength(2)
  })

  // ---------------------------------------------------------------------
  // Plan #27 — driveFake records the exact folder-name sequence handed to
  // ensureFolderPath, in order.
  // ---------------------------------------------------------------------

  it("#27 — driveFake.folderCreationLog records the exact folder-name sequence handed to ensureFolderPath", async () => {
    const project = makeProject(['OpenWebApp', 'Planning'])
    await connect(project)

    const rootId = 'folder-root'
    const childId = 'folder-child'
    driveFake.files.set(rootId, { id: rootId, name: 'OpenWebApp', mimeType: FOLDER_MIME_TYPE, parents: [], content: '' })
    driveFake.files.set(childId, { id: childId, name: 'Planning', mimeType: FOLDER_MIME_TYPE, parents: [rootId], content: '' })

    queueToken()
    await project.ensureFolderPath()

    expect(driveFake.folderCreationLog).toEqual(['OpenWebApp', 'Planning'])
  })

  // ---------------------------------------------------------------------
  // Plan #22 — write() with a Blob and with a string, each with an explicit
  // mimeType; create vs. update paths both round-trip.
  // ---------------------------------------------------------------------

  it('#22a — write() with a string and explicit mimeType round-trips on the create path', async () => {
    const project = makeProject()
    await connect(project)

    queueToken()
    const written = await project.files.write({ name: 'note.txt', content: 'plain text content', mimeType: 'text/plain' })
    expect(written.id).toBeTruthy()

    queueToken()
    const readBack = await project.files.read(written.id)
    expect(readBack).toBe('plain text content')
  })

  it('#22b — write() with a Blob and explicit mimeType round-trips on the create path', async () => {
    const project = makeProject()
    await connect(project)

    const blob = new Blob(['blob content bytes'], { type: 'application/octet-stream' })
    queueToken()
    const written = await project.files.write({ name: 'blob.bin', content: blob, mimeType: 'application/octet-stream' })
    expect(written.id).toBeTruthy()

    queueToken()
    const readBack = await project.files.read(written.id)
    expect(readBack).toBeInstanceOf(Blob)
    expect(await (readBack as Blob).text()).toBe('blob content bytes')
  })

  it('#22c — write() with a string and explicit mimeType round-trips on the update path', async () => {
    const project = makeProject()
    await connect(project)
    driveFake.files.set('file-1', {
      id: 'file-1',
      name: 'note.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'old content',
      contentType: 'text/plain',
    })

    queueToken()
    const written = await project.files.write({ fileId: 'file-1', content: 'new text content', mimeType: 'text/plain' })
    expect(written.id).toBe('file-1')

    queueToken()
    const readBack = await project.files.read('file-1')
    expect(readBack).toBe('new text content')
  })

  it('#22d — write() with a Blob and explicit mimeType round-trips on the update path', async () => {
    const project = makeProject()
    await connect(project)
    driveFake.files.set('file-2', {
      id: 'file-2',
      name: 'blob.bin',
      mimeType: 'application/octet-stream',
      parents: [],
      content: 'old bytes',
      contentType: 'application/octet-stream',
    })

    const blob = new Blob(['new blob bytes'], { type: 'application/octet-stream' })
    queueToken()
    const written = await project.files.write({ fileId: 'file-2', content: blob, mimeType: 'application/octet-stream' })
    expect(written.id).toBe('file-2')

    queueToken()
    const readBack = await project.files.read('file-2')
    expect(readBack).toBeInstanceOf(Blob)
    expect(await (readBack as Blob).text()).toBe('new blob bytes')
  })

  // ---------------------------------------------------------------------
  // Plan #25 — a non-interactive Drive call with no usable token and no
  // possible silent refresh throws NeedsReauthError; the same call with
  // interactive: true prompts (and, here, succeeds).
  // ---------------------------------------------------------------------

  it('#25 — non-interactive call with no refresh possible throws NeedsReauthError; interactive: true prompts and succeeds', async () => {
    driveFake.files.set('file-1', {
      id: 'file-1',
      name: 'f.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'hello',
      contentType: 'text/plain',
    })
    const project = makeProject()
    // No connect() — there is no stored connection/token, so the
    // non-interactive silent GIS attempt below (prompt: 'none') has no hint
    // and GIS reports an error, simulating "no refresh possible".
    gisFake.queueResponse({ error: 'access_denied' })

    await expect(project.files.read('file-1')).rejects.toBeInstanceOf(NeedsReauthError)

    // The identical call, made interactive, drives a user-facing prompt
    // (prompt: 'consent') via gisFake and succeeds.
    queueToken()
    const result = await project.files.read('file-1', { interactive: true })
    expect(result).toBe('hello')

    const lastCall = gisFake.calls[gisFake.calls.length - 1]
    expect(lastCall.prompt).toBe('consent')
  })

  // ---------------------------------------------------------------------
  // Plan #26 — read() returns null on 404 (not an error).
  // ---------------------------------------------------------------------

  it('#26 — read() returns null on a 404 rather than throwing', async () => {
    const project = makeProject()
    await connect(project)

    queueToken()
    const result = await project.files.read('does-not-exist')
    expect(result).toBeNull()
  })

  // ---------------------------------------------------------------------
  // list(): general filtering coverage (folderId / mimeType), exercised
  // through the public API + fake rather than asserting raw query strings
  // (that shape is an implementation detail already covered by
  // query.test.ts's escapeQ unit tests).
  // ---------------------------------------------------------------------

  it('list() filters by folderId and mimeType', async () => {
    const project = makeProject()
    await connect(project)

    const folderId = 'folder-1'
    driveFake.files.set(folderId, { id: folderId, name: 'Sub', mimeType: FOLDER_MIME_TYPE, parents: [], content: '' })
    driveFake.files.set('file-a', { id: 'file-a', name: 'a.txt', mimeType: 'text/plain', parents: [folderId], content: 'A' })
    driveFake.files.set('file-b', { id: 'file-b', name: 'b.txt', mimeType: 'text/plain', parents: [], content: 'B' })

    queueToken()
    const results = await project.files.list({ folderId, mimeType: 'text/plain' })
    expect(results.map((f) => f.id)).toEqual(['file-a'])
  })
})
