/**
 * An in-memory fake of the server-mediated token-exchange endpoint that
 * drive-sync talks to when `DriveSyncOptions.tokenExchangeUrl` is set.
 *
 * The real server accepts `POST {tokenExchangeUrl}` with a body that is
 * EXACTLY one of `{ code }` (new grant) or `{ envelope }` (refresh) and
 * responds `200 { envelope }`. On a refresh it echoes the envelope
 * unchanged while it is still fresh (`Date.now() < expiry_date - 60000`),
 * otherwise it mints a new `payload` + `sig` under the same `guid`.
 *
 * Intended use:
 *
 * ```ts
 * const tokenExchange = createTokenExchangeFake({ now: () => clock })
 * tokenExchange.install()
 * // ... exercise code under test ...
 * expect(tokenExchange.calls[0].kind).toBe('code')
 * tokenExchange.uninstall()
 * ```
 *
 * Only requests whose URL matches the configured endpoint are intercepted;
 * everything else falls through to whatever `globalThis.fetch` was before
 * `install()`.
 */

import type { Envelope, EnvelopePayload } from '../types.js'

/** Default endpoint drive-sync ships with. */
const DEFAULT_TOKEN_EXCHANGE_URL = 'https://open-webapp.duckdns.org/callback'
/** Scope minted into every fake payload. */
const FAKE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
/** Lifetime, in ms, of a freshly minted payload. */
const TOKEN_LIFETIME_MS = 3_600_000
/** Server-side freshness skew: an envelope inside this window is echoed as-is. */
const REFRESH_SKEW_MS = 60_000

/** One recorded request against the fake endpoint. */
export interface TokenExchangeRecordedCall {
  /** `'code'` for a new-grant body, `'envelope'` for a refresh body. */
  kind: 'code' | 'envelope'
  /** The parsed JSON request body, exactly as received. */
  body: unknown
}

/** Named server error the fake can be told to return on demand. */
type OverrideKind = '410' | '502' | 'malformed' | 'invalidSig' | 'unknownGuid'

export interface TokenExchangeFake {
  /** Swap `globalThis.fetch` for the intercepting handler. Idempotent. */
  install(): void
  /** Restore the exact `globalThis.fetch` that was present at `install()`. Idempotent. */
  uninstall(): void
  /** Every intercepted request, in call order. */
  readonly calls: TokenExchangeRecordedCall[]
  /** The most recently minted / echoed envelope, or `null` before the first call. */
  readonly lastEnvelope: Envelope | null
  /** Make the next `times` (default 1) calls fail `410 refresh_token_revoked`. */
  fail410(times?: number): void
  /** Make the next `times` (default 1) calls fail `502 google_unavailable`. */
  fail502(times?: number): void
  /** Make the next `times` (default 1) calls fail `400 malformed_request`. */
  failMalformed(times?: number): void
  /** Make the next `times` (default 1) calls fail `401 invalid_envelope_signature`. */
  failInvalidSig(times?: number): void
  /** Make the next `times` (default 1) calls fail `404 unknown_guid`. */
  failUnknownGuid(times?: number): void
  /**
   * Re-stamp `lastEnvelope`'s expiry to `now() + msFromNow` (and re-sign it),
   * so a subsequent replay of that envelope is treated as stale. Throws if no
   * envelope has been minted yet.
   */
  setExpiry(msFromNow: number): Promise<void>
}

export interface CreateTokenExchangeFakeOptions {
  /** HMAC secret used to sign minted envelopes. Defaults to a fixed test value. */
  secret?: string
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number
}

/** Canonical JSON: object keys sorted recursively, no insignificant whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key]))
  return '{' + entries.join(',') + '}'
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Which crypto backend the last signing operation used. Exposed for diagnostics. */
export let lastCryptoBackend: 'crypto.subtle' | 'node:crypto' | null = null

async function hmacSha256Base64Url(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const subtle: SubtleCrypto | undefined = (globalThis as { crypto?: Crypto }).crypto?.subtle
  if (subtle) {
    lastCryptoBackend = 'crypto.subtle'
    const key = await subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ])
    const mac = await subtle.sign('HMAC', key, encoder.encode(message))
    return base64UrlFromBytes(new Uint8Array(mac))
  }
  // Fall back to Node's crypto when Web Crypto is unavailable in the test env.
  // Computed specifier keeps TS from trying to resolve `node:crypto` types.
  lastCryptoBackend = 'node:crypto'
  const specifier = 'node:' + 'crypto'
  const nodeCrypto: { createHmac(alg: string, key: string): { update(d: string): { digest(enc: string): string } } } =
    await import(/* @vite-ignore */ specifier)
  return nodeCrypto.createHmac('sha256', secret).update(message).digest('base64url')
}

function randomUuid(): string {
  const webCrypto: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto
  if (webCrypto?.randomUUID) return webCrypto.randomUUID()
  // Extremely defensive fallback; the test env always has crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function randomAccessToken(): string {
  const webCrypto: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto
  const bytes = new Uint8Array(24)
  if (webCrypto?.getRandomValues) webCrypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = (Math.random() * 256) | 0
  let hex = ''
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0')
  return 'ya29.' + hex
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } })
}

