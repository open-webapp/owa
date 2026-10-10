import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync, NeedsReauthError, type FullSyncResult, type SyncChangesResult } from '../index.js'
import { REQUIRED_SCOPES } from '../files.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'

const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'
let seq = 0

describe('CalendarHandle', () => {
  let gisFake: GisFake
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    gisFake = createGisFake()
    gisFake.install()
  })
  afterEach(() => {
    gisFake.uninstall()
    vi.unstubAllGlobals()
  })

  function setup(status: number, body: unknown) {
    fetchMock = vi.fn(async (input: unknown) => {
      if (String(input).startsWith(USERINFO_URL)) {
        return new Response(JSON.stringify({ email: 'user@example.com' }), { status: 200 })
      }
      return new Response(JSON.stringify(body), { status })
    })
    vi.stubGlobal('fetch', fetchMock)
    seq += 1
    const handle = createDriveSync({ appId: `ch-app-${seq}`, clientId: 'client-1', folderPath: ['Root'] }).project(`ch-proj-${seq}`)
    gisFake.queueResponse({ access_token: 'tok', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    return handle
  }
  const calUrls = () => fetchMock.mock.calls.map(([i]) => String(i)).filter((u) => !u.startsWith(USERINFO_URL))

  const windowOptions = { timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z' }

  it('fullSync returns events and the sync cursor through the handle', async () => {
    const h = setup(200, { items: [{ id: 'event-1', summary: 'Meeting', htmlLink: 'https://calendar.google.com/event-1' }], nextSyncToken: 'cursor-1' })
    const result: FullSyncResult = await h.calendar.fullSync(windowOptions, { interactive: true })
    expect(result).toEqual({ events: [expect.objectContaining({ id: 'event-1', summary: 'Meeting', calendarId: 'primary' })], nextSyncToken: 'cursor-1' })
  })

  it('syncChanges returns events, deleted IDs and the sync cursor through the handle', async () => {
    const h = setup(200, { items: [{ id: 'event-2', summary: 'Updated', htmlLink: 'https://calendar.google.com/event-2' }, { id: 'deleted-1', status: 'cancelled' }], nextSyncToken: 'cursor-2' })
    const result: SyncChangesResult = await h.calendar.syncChanges({ syncToken: 'cursor-1' }, { interactive: true })
    expect(result).toEqual({ events: [expect.objectContaining({ id: 'event-2', summary: 'Updated', calendarId: 'primary' })], deletedIds: ['deleted-1'], nextSyncToken: 'cursor-2' })
  })

  for (const method of ['fullSync', 'syncChanges'] as const) {
    it(`${method} with omitted callOpts never requests an interactive prompt`, async () => {
      const h = setup(200, { items: [], nextSyncToken: 'cursor-2' })
      const pending = method === 'fullSync'
        ? h.calendar.fullSync(windowOptions)
        : h.calendar.syncChanges({ syncToken: 'cursor-1' })
      await expect(pending).resolves.toEqual(method === 'fullSync'
        ? { events: [], nextSyncToken: 'cursor-2' }
        : { events: [], deletedIds: [], nextSyncToken: 'cursor-2' })
      expect(gisFake.calls.filter(({ prompt }) => prompt !== 'none')).toHaveLength(0)
      expect(gisFake.codeCalls).toHaveLength(0)
    })

    it(`${method} rejects with NeedsReauthError without a token when non-interactive`, async () => {
      const h = setup(200, { items: [], nextSyncToken: 'cursor-2' })
      gisFake.reset()
      gisFake.queueResponse({ error: 'interaction_required' })
      const pending = method === 'fullSync'
        ? h.calendar.fullSync(windowOptions, { interactive: false })
        : h.calendar.syncChanges({ syncToken: 'cursor-1' }, { interactive: false })
      await expect(pending).rejects.toBeInstanceOf(NeedsReauthError)
      expect(gisFake.calls.filter(({ prompt }) => prompt !== 'none')).toHaveLength(0)
      expect(gisFake.codeCalls).toHaveLength(0)
    })
  }

  it('listCalendars hits calendarList and returns normalized items', async () => {
    const h = setup(200, { items: [{ id: 'primary@x.com', summary: 'Me', primary: true, accessRole: 'owner' }] })
    const res = await h.calendar.listCalendars()
    expect(calUrls()[0]).toContain('/users/me/calendarList')
    expect(res).toHaveLength(1)
    expect(res[0].id).toBe('primary@x.com')
  })

  it('listCalendars rejects on non-ok response', async () => {
    const h = setup(500, { error: { message: 'boom' } })
    await expect(h.calendar.listCalendars()).rejects.toBeTruthy()
  })
})
