import { normalizeEmail } from './normalize.js'
import type { StorageAdapter } from './storage.js'
import type { Source } from './types.js'

export interface ContactMatch {
  name?: string
  photoUrl?: string
}

const SOURCE_RANK: Record<Source, number> = { connections: 0, otherContacts: 1 }

export async function lookupByEmail(
  storage: StorageAdapter,
  accounts: string[],
  email: string,
): Promise<ContactMatch | undefined> {
  const records = await storage.getByEmail(normalizeEmail(email))
  for (const accountId of accounts) {
    const hits = records
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source])
    const hit = hits[0]
    if (hit) {
      const out: ContactMatch = {}
      if (hit.name !== undefined) out.name = hit.name
      if (hit.photoUrl !== undefined) out.photoUrl = hit.photoUrl
      return out
    }
  }
  return undefined
}
