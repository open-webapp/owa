import { useMemo, useSyncExternalStore } from 'react'
import type { ContactsController } from '../core/controller.js'
import type { ContactMatch } from '../core/lookup.js'
import { useContactsController } from './ContactsProvider.js'

const NOOP_UNSUB = () => {}

function sameMatch(a: ContactMatch | undefined, b: ContactMatch | undefined): boolean {
  return a === b || (!!a && !!b && a.name === b.name && a.photoUrl === b.photoUrl)
}

/** Per-(controller,email) store with a stable snapshot; refreshes on controller notifications. */
function createLookupStore(controller: ContactsController | undefined, email: string | undefined) {
  let snapshot: ContactMatch | undefined
  let version = 0
  const listeners = new Set<() => void>()
  const refresh = async () => {
    if (!controller || !email) return
    const v = ++version
    let next: ContactMatch | undefined
    try {
      next = await controller.lookupByEmail(email)
    } catch {
      return
    }
    if (v !== version || sameMatch(snapshot, next)) return
    snapshot = next
    for (const l of listeners) l()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (!controller || !email) return NOOP_UNSUB
      listeners.add(listener)
      const unsub = controller.subscribe(() => void refresh())
      void refresh()
      return () => {
        listeners.delete(listener)
        version++
        unsub()
      }
    },
  }
}

export function useContact(email: string | undefined): ContactMatch | undefined {
  const controller = useContactsController()
  const store = useMemo(() => createLookupStore(controller, email), [controller, email])
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
