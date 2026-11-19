import type { Person } from '../core/types.js'

export const PERSON_ADA: Person = {
  resourceName: 'people/c1',
  names: [{ displayName: 'Ada Lovelace' }],
  emailAddresses: [{ value: 'ada@example.com' }, { value: 'Countess@Example.com' }],
  photos: [{ url: 'https://lh3.googleusercontent.com/a/ada=s100' }],
}
export const PERSON_BOB: Person = {
  resourceName: 'people/c2',
  names: [{ displayName: 'Bob Builder' }],
  emailAddresses: [{ value: 'bob@example.com' }],
}
export const PEOPLE_FIXTURES: Person[] = [PERSON_ADA, PERSON_BOB]

export type FakeReply = { status: number; body?: unknown } | 'network-error'

/** Replaces globalThis.fetch with a router-driven fake; call restore() when done. */
export function installFakeFetch(
  router: (req: { url: string; token: string }, u: URL) => FakeReply,
): { log: { url: string; token: string }[]; restore: () => void } {
  const original = globalThis.fetch
  const log: { url: string; token: string }[] = []
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    const url = String(input)
    const auth = init?.headers?.Authorization ?? init?.headers?.authorization ?? ''
    const req = { url, token: auth.replace(/^Bearer /, '') }
    log.push(req)
    const reply = router(req, new URL(url))
    if (reply === 'network-error') throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { log, restore: () => void (globalThis.fetch = original) }
}
