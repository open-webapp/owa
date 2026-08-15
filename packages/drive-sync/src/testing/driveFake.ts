/**
 * An in-memory fake of the subset of the Google Drive v3 REST API that this
 * library needs: files (list/get/create/update/delete, including multipart
 * and media-upload variants) and permissions (list/create/update/delete).
 *
 * Intended use:
 *
 * ```ts
 * const driveFake = createDriveFake()
 * vi.stubGlobal('fetch', driveFake.fetch)
 * // ... exercise code under test ...
 * expect(driveFake.folderCreationLog).toEqual(['OpenWebApp', 'Planning'])
 * ```
 */

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'

export interface DriveFakeFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  content: string
  contentType?: string
  trashed?: boolean
  /**
   * Drive's monotonic per-file change counter, bumped on every mutation.
   * Optional so tests may seed files without it; treated as 1 when absent.
   */
  version?: number
}

export interface DriveFakePermission {
  id: string
  type: string
  role: string
  emailAddress?: string
  [key: string]: unknown
}

export interface StatusOverrideOptions {
  retryAfter?: number
  body?: string
  /** How many matching requests this override applies to. Defaults to 1. */
  times?: number
}

export interface DriveFake {
  fetch: typeof fetch
  /** Every folder name involved in a folder lookup query or a folder create, in call order. */
  folderCreationLog: string[]
  /** Force a specific response for the next N (default 1) requests whose URL matches `pattern`. */
  setStatusOverride(pattern: string | RegExp, status: number, opts?: StatusOverrideOptions): void
  /** Clear all in-memory state (files, permissions, overrides, logs). */
  reset(): void
  /** Inspect current in-memory files, keyed by id. */
  readonly files: Map<string, DriveFakeFile>
  /**
   * Simulate another client editing the file: replaces content and bumps
   * `version`, exactly as a real out-of-band Drive write would.
   */
  externalEdit(fileId: string, content: string): void
  /** Inspect current in-memory permissions, keyed by fileId then permission id. */
  readonly permissions: Map<string, Map<string, DriveFakePermission>>
}

interface StatusOverride {
  pattern: string | RegExp
  status: number
  retryAfter?: number
  body?: string
  remaining: number
}

function matchesPattern(pattern: string | RegExp, url: string): boolean {
  return typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
  })
}

function errorResponse(status: number, message: string, retryAfter?: number, bodyOverride?: string): Response {
  const headers: Record<string, string> = {}
  if (retryAfter !== undefined) headers['Retry-After'] = String(retryAfter)
  const body =
    bodyOverride ??
    JSON.stringify({
      error: {
        code: status,
        message,
        errors: [{ reason: statusToReason(status), message }],
      },
    })
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function statusToReason(status: number): string {
  switch (status) {
    case 401:
      return 'authError'
    case 403:
      return 'forbidden'
    case 404:
      return 'notFound'
    case 429:
      return 'rateLimitExceeded'
    default:
      return status >= 500 ? 'internalError' : 'invalid'
  }
}

let idSeq = 0
function nextId(): string {
  idSeq += 1
  return `fake-id-${idSeq}`
}

/** Extract a quoted-string argument from a Drive `q=` query, e.g. name='X' -> X. */
function extractQuotedField(q: string, field: string): string | undefined {
  const re = new RegExp(`${field}\\s*=\\s*'((?:[^'\\\\]|\\\\.)*)'`)
  const m = re.exec(q)
  return m ? m[1].replace(/\\'/g, "'") : undefined
}

/** Extract the parent id from a `'parentId' in parents` clause. */
function extractParentInParents(q: string): string | undefined {
  const m = /'((?:[^'\\]|\\.)*)'\s+in\s+parents/.exec(q)
  return m ? m[1].replace(/\\'/g, "'") : undefined
}

