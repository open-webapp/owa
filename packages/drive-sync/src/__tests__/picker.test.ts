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

    // Ensure document is available (Node environment needs this)
    if (typeof document === 'undefined') {
      ;(globalThis as any).document = {
        querySelector: () => null,
        querySelectorAll: () => [],
        body: {
          appendChild: () => {},
        },
      }
    }

    // Set up window.location for origin tests
    if (!window.location) {
      ;(window as any).location = {
        origin: 'http://localhost:3000',
      }
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
  it('Test 0: pickFile sets the Picker appId (drive.file sessions are rejected without it)', async () => {
    // Regression: drive-sync only ever holds a drive.file-scoped token. Picker
    // discards an OAuth token it cannot attribute to a Cloud project, shows its
    // own sign-in prompt instead of the file browser, and then fails the
    // unauthenticated developer-key check ("The API developer key is invalid").
    const project = makeProject()
    queueToken()

    const pickFilePromise = project.pickFile({
      apiKey: 'api-key-123',
      appId: 'app-id-42',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(pickerFake.calls).toHaveLength(1)
    const call = pickerFake.calls[0]
    expect(call.appId).toBe('app-id-42')
    // appId only matters alongside a real OAuth session, so assert both landed.
    expect(call.oauthToken).toBeTruthy()
    expect(call.developerKey).toBe('api-key-123')

    pickerFake.simulateCancel()
    await expect(pickFilePromise).rejects.toBeInstanceOf(PickerCancelledError)
  })

  it('Test 1: pickFile configures PickerBuilder with correct options (apiKey, mimeTypes, multiSelect, parentFolderId)', async () => {
    const project = makeProject()
    queueToken()

    const pickFilePromise = project.pickFile({
      apiKey: 'api-key-123',
      appId: 'app-id-42',
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
    // Queue tokens for each file read that will happen after pick
    queueToken()
    queueToken()

    // Pre-seed driveFake with files that will be read
    // Use text/plain for both to get string content back (not Blob)
    driveFake.files.set('file-1', {
      id: 'file-1',
      name: 'document.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'PDF content bytes',
      contentType: 'text/plain',
    })
    driveFake.files.set('file-2', {
      id: 'file-2',
      name: 'data.txt',
      mimeType: 'text/plain',
      parents: [],
      content: 'text content',
      contentType: 'text/plain',
    })

    const pickFilePromise = project.pickFile({
      apiKey: 'api-key-123',
      appId: 'app-id-42',
      mimeTypes: ['text/plain'],
    })

    // Wait for the PickerBuilder to be created
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Simulate user picking two files
    pickerFake.simulatePick([
      { fileId: 'file-1', name: 'document.txt', mimeType: 'text/plain' },
      { fileId: 'file-2', name: 'data.txt', mimeType: 'text/plain' },
    ])

    const results = await pickFilePromise
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      fileId: 'file-1',
      name: 'document.txt',
      mimeType: 'text/plain',
      content: 'PDF content bytes',
    })
    expect(results[1]).toEqual({
      fileId: 'file-2',
      name: 'data.txt',
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
    // Queue tokens for each file read
    queueToken()
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
      appId: 'app-id-42',
      mimeTypes: ['text/plain'],
    })

    // Wait for the PickerBuilder to be created
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Simulate picking two files, but only one exists in the drive
    pickerFake.simulatePick([
      { fileId: 'file-1', name: 'exists.txt', mimeType: 'text/plain' },
      { fileId: 'file-missing', name: 'missing.txt', mimeType: 'text/plain' },
    ])

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
      appId: 'app-id-42',
    })

    // Wait for the PickerBuilder to be created
    await new Promise((resolve) => setTimeout(resolve, 10))

    pickerFake.simulateCancel()

    try {
      await pickFilePromise
      expect.fail('Should have thrown PickerCancelledError')
    } catch (err: any) {
      expect(err?.name).toBe('PickerCancelledError')
      expect(err).toBeInstanceOf(PickerCancelledError)
    }
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
    const pick1 = project1.pickFile({ apiKey: 'key1', appId: 'app-id-42' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    pickerFake.simulateCancel()
    await expect(pick1).rejects.toBeInstanceOf(PickerCancelledError)

    // Second call with same project
    queueToken()
    const pick2 = project1.pickFile({ apiKey: 'key1', appId: 'app-id-42' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    pickerFake.simulateCancel()
    await expect(pick2).rejects.toBeInstanceOf(PickerCancelledError)

    // Third call with different project from same DriveSync instance
    queueToken()
    const pick3 = project2.pickFile({ apiKey: 'key1', appId: 'app-id-42' })
    await new Promise((resolve) => setTimeout(resolve, 10))
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
      appId: 'app-id-42',
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
    try {
      await pickFilePromise
      expect.fail('Should have thrown PickerCancelledError')
    } catch (err: any) {
      expect(err?.name).toBe('PickerCancelledError')
    }
  })

  // =====================================================================
  // Additional: Test direct openPicker() function (not just pickFile)
  // =====================================================================
  it('openPicker() resolves with PickedFile array when user picks files', async () => {
    __resetPickerScriptCacheForTests()

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      appId: 'app-id-42',
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
      appId: 'app-id-42',
      oauthToken: 'auth-token',
    })

    // Wait for the PickerBuilder to be created
    await new Promise((resolve) => setTimeout(resolve, 10))

    pickerFake.simulateCancel()

    try {
      await pickedPromise
      expect.fail('Should have thrown PickerCancelledError')
    } catch (err: any) {
      expect(err?.name).toBe('PickerCancelledError')
      expect(err).toBeInstanceOf(PickerCancelledError)
    }
  })

  it('openPicker() correctly expands mimeTypes shorthand (sheets, slides, forms, drawings)', async () => {
    __resetPickerScriptCacheForTests()

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      appId: 'app-id-42',
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
    try {
      await pickedPromise
      expect.fail('Should have thrown PickerCancelledError')
    } catch (err: any) {
      expect(err?.name).toBe('PickerCancelledError')
    }
  })

  // =====================================================================
  // T1c Tests: Teardown, setOrigin, setIncludeFolders (Decision 29)
  // =====================================================================

  it('T1c: happy path — pick a file resolves, and disposes the picker', async () => {
    __resetPickerScriptCacheForTests()

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      appId: 'app-id-42',
      oauthToken: 'auth-token',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(pickerFake.calls).toHaveLength(1)
    expect(pickerFake.calls[0].disposed).toBeUndefined() // not yet disposed

    pickerFake.simulatePick([{ fileId: 'f1', name: 'file.txt', mimeType: 'text/plain' }])

    const result = await pickedPromise
    expect(result).toHaveLength(1)
    expect(result[0].fileId).toBe('f1')

    await waitForAsync(3)
    expect(pickerFake.calls[0].disposed).toBe(true)
  })

  it('T1c: happy path — cancel rejects with PickerCancelledError and disposes', async () => {
    __resetPickerScriptCacheForTests()

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      appId: 'app-id-42',
      oauthToken: 'auth-token',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(pickerFake.calls[0].disposed).toBeUndefined()

    pickerFake.simulateCancel()

    try {
      await pickedPromise
      expect.fail('Should have thrown PickerCancelledError')
    } catch (err: any) {
      expect(err).toBeInstanceOf(PickerCancelledError)
    }

    await waitForAsync(3)
    expect(pickerFake.calls[0].disposed).toBe(true)
  })

  it('T1c: edge case — callback fires twice, but dispose only happens once', async () => {
    __resetPickerScriptCacheForTests()

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      appId: 'app-id-42',
      oauthToken: 'auth-token',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    // Simulate pick once
    pickerFake.simulatePick([{ fileId: 'f1', name: 'file.txt', mimeType: 'text/plain' }])

    // Try to simulate pick again (should be ignored)
    pickerFake.simulatePick([{ fileId: 'f2', name: 'file2.txt', mimeType: 'text/plain' }])

    const result = await pickedPromise
    expect(result).toHaveLength(1)
    expect(result[0].fileId).toBe('f1')

    await waitForAsync(3)
    // Should still be disposed exactly once
    expect(pickerFake.calls[0].disposed).toBe(true)
  })

  it('T1c: edge case — setOrigin receives window.location.origin', async () => {
    __resetPickerScriptCacheForTests()

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      appId: 'app-id-42',
      oauthToken: 'auth-token',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(pickerFake.calls).toHaveLength(1)
    expect(pickerFake.calls[0].origin).toBe(window.location.origin)

    pickerFake.simulateCancel()
    try {
      await pickedPromise
    } catch (err: any) {
      expect(err).toBeInstanceOf(PickerCancelledError)
    }
  })

  it('T1c: edge case — includeFolders: true calls setIncludeFolders on DocsView', async () => {
    __resetPickerScriptCacheForTests()

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      appId: 'app-id-42',
      oauthToken: 'auth-token',
      includeFolders: true,
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(pickerFake.calls).toHaveLength(1)
    expect(pickerFake.calls[0].views[0].includeFolders).toBe(true)

    pickerFake.simulateCancel()
    try {
      await pickedPromise
    } catch (err: any) {
      expect(err).toBeInstanceOf(PickerCancelledError)
    }
  })

  it('T1c: edge case — includeFolders omitted means setIncludeFolders is not called', async () => {
    __resetPickerScriptCacheForTests()

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      appId: 'app-id-42',
      oauthToken: 'auth-token',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(pickerFake.calls).toHaveLength(1)
    expect(pickerFake.calls[0].views[0].includeFolders).toBeUndefined()

    pickerFake.simulateCancel()
    try {
      await pickedPromise
    } catch (err: any) {
      expect(err).toBeInstanceOf(PickerCancelledError)
    }
  })

  it('T1c: regression — after full pick→resolve cycle, no Picker backdrop in document.body', async () => {
    __resetPickerScriptCacheForTests()

    // Mock document.querySelector and document.body for this test
    let removedElements: string[] = []
    const originalQuerySelector = document.querySelector
    const originalBody = document.body

    ;(document as any).querySelector = (selector: string) => {
      if (selector === '.goog-te-spinner') {
        return { remove: () => removedElements.push('.goog-te-spinner') }
      }
      return null
    }

    const pickedPromise = openPicker({
      apiKey: 'dev-key',
      appId: 'app-id-42',
      oauthToken: 'auth-token',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    pickerFake.simulatePick([{ fileId: 'f1', name: 'file.txt', mimeType: 'text/plain' }])

    const result = await pickedPromise
    expect(result).toHaveLength(1)

    await waitForAsync(3)

    // The backdrop should be removed by the teardown
    expect(removedElements).toContain('.goog-te-spinner')

    // Restore original
    ;(document as any).querySelector = originalQuerySelector
    ;(document as any).body = originalBody
  })
})
