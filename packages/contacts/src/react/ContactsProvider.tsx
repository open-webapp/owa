import { createContext, useContext, type ReactNode } from 'react'
import type { ContactsController } from '../core/controller.js'

const ContactsContext = createContext<ContactsController | undefined>(undefined)

export function ContactsProvider({ controller, children }: { controller: ContactsController; children?: ReactNode }) {
  return <ContactsContext.Provider value={controller}>{children}</ContactsContext.Provider>
}

export function useContactsController(): ContactsController | undefined {
  return useContext(ContactsContext)
}