function parseMultipartBody(body: string, boundary: string): { metadata: any; mediaContent: string; mediaType?: string } {
  const parts = body.split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== '--')
  let metadata: any = {}
  let mediaContent = ''
  let mediaType: string | undefined

  for (const rawPart of parts) {
    const part = rawPart.replace(/^\r\n/, '').replace(/\r\n--$/, '')
    const headerEnd = part.indexOf('\r\n\r\n')
    const headerBlock = headerEnd >= 0 ? part.slice(0, headerEnd) : ''
    const content = headerEnd >= 0 ? part.slice(headerEnd + 4) : part
    const contentTypeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerBlock)
    const contentType = contentTypeMatch?.[1]?.trim()
    const trimmedContent = content.replace(/\r\n$/, '')

    if (contentType?.includes('application/json')) {
      try {
        metadata = JSON.parse(trimmedContent)
      } catch {
        metadata = {}
      }
    } else {
      mediaContent = trimmedContent
      mediaType = contentType
    }
  }

  return { metadata, mediaContent, mediaType }
}

async function readBodyText(init: RequestInit | undefined): Promise<string> {
  const body = init?.body
  if (body === undefined || body === null) return ''
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return new TextDecoder().decode(body)
  if (typeof (body as any).text === 'function') return await (body as any).text()
  return String(body)
}

function getHeader(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  if (Array.isArray(headers)) {
    const found = headers.find(([k]) => k.toLowerCase() === name.toLowerCase())
    return found?.[1]
  }
  const rec = headers as Record<string, string>
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? rec[key] : undefined
}

