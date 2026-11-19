import type { StorageAdapter } from '../core/storage.js'
import type { ContactRecord, SyncRecord } from '../core/types.js'

export * from './storageContract.js'
export * from './fixtures.js'

export function createMemoryStorage(): StorageAdapter {
  const records = new Map<string, ContactRecord>()
  const syncs = new Map<string, SyncRecord>()
  const sk = (a: string, s: string) => `${a}|${s}`
  return {
    async getSync(a, s) {
      const v = syncs.get(sk(a, s))
      return v && { ...v }
    },
    async putSync(a, s, sync) {
      syncs.set(sk(a, s), { ...sync })
    },
    async replaceSource(a, s, recs) {
      for (const [k, r] of records) if (r.accountId === a && r.source === s) records.delete(k)
      for (const r of recs) records.set(r.key, r)
    },
    async applyDelta(a, s, upserts, del) {
      for (const [k, r] of records) {
        if (r.accountId === a && r.source === s && del.includes(r.resourceName)) records.delete(k)
      }
      for (const r of upserts) records.set(r.key, r)
    },
    async getByEmail(e) {
      return [...records.values()].filter((r) => Array.isArray(r.emailsNorm) && r.emailsNorm.includes(e))
    },
    async listAll() {
      return [...records.values()]
    },
    async clear(a) {
      for (const [k, r] of records) if (r.accountId === a) records.delete(k)
      for (const k of syncs.keys()) if (k.startsWith(`${a}|`)) syncs.delete(k)
    },
  }
}
