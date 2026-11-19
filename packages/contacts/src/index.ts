// Core entry: framework-free. Must not import React (see ./react for UI).
export {
  createContactsController,
  type ContactsAccount,
  type ContactsController,
  type ContactsControllerOptions,
  type ContactsStatus,
} from './core/controller.js'
export { lookupByEmail, type ContactMatch } from './core/lookup.js'
export {
  syncAccount,
  syncSource,
  SOURCES,
  type AccountSyncStatus,
  type SourceStatus,
  type SyncAccountOptions,
  type SyncSourceOptions,
} from './core/sync.js'
export type { FetchFn } from './core/fetch.js'
export type { StorageAdapter } from './core/storage.js'
export { normalizeEmail, normalizeName, normalizePhotoUrl, personToRecord } from './core/normalize.js'
export {
  ContactsAuthError,
  ContactsFetchError,
  ContactsScopeError,
  SyncTokenExpiredError,
  type ContactRecord,
  type Person,
  type PersonEmail,
  type PersonName,
  type PersonPhoto,
  type Source,
  type SyncRecord,
} from './core/types.js'