export function createDriveFake(): DriveFake {
  const files = new Map<string, DriveFakeFile>()
  const permissions = new Map<string, Map<string, DriveFakePermission>>()
  const folderCreationLog: string[] = []
  const statusOverrides: StatusOverride[] = []

  function takeOverride(url: string): StatusOverride | undefined {
    const idx = statusOverrides.findIndex((o) => o.remaining > 0 && matchesPattern(o.pattern, url))
    if (idx === -1) return undefined
    const override = statusOverrides[idx]
    override.remaining -= 1
    if (override.remaining <= 0) {
      statusOverrides.splice(idx, 1)
    }
    return override
  }

  function fileToMetadata(f: DriveFakeFile): Record<string, unknown> {
    return { id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, version: String(f.version ?? 1) }
  }

  async function handleFilesList(url: URL): Promise<Response> {
    const q = url.searchParams.get('q') ?? ''
    const name = extractQuotedField(q, 'name')
    const mimeType = extractQuotedField(q, 'mimeType')
    const parentId = extractParentInParents(q)
    const trashedMatch = /trashed\s*=\s*(true|false)/.exec(q)
    const wantTrashed = trashedMatch ? trashedMatch[1] === 'true' : undefined

    if (mimeType === FOLDER_MIME_TYPE && name !== undefined) {
      folderCreationLog.push(name)
    }

    const results = [...files.values()].filter((f) => {
      if (name !== undefined && f.name !== name) return false
      if (mimeType !== undefined && f.mimeType !== mimeType) return false
      if (parentId !== undefined && !f.parents.includes(parentId)) return false
      if (wantTrashed !== undefined && Boolean(f.trashed) !== wantTrashed) return false
      return true
    })

    return jsonResponse({ files: results.map(fileToMetadata) })
  }

  async function handleFileGet(url: URL, id: string): Promise<Response> {
    const file = files.get(id)
    if (!file || file.trashed) {
      return errorResponse(404, `File not found: ${id}.`)
    }
    if (url.searchParams.get('alt') === 'media') {
      return new Response(file.content, {
        status: 200,
        headers: { 'Content-Type': file.contentType ?? 'application/octet-stream' },
      })
    }
    return jsonResponse(fileToMetadata(file))
  }

  async function handleFilesCreate(url: URL, init: RequestInit | undefined): Promise<Response> {
    const uploadType = url.searchParams.get('uploadType')
    const contentType = getHeader(init, 'Content-Type') ?? ''
    const bodyText = await readBodyText(init)

    let metadata: any = {}
    let content = ''
    let mediaType: string | undefined

    if (uploadType === 'multipart' || contentType.includes('multipart/related')) {
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType)
      const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
      if (boundary) {
        const parsed = parseMultipartBody(bodyText, boundary)
        metadata = parsed.metadata
        content = parsed.mediaContent
        mediaType = parsed.mediaType
      }
    } else if (uploadType === 'media') {
      content = bodyText
      mediaType = contentType || undefined
    } else {
      try {
        metadata = bodyText ? JSON.parse(bodyText) : {}
      } catch {
        metadata = {}
      }
    }

    const id = nextId()
    const mimeType = metadata.mimeType ?? mediaType ?? 'application/octet-stream'
    const file: DriveFakeFile = {
      id,
      name: metadata.name ?? '',
      mimeType,
      parents: Array.isArray(metadata.parents) ? metadata.parents : [],
      content,
      contentType: mediaType,
      version: 1,
    }
    files.set(id, file)

    if (mimeType === FOLDER_MIME_TYPE) {
      folderCreationLog.push(file.name)
    }

    return jsonResponse(fileToMetadata(file), 200)
  }

  async function handleFileUpdate(url: URL, id: string, init: RequestInit | undefined): Promise<Response> {
    const file = files.get(id)
    if (!file) {
      return errorResponse(404, `File not found: ${id}.`)
    }
    const uploadType = url.searchParams.get('uploadType')
    const bodyText = await readBodyText(init)

    if (uploadType === 'media') {
      file.content = bodyText
      const contentType = getHeader(init, 'Content-Type')
      if (contentType) file.contentType = contentType
      file.version = (file.version ?? 1) + 1
      return jsonResponse(fileToMetadata(file))
    }

    if (uploadType === 'multipart') {
      const contentType = getHeader(init, 'Content-Type') ?? ''
      const boundaryMatch = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType)
      const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
      if (boundary) {
        const parsed = parseMultipartBody(bodyText, boundary)
        if (parsed.metadata.name !== undefined) file.name = parsed.metadata.name
        if (parsed.metadata.mimeType !== undefined) file.mimeType = parsed.metadata.mimeType
        if (Array.isArray(parsed.metadata.parents)) file.parents = parsed.metadata.parents
        file.content = parsed.mediaContent
        if (parsed.mediaType) file.contentType = parsed.mediaType
        file.version = (file.version ?? 1) + 1
      }
      return jsonResponse(fileToMetadata(file))
    }

    // Plain metadata PATCH (JSON body).
    try {
      const metadata = bodyText ? JSON.parse(bodyText) : {}
      if (metadata.name !== undefined) file.name = metadata.name
      if (metadata.mimeType !== undefined) file.mimeType = metadata.mimeType
      if (Array.isArray(metadata.parents)) file.parents = metadata.parents
      if (metadata.trashed !== undefined) file.trashed = metadata.trashed
    } catch {
      // ignore malformed body
    }
    // Support addParents / removeParents query params used by the real API.
    const addParents = url.searchParams.get('addParents')
    const removeParents = url.searchParams.get('removeParents')
    if (addParents) {
      for (const p of addParents.split(',')) {
        if (!file.parents.includes(p)) file.parents.push(p)
      }
    }
    if (removeParents) {
      const removeSet = new Set(removeParents.split(','))
      file.parents = file.parents.filter((p) => !removeSet.has(p))
    }
    file.version = (file.version ?? 1) + 1

    return jsonResponse(fileToMetadata(file))
  }

  async function handleFileDelete(id: string): Promise<Response> {
    if (!files.has(id)) {
      return errorResponse(404, `File not found: ${id}.`)
    }
    files.delete(id)
    permissions.delete(id)
    return new Response(null, { status: 204 })
  }

  async function handlePermissionsList(fileId: string): Promise<Response> {
    const perms = permissions.get(fileId)
    return jsonResponse({ permissions: perms ? [...perms.values()] : [] })
  }

  async function handlePermissionsCreate(fileId: string, init: RequestInit | undefined): Promise<Response> {
    const bodyText = await readBodyText(init)
    let body: any = {}
    try {
      body = bodyText ? JSON.parse(bodyText) : {}
    } catch {
      body = {}
    }
    const id = nextId()
    const permission: DriveFakePermission = {
      id,
      type: body.type ?? 'user',
      role: body.role ?? 'reader',
      emailAddress: body.emailAddress,
    }
    if (!permissions.has(fileId)) permissions.set(fileId, new Map())
    permissions.get(fileId)!.set(id, permission)
    return jsonResponse(permission)
  }

  async function handlePermissionUpdate(fileId: string, permId: string, init: RequestInit | undefined): Promise<Response> {
    const perms = permissions.get(fileId)
    const permission = perms?.get(permId)
    if (!permission) {
      return errorResponse(404, `Permission not found: ${permId}.`)
    }
    const bodyText = await readBodyText(init)
    try {
      const body = bodyText ? JSON.parse(bodyText) : {}
      if (body.role !== undefined) permission.role = body.role
    } catch {
      // ignore malformed body
    }
    return jsonResponse(permission)
  }

  async function handlePermissionDelete(fileId: string, permId: string): Promise<Response> {
    const perms = permissions.get(fileId)
    if (!perms?.has(permId)) {
      return errorResponse(404, `Permission not found: ${permId}.`)
    }
    perms.delete(permId)
    return new Response(null, { status: 204 })
  }

  const fakeFetch: typeof fetch = async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)

    if (!url.startsWith(DRIVE_BASE) && !url.startsWith(UPLOAD_BASE)) {
      throw new Error(`driveFake: unhandled URL (not a Drive API endpoint): ${url}`)
    }

    const override = takeOverride(url)
    if (override) {
      return errorResponse(override.status, 'Forced error (test override).', override.retryAfter, override.body)
    }

    const parsedUrl = new URL(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const base = url.startsWith(UPLOAD_BASE) ? UPLOAD_BASE : DRIVE_BASE
    const path = parsedUrl.pathname.slice(new URL(base).pathname.length).replace(/^\/+/, '')
    const segments = path.split('/').filter(Boolean)

    try {
      // files collection: files, files/{id}, files/{id}/permissions, files/{id}/permissions/{permId}
      if (segments[0] === 'files') {
        if (segments.length === 1) {
          if (method === 'GET') return await handleFilesList(parsedUrl)
          if (method === 'POST') return await handleFilesCreate(parsedUrl, init)
        } else if (segments.length === 2) {
          const id = segments[1]
          if (method === 'GET') return await handleFileGet(parsedUrl, id)
          if (method === 'PATCH' || method === 'PUT') return await handleFileUpdate(parsedUrl, id, init)
          if (method === 'DELETE') return await handleFileDelete(id)
        } else if (segments.length === 3 && segments[2] === 'permissions') {
          const id = segments[1]
          if (method === 'GET') return await handlePermissionsList(id)
          if (method === 'POST') return await handlePermissionsCreate(id, init)
        } else if (segments.length === 4 && segments[2] === 'permissions') {
          const id = segments[1]
          const permId = segments[3]
          if (method === 'PATCH' || method === 'PUT') return await handlePermissionUpdate(id, permId, init)
          if (method === 'DELETE') return await handlePermissionDelete(id, permId)
        }
      }
    } catch (err) {
      return errorResponse(500, err instanceof Error ? err.message : String(err))
    }

    return errorResponse(404, `driveFake: unhandled request ${method} ${url}`)
  }

  return {
    fetch: fakeFetch,
    folderCreationLog,
    setStatusOverride(pattern: string | RegExp, status: number, opts?: StatusOverrideOptions) {
      statusOverrides.push({
        pattern,
        status,
        retryAfter: opts?.retryAfter,
        body: opts?.body,
        remaining: opts?.times ?? 1,
      })
    },
    externalEdit(fileId: string, content: string) {
      const file = files.get(fileId)
      if (!file) throw new Error(`driveFake.externalEdit: unknown file ${fileId}`)
      file.content = content
      file.version = (file.version ?? 1) + 1
    },
    reset() {
      files.clear()
      permissions.clear()
      folderCreationLog.length = 0
      statusOverrides.length = 0
    },
    files,
    permissions,
  }
}