const OVERRIDE_RESPONSES: Record<OverrideKind, () => Response> = {
  '410': () => errorResponse(410, 'refresh_token_revoked', 'The refresh token has been revoked'),
  '502': () => errorResponse(502, 'google_unavailable', 'Upstream Google token endpoint is unavailable'),
  malformed: () => errorResponse(400, 'malformed_request', 'The request body was malformed'),
  invalidSig: () => errorResponse(401, 'invalid_envelope_signature', 'The envelope signature did not verify'),
  unknownGuid: () => errorResponse(404, 'unknown_guid', 'No grant exists for that guid'),
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url
  return String((input as { url?: unknown } | null)?.url ?? input)
}

async function bodyTextOf(input: unknown, init: RequestInit | undefined): Promise<string> {
  if (init && typeof init.body === 'string') return init.body
  if (init && init.body != null) return String(init.body)
  if (typeof Request !== 'undefined' && input instanceof Request) return input.clone().text()
  return ''
}

export function createTokenExchangeFake(opts: CreateTokenExchangeFakeOptions = {}): TokenExchangeFake {
  const secret = opts.secret ?? 'token-exchange-fake-secret'
  const now = opts.now ?? (() => Date.now())

  const calls: TokenExchangeRecordedCall[] = []
  const overrideQueue: OverrideKind[] = []
  let lastEnvelope: Envelope | null = null

  let installed = false
  let previousFetch: typeof fetch = globalThis.fetch

  function matchesEndpoint(rawUrl: string): boolean {
    if (rawUrl === DEFAULT_TOKEN_EXCHANGE_URL) return true
    try {
      return new URL(rawUrl).pathname === '/callback'
    } catch {
      return rawUrl.endsWith('/callback')
    }
  }

  async function mintEnvelope(guid: string): Promise<Envelope> {
    const payload: EnvelopePayload = {
      access_token: randomAccessToken(),
      expiry_date: now() + TOKEN_LIFETIME_MS,
      token_type: 'Bearer',
      scope: FAKE_SCOPE,
    }
    const sig = await hmacSha256Base64Url(secret, canonicalJson({ v: 2, guid, payload }))
    return { v: 2, guid, payload, sig }
  }

  function enqueue(kind: OverrideKind, times: number): void {
    const n = Math.max(0, Math.floor(times))
    for (let i = 0; i < n; i += 1) overrideQueue.push(kind)
  }

  const handler = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const rawUrl = urlOf(input)
    if (!matchesEndpoint(rawUrl)) return previousFetch(input as RequestInfo | URL, init)

    let parsed: unknown
    try {
      const text = await bodyTextOf(input, init)
      parsed = text ? JSON.parse(text) : {}
    } catch {
      return errorResponse(400, 'malformed_request', 'The request body was not valid JSON')
    }

    const record = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    const hasCode = record.code != null
    const hasEnvelope = record.envelope != null
    const kind: 'code' | 'envelope' = hasEnvelope && !hasCode ? 'envelope' : 'code'
    calls.push({ kind, body: parsed })

    const override = overrideQueue.shift()
    if (override) return OVERRIDE_RESPONSES[override]()

    if (hasCode && hasEnvelope) {
      return errorResponse(400, 'code_and_envelope_exclusive', 'Provide exactly one of `code` or `envelope`')
    }
    if (!hasCode && !hasEnvelope) {
      return errorResponse(400, 'code_or_envelope_required', 'Provide exactly one of `code` or `envelope`')
    }

    if (hasCode) {
      const minted = await mintEnvelope(randomUuid())
      lastEnvelope = minted
      return jsonResponse(200, { envelope: minted })
    }

    const incoming = record.envelope as Envelope
    if (
      incoming === null ||
      typeof incoming !== 'object' ||
      typeof incoming.payload !== 'object' ||
      incoming.payload === null ||
      typeof incoming.payload.expiry_date !== 'number' ||
      typeof incoming.guid !== 'string'
    ) {
      return errorResponse(400, 'malformed_request', 'The `envelope` was not a well-formed envelope')
    }

    if (now() < incoming.payload.expiry_date - REFRESH_SKEW_MS) {
      lastEnvelope = incoming
      return jsonResponse(200, { envelope: incoming })
    }

    const refreshed = await mintEnvelope(incoming.guid)
    lastEnvelope = refreshed
    return jsonResponse(200, { envelope: refreshed })
  }) as typeof fetch

  return {
    install() {
      if (installed) return
      previousFetch = globalThis.fetch
      globalThis.fetch = handler
      installed = true
    },
    uninstall() {
      if (!installed) return
      globalThis.fetch = previousFetch
      installed = false
    },
    get calls() {
      return calls
    },
    get lastEnvelope() {
      return lastEnvelope
    },
    fail410(times = 1) {
      enqueue('410', times)
    },
    fail502(times = 1) {
      enqueue('502', times)
    },
    failMalformed(times = 1) {
      enqueue('malformed', times)
    },
    failInvalidSig(times = 1) {
      enqueue('invalidSig', times)
    },
    failUnknownGuid(times = 1) {
      enqueue('unknownGuid', times)
    },
    async setExpiry(msFromNow: number) {
      if (!lastEnvelope) {
        throw new Error('createTokenExchangeFake: setExpiry() called before any envelope was minted')
      }
      const payload: EnvelopePayload = { ...lastEnvelope.payload, expiry_date: now() + msFromNow }
      const sig = await hmacSha256Base64Url(secret, canonicalJson({ v: 2, guid: lastEnvelope.guid, payload }))
      lastEnvelope = { v: 2, guid: lastEnvelope.guid, payload, sig }
    },
  }
}
