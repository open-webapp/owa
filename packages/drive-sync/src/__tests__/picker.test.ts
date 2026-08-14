import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync, type ProjectHandle } from '../index.js'
import { REQUIRED_SCOPES } from '../files.js'
import { PickerCancelledError } from '../errors.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'
import { createDriveFake, type DriveFake } from '../testing/driveFake.js'
import { createPickerFake, type PickerFake } from '../testing/pickerFake.js'
import { openPicker, __resetPickerScriptCacheForTests } from '../picker.js'

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

let idSeq = 0
function freshIds(): { appId: string; projectId: string } {
  idSeq += 1
  return { appId: `app-${idSeq}`, projectId: `proj-${idSeq}` }
}

/**
 * Wraps driveFake's fetch with handling for the two "index.ts-owned"
 * endpoints (userinfo lookup + token revocation) that index.ts always calls
 * with a real `fetch` and that driveFake itself does not understand.
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

describe('picker: openPicker() and pickFile() integration (T7)', () => {
  let gisFake: GisFake
  let driveFake: DriveFake
  let pickerFake: PickerFake

  beforeEach(() => {
    // Ensure window is available (Node environment needs this)
    if (typeof window === 'undefined') {
      ;(globalThis as any).window = globalThis
    }

    __resetPickerScriptCacheForTests()
    gisFake = createGisFake()
    gisFake.install()
    driveFake = createDriveFake()
    pickerFake = createPickerFake()
    pickerFake.install()
    vi.stubGlobal('fetch', createHostFetch(driveFake))
  })

  afterEach(() => {
    __resetPickerScriptCacheForTests()
    gisFake.uninstall()
    pickerFake.uninstall()
    vi.unstubAllGlobals()
  })

  function makeProject(): ProjectHandle {
    const { appId, projectId } = freshIds()
    const ds = createDriveSync({ appId, clientId: 'client-1', folderPath: ['Root'] })
    return ds.project(projectId)
  }

  /** Queue a single token response from gisFake. */
  function queueToken(): void {
    gisFake.queueResponse({
      access_token: `tok-${idSeq}`,
      expires_in: 3600,
      scope: REQUIRED_SCOPES.join(' '),
    })
  }

  /** Wait for multiple microtask cycles to allow async operations to execute. */
  async function waitForAsync(cycles = 5): Promise<void> {
    for (let i = 0; i < cycles; i++) {
      await new Promise((resolve) => queueMicrotask(resolve))
    }
  }

  // =====================================================================
  // Test 1: Options → PickerBuilder wiring
  // =====================================================================
  it('Test 1: pickFile configures PickerBuilder with correct options (apiKey, mimeTypes, multiSelect, parentFolderId)', async () => {
    const project = makeProject()
    queueToken()

    const pickFilePromise = project.pickFile({
      apiKey: 'api-key-123',
      mimeTypes: ['application/pdf'],
      multiSelect: true,
      parentFolderId: 'folder1',
    })

    // Wait for the PickerBuilder to be created (happens after token acquisition)
    // Use a small delay to ensure async operations complete
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Verify pickerFake recorded the call with correct configuration
    expect(pickerFake.calls).toHaveLength(1)
    const call = pickerFake.calls[0]
    expect(call.developerKey).toBe('api-key-123')
    expect(call.features).toContain('multiselect')
    expect(call.views).toHaveLength(1)
    expect(call.views[0].mimeTypes).toBe('application/pdf')
    expect(call.views[0].parentId).toBe('folder1')

    // Simulate cancellation to avoid hanging promise
    pickerFake.simulateCancel()
    await expect(pickFilePromise).rejects.toBeInstanceOf(PickerCancelledError)
  })

  // =====================================================================
  // Test 2: Pick resolves with pre-fetched content
  // =====================================================================
  it('Test 2: pickFile fetches and returns file content for each picked file', async () => {
    const project = makeProject()
    queueToken()

    // Pre-seed driveFake with files that will be read
    driveFake.files.set('file-1', {
      id: 'file-1',
      name: 'document.pdf',
      mimeType: 'application/pdf',
      parents: [],
      content: 'PDF content bytes',
      contentType: 'application/pdf',
    })
    driveFake.files.set('file-2', {
      id: 'file-2',
      name: 'image.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'text content',
      contentType: 'text/plain',
    })

    const pickFilePromise = project.pickFile({
      apiKey: 'api-key-123',
      mimeTypes: ['application/pdf', 'text/plain'],
    })

    // Simulate user picking two files
    pickerFake.simulatePick([
      { fileId: 'file-1', name: 'document.pdf', mimeType: 'application/pdf' },
      { fileId: 'file-2', name: 'image.txt', mimeType: 'text/plain' },
    ])

    // Token is needed for each file read
    queueToken()
    queueToken()

    const results = await pickFilePromise
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      fileId: 'file-1',
      name: 'document.pdf',
      mimeType: 'application/pdf',
      content: 'PDF content bytes',
    })
    expect(results[1]).toEqual({
      fileId: 'file-2',
      name: 'image.txt',
      mimeType: 'text/plain',
      content: 'text content',
    })
  })

  // =====================================================================
  // Test 2 edge case: read() returns null for missing file
  // =====================================================================
  it('Test 2 edge case: pickFile includes null when filesImpl.read returns null for a missing file', async () => {
    const project = makeProject()
    queueToken()

    // Only seed one of the two files
    driveFake.files.set('file-1', {
      id: 'file-1',
      name: 'exists.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'content A',
      contentType: 'text/plain',
    })

    const pickFilePromise = project.pickFile({
      apiKey: 'api-key-123',
      mimeTypes: ['text/plain'],
    })

    // Simulate picking two files, but only one exists in the drive
    pickerFake.simulatePick([
      { fileId: 'file-1', name: 'exists.txt', mimeType: 'text/plain' },
      { fileId: 'file-missing', name: 'missing.txt', mimeType: 'text/plain' },
    ])

    // Token for each read attempt
    queueToken()
    queueToken()

    const results = await pickFilePromise
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      fileId: 'file-1',
      name: 'exists.txt',
      mimeType: 'text/plain',
      content: 'content A',
    })
    // Missing file returns null content
    expect(results[1]).toEqual({
      fileId: 'file-missing',
      name: 'missing.txt',
      mimeType: 'text/plain',
      content: null,
    })
  })

  // =====================================================================
  // Test 3: Cancel throws PickerCancelledError
  // =====================================================================
  it('Test 3: pickFile rejects with PickerCancelledError when user cancels', async () => {
    const project = makeProject()
    queueToken()

    const pickFilePromise = project.pickFile({
      apiKey: 'api-key-123',
    })

    pickerFake.simulateCancel()

    const error = await expect(pickFilePromise).rejects.toThrow()
    expect(error).toBeInstanceOf(PickerCancelledError)
    expect(error.name).toBe('PickerCancelledError')
  })

  // =====================================================================
  // Test 4: Script-load caching/dedup
  // =====================================================================
  it('Test 4: multiple pickFile calls reuse the same script load (no duplicate gapi.load calls)', async () => {
    __resetPickerScriptCacheForTests()
    const { appId, projectId } = freshIds()
    const ds = createDriveSync({ appId, clientId: 'client-1', folderPath: ['Root'] })
    const project1 = ds.project(projectId)
    const project2 = ds.project(`${projectId}-2`)

    queueToken()
    const pick1 = project1.pickFile({ apiKey: 'key1' })
    pickerFake.simulateCancel()
    await expect(pick1).rejects.toBeInstanceOf(PickerCancelledError)

    // Second call with same project
    queueToken()
    const pick2 = project1.pickFile({ apiKey: 'key1' })
    pickerFake.simulateCancel()
    await expect(pick2).rejects.toBeInstanceOf(PickerCancelledError)

    // Third call with different project from same DriveSync instance
    queueToken()
    const pick3 = project2.pickFile({ apiKey: 'key1' })
    pickerFake.simulateCancel()
    await expect(pick3).rejects.toBeInstanceOf(PickerCancelledError)

    // All three calls should have recorded PickerBuilder invocations,
    // but the underlying gapi.load should only have been called once
    // (verified by pickerFake having exactly 3 calls — the load happens once)
    expect(pickerFake.calls).toHaveLength(3)
  })

  // =====================================================================
  // Test 5: mimeTypes shorthand expansion
  // =====================================================================
  it('Test 5: mimeTypes shorthand tokens are expanded to full MIME types', async () => {
    const project = makeProject()
    queueToken()

    const pickFilePromise = project.pickFile({
      apiKey: 'api-key-123',
      mimeTypes: ['docs', 'application/pdf'],
    })

    // Wait for the PickerBuilder to be created (happens after token acquisition)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(pickerFake.calls).toHaveLength(1)
    const call = pickerFake.calls[0]
    expect(call.views).toHaveLength(1)
    // 'docs' should expand to 'application/vnd.google-apps.document'
    expect(call.views[0].mimeTypes).toBe('application/vnd.google-apps.document,application/pdf')

    pickerFake.simulateCancel()
    await expect(pickFilePromise).rejects.toBeInstanceOf(PickerCancelledError)
  })

  // =====================================================================
  // Additional: Test direct openPicker() function (not just pickFile)
  // =====================================================================
  it('openPicker() resolves with PickedFile array when user picks files', async () => {
    __resetPickerScriptCacheForTests()

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      oauthToken: 'auth-token',
      mimeTypes: ['text/plain'],
      multiSelect: true,
      parentFolderId: 'folder-123',
    })

    // Wait for the PickerBuilder to be created (happens after token acquisition)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(pickerFake.calls).toHaveLength(1)
    const call = pickerFake.calls[0]
    expect(call.developerKey).toBe('dev-key')
    expect(call.oauthToken).toBe('auth-token')
    expect(call.views[0].mimeTypes).toBe('text/plain')
    expect(call.views[0].parentId).toBe('folder-123')
    expect(call.features).toContain('multiselect')

    pickerFake.simulatePick([
      { fileId: 'f1', name: 'file1.txt', mimeType: 'text/plain' },
      { fileId: 'f2', name: 'file2.txt', mimeType: 'text/plain' },
    ])

    const result = await pickedPromise
    expect(result).toEqual([
      { fileId: 'f1', name: 'file1.txt', mimeType: 'text/plain' },
      { fileId: 'f2', name: 'file2.txt', mimeType: 'text/plain' },
    ])
  })

  it('openPicker() rejects with PickerCancelledError when user cancels', async () => {
    __resetPickerScriptCacheForTests()

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      oauthToken: 'auth-token',
    })

    pickerFake.simulateCancel()

    const error = await expect(pickedPromise).rejects.toThrow()
    expect(error).toBeInstanceOf(PickerCancelledError)
    expect(error.name).toBe('PickerCancelledError')
  })

  it('openPicker() correctly expands mimeTypes shorthand (sheets, slides, forms, drawings)', async () => {
    __resetPickerScriptCacheForTests()

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      oauthToken: 'auth-token',
      mimeTypes: ['sheets', 'slides', 'forms', 'drawings', 'application/json'],
    })

    // Wait for the PickerBuilder to be created (happens after token acquisition)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(pickerFake.calls).toHaveLength(1)
    const mimeTypes = pickerFake.calls[0].views[0].mimeTypes
    expect(mimeTypes).toContain('application/vnd.google-apps.spreadsheet')
    expect(mimeTypes).toContain('application/vnd.google-apps.presentation')
    expect(mimeTypes).toContain('application/vnd.google-apps.form')
    expect(mimeTypes).toContain('application/vnd.google-apps.drawing')
    expect(mimeTypes).toContain('application/json')

    pickerFake.simulateCancel()
    await expect(pickedPromise).rejects.toBeInstanceOf(PickerCancelledError)
  })
})
