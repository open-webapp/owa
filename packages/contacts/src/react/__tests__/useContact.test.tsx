import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, waitFor, act, cleanup } from '@testing-library/react'
import { createContactsController } from '../../core/controller'
import { createMemoryStorage, installFakeFetch, PERSON_ADA, PERSON_BOB } from '../../testing'
import { ContactsProvider } from '../ContactsProvider'
import { useContact } from '../useContact'

afterEach(cleanup)

function Probe({ email }: { email: string }) {
  const c = useContact(email)
  return <div data-testid="o">{c ? (c.name ?? 'noname') : 'none'}</div>
}

function setup() {
  const fake = installFakeFetch((_r, u) =>
    u.pathname.includes('otherContacts')
      ? { status: 200, body: { nextSyncToken: 't' } }
      : { status: 200, body: { connections: [PERSON_ADA, PERSON_BOB], nextSyncToken: 't' } },
  )
  const controller = createContactsController({
    accounts: [{ id: 'a', getToken: async () => 'tok' }],
    storage: createMemoryStorage(),
  })
  return { controller, fake }
}

describe('useContact', () => {
  it('is undefined, then shows name after sync', async () => {
    const { controller, fake } = setup()
    render(<ContactsProvider controller={controller}><Probe email="ada@example.com" /></ContactsProvider>)
    expect(screen.getByTestId('o')).toHaveTextContent('none')
    await act(() => controller.sync())
    await waitFor(() => expect(screen.getByTestId('o')).toHaveTextContent('Ada Lovelace'))
    fake.restore()
  })

  it('email change yields new result', async () => {
    const { controller, fake } = setup()
    await controller.sync()
    const { rerender } = render(<ContactsProvider controller={controller}><Probe email="ada@example.com" /></ContactsProvider>)
    await waitFor(() => expect(screen.getByTestId('o')).toHaveTextContent('Ada Lovelace'))
    rerender(<ContactsProvider controller={controller}><Probe email="bob@example.com" /></ContactsProvider>)
    await waitFor(() => expect(screen.getByTestId('o')).toHaveTextContent('Bob Builder'))
    fake.restore()
  })

  it('no provider -> undefined, no throw', () => {
    render(<Probe email="ada@example.com" />)
    expect(screen.getByTestId('o')).toHaveTextContent('none')
  })
})
