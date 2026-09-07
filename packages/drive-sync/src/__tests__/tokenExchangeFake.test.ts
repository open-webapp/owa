import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTokenExchangeFake } from '../testing/index.js'

const URL_ = 'https://open-webapp.duckdns.org/callback'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Fixed clock so every test is deterministic. */
let clock = 1_700_000_000_000
const now = () => clock

function post(body: unknown): Promise<Response> {
  return fetch(URL_, { method: 'POST', body: JSON.stringify(body) })
}

afterEach(() => {
  clock = 1_700_000_000_000
})

describe('createTokenExchangeFake', () => {
  it('mints a fresh envelope for a `{ code }` body', async () => {
    const fake = createTokenExchangeFake({ now })
    fake.install()
    try {
      const res = await post({ code: 'auth-code-123' })
      expect(res.status).toBe(200)
      const { envelope } = await res.json()
      expect(envelope.v).toBe(2)
      expect(envelope.guid).toMatch(UUID_RE)
      expect(envelope.payload.token_type).toBe('Bearer')
      expect(envelope.payload.expiry_date).toBe(clock + 3_600_000)
      expect(typeof envelope.sig).toBe('string')
      expect(envelope.sig.length).toBeGreaterThan(0)
      expect(fake.calls[0].kind).toBe('code')
      expect(fake.calls[0].body).toEqual({ code: 'auth-code-123' })
    } finally {
      fake.uninstall()
    }
  })

  it('echoes a fresh envelope byte-for-byte on replay', async () => {
    const fake = createTokenExchangeFake({ now })
    fake.install()
    try {
      const { envelope: minted } = await (await post({ code: 'c' })).json()
      const { envelope: echoed } = await (await post({ envelope: minted })).json()
      expect(echoed).toEqual(minted)
      expect(JSON.stringify(echoed)).toBe(JSON.stringify(minted))
      expect(fake.calls[1].kind).toBe('envelope')
    } finally {
      fake.uninstall()
    }
  })

  it('refreshes a stale envelope under the same guid with a new access token', async () => {
    const fake = createTokenExchangeFake({ now })
    fake.install()
    try {
      const { envelope: minted } = await (await post({ code: 'c' })).json()
      await fake.setExpiry(-1000)
      const stale = fake.lastEnvelope!
      expect(stale.guid).toBe(minted.guid)

      const { envelope: refreshed } = await (await post({ envelope: stale })).json()
      expect(refreshed.guid).toBe(minted.guid)
      expect(refreshed.payload.access_token).not.toBe(minted.payload.access_token)
      expect(refreshed.payload.expiry_date).toBe(clock + 3_600_000)
      expect(refreshed.sig).not.toBe(stale.sig)
    } finally {
      fake.uninstall()
    }
  })

  it('fail502(2) returns two 502s then succeeds', async () => {
    const fake = createTokenExchangeFake({ now })
    fake.install()
    try {
      fake.fail502(2)
      const r1 = await post({ code: 'c' })
      const r2 = await post({ code: 'c' })
      const r3 = await post({ code: 'c' })
      expect([r1.status, r2.status, r3.status]).toEqual([502, 502, 200])
      expect((await r1.json()).error.code).toBe('google_unavailable')
      expect((await r2.json()).error.code).toBe('google_unavailable')
      expect((await r3.json()).envelope.v).toBe(2)
    } finally {
      fake.uninstall()
    }
  })

  it('fail410() returns a 410 refresh_token_revoked', async () => {
    const fake = createTokenExchangeFake({ now })
    fake.install()
    try {
      fake.fail410()
      const res = await post({ envelope: { v: 2, guid: 'g', payload: {}, sig: 's' } })
      expect(res.status).toBe(410)
      expect((await res.json()).error).toEqual({
        code: 'refresh_token_revoked',
        message: expect.any(String),
      })
    } finally {
      fake.uninstall()
    }
  })

  it('rejects a body with both code and envelope, and one with neither', async () => {
    const fake = createTokenExchangeFake({ now })
    fake.install()
    try {
      const both = await post({ code: 'c', envelope: { v: 2, guid: 'g', payload: {}, sig: 's' } })
      expect(both.status).toBe(400)
      expect((await both.json()).error.code).toBe('code_and_envelope_exclusive')

      const neither = await post({})
      expect(neither.status).toBe(400)
      expect((await neither.json()).error.code).toBe('code_or_envelope_required')
    } finally {
      fake.uninstall()
    }
  })

  it('does not intercept requests to unrelated URLs', async () => {
    const passthrough = vi.fn(async () => new Response('ok', { status: 200 }))
    const realFetch = globalThis.fetch
    globalThis.fetch = passthrough as unknown as typeof fetch

    const fake = createTokenExchangeFake({ now })
    fake.install()
    try {
      const res = await fetch('https://example.com/not-the-endpoint', { method: 'POST', body: '{}' })
      expect(res.status).toBe(200)
      expect(passthrough).toHaveBeenCalledTimes(1)
      expect(fake.calls).toHaveLength(0)
    } finally {
      fake.uninstall()
      globalThis.fetch = realFetch
    }
  })

  it('uninstall() fully restores the previous globalThis.fetch', () => {
    const before = globalThis.fetch
    const fake = createTokenExchangeFake({ now })
    fake.install()
    expect(globalThis.fetch).not.toBe(before)
    fake.uninstall()
    expect(globalThis.fetch).toBe(before)
  })
})
