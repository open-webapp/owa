import type { ContactRecord, Source, SyncRecord } from './types.js'

export interface StorageAdapter {
  getSync(accountId: string, source: Source): Promise<SyncRecord | undefined>
  putSync(accountId: string, source: Source, sync: SyncRecord): Promise<void>
  replaceSource(accountId: string, source: Source, records: ContactRecord[]): Promise<void>
  applyDelta(
    accountId: string,
    source: Source,
    upserts: ContactRecord[],
    deleteResourceNames: string[],
  ): Promise<void>
  getByEmail(emailNorm: string): Promise<ContactRecord[]>
  listAll(): Promise<ContactRecord[]>
  clear(accountId: string): Promise<void>
}
