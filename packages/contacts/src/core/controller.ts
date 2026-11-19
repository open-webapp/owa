import type { FetchFn } from './fetch.js'
import { lookupByEmail, type ContactMatch } from './lookup.js'
import type { StorageAdapter } from './storage.js'
import { syncAccount, type AccountSyncStatus } from './sync.js'

export interface ContactsAccount {
  id: string
  getToken: () => Promise<string>
}

export interface ContactsControllerOptions {
  accounts: ContactsAccount[]
  storage: StorageAdapter
  fetch?: FetchFn
}

export interface ContactsStatus {
  /** Per-account, per-source result of the most recent sync; absent until synced. */
  accounts: Partial<Record<string, AccountSyncStatus>>
}

export interface ContactsController {
  sync(): Promise<void>
  lookupByEmail(email: string): Promise<ContactMatch | undefined>
  subscribe(listener: () => void): () => void
  getStatus(): ContactsStatus
  /** Drop all listeners; later sync() calls resolve without fetching. */
  dispose(): void
}

export function createContactsController(opts: ContactsControllerOptions): ContactsController {
  const listeners = new Set<() => void>()
  const emit = () => {
    for (const l of listeners) {
      try {
        l()
      } catch (err) {
        // A broken subscriber must not break sync() or starve the others.
        console.error('[contacts] subscriber threw', err)
      }
    }
  }
  let status: ContactsStatus = { accounts: {} }
  let inflight: Promise<void> | undefined
  let disposed = false

  async function run(): Promise<void> {
    const results = await Promise.all(
      opts.accounts.map((a) =>
        syncAccount({ accountId: a.id, getToken: a.getToken, storage: opts.storage, fetch: opts.fetch }),
      ),
    )
    const accounts: ContactsStatus['accounts'] = {}
    opts.accounts.forEach((a, i) => (accounts[a.id] = results[i]))
    status = { accounts }
    if (!disposed) emit()
  }

  return {
    sync() {
      if (disposed) return Promise.resolve()
      inflight ??= run().finally(() => (inflight = undefined))
      return inflight
    },
    lookupByEmail(email) {
      return lookupByEmail(opts.storage, opts.accounts.map((a) => a.id), email)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getStatus: () => status,
    dispose() {
      disposed = true
      listeners.clear()
    },
  }
}
