export type Source = 'connections' | 'otherContacts'

export interface ContactRecord {
  key: string
  accountId: string
  source: Source
  resourceName: string
  name?: string
  nameNorm?: string
  emails: string[]
  emailsNorm: string[]
  photoUrl?: string
}

export interface SyncRecord {
  syncToken?: string
  lastSyncAt: number
}

export interface PersonName { displayName?: string }
export interface PersonEmail { value?: string }
export interface PersonPhoto { url?: string; default?: boolean }
export interface Person {
  resourceName?: string
  names?: PersonName[]
  emailAddresses?: PersonEmail[]
  photos?: PersonPhoto[]
  metadata?: { deleted?: boolean }
  deleted?: boolean
}

export class ContactsAuthError extends Error {
  constructor(message = 'Contacts request unauthorized') {
    super(message)
    this.name = 'ContactsAuthError'
  }
}

export class ContactsScopeError extends Error {
  constructor(message = 'Contacts request missing required scope') {
    super(message)
    this.name = 'ContactsScopeError'
  }
}

export class ContactsFetchError extends Error {
  readonly status: number
  constructor(status: number, message = `Contacts request failed (${status})`) {
    super(message)
    this.name = 'ContactsFetchError'
    this.status = status
  }
}

export class SyncTokenExpiredError extends Error {
  constructor(message = 'Contacts sync token expired') {
    super(message)
    this.name = 'SyncTokenExpiredError'
  }
}
