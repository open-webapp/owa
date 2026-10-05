import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync } from '../index.js'
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
