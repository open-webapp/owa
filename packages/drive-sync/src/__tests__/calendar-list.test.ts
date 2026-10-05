import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync } from '../index.js'
import { REQUIRED_SCOPES } from '../files.js'
import { listCalendars } from '../calendar.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'

const LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

let idSeq = 0

describe('listCalendars', () => {
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

  /** pages: array of [status, body]; served in order for calendarList requests. */
  function stubPages(pages: [number, unknown][]): void {
    let i = 0
    fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith(USERINFO_URL)) {
        return new Response(JSON.stringify({ email: 'user@example.com' }), { status: 200 })
      }
      const [status, body] = pages[Math.min(i++, pages.length - 1)]
      return new Response(JSON.stringify(body), { status })
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  function run(): Promise<Awaited<ReturnType<typeof listCalendars>>> {
    idSeq += 1
    const appId = `cl-app-${idSeq}`
    createDriveSync({ appId, clientId: 'client-1', folderPath: ['Root'] }).project(`cl-proj-${idSeq}`)
    gisFake.queueResponse({ access_token: 'tok', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
    return listCalendars({
      appId,
      projectId: `cl-proj-${idSeq}`,
      clientId: 'client-1',
      requiredScopes: REQUIRED_SCOPES,
    })
  }

  function calendarUrls(): string[] {
    return fetchMock.mock.calls.map(([i]) => String(i)).filter((u) => !u.startsWith(USERINFO_URL))
  }

  it('normalizes items from a single page', async () => {
    stubPages([
      [
        200,
        {
          items: [
            {
              id: 'me@x.com',
              summary: 'Me',
              backgroundColor: '#111111',
              foregroundColor: '#ffffff',
              primary: true,
              accessRole: 'owner',
              selected: true,
            },
            { id: 'team@x.com', summary: 'Team', accessRole: 'reader', selected: false },
          ],
        },
      ],
    ])
    const out = await run()
    expect(out).toEqual([
      {
        id: 'me@x.com',
        summary: 'Me',
        backgroundColor: '#111111',
        foregroundColor: '#ffffff',
        primary: true,
        accessRole: 'owner',
        selected: true,
      },
      { id: 'team@x.com', summary: 'Team', primary: false, accessRole: 'reader', selected: false },
    ])
    expect(calendarUrls()).toEqual([LIST_URL])
  })

  it('follows nextPageToken across 3 pages preserving order', async () => {
    stubPages([
      [200, { items: [{ id: 'c1' }], nextPageToken: 'a+b/c=' }],
      [200, { items: [{ id: 'c2' }], nextPageToken: 'p3' }],
      [200, { items: [{ id: 'c3' }] }],
    ])
    const out = await run()
    expect(out.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    expect(calendarUrls()).toEqual([
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&pageToken=a%2Bb%2Fc%3D',
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&pageToken=p3',
    ])
  })

  it('returns [] for empty or missing items', async () => {
    stubPages([[200, { items: [] }]])
    expect(await run()).toEqual([])
    stubPages([[200, {}]])
    expect(await run()).toEqual([])
  })

  it('defaults missing optional fields without junk keys', async () => {
    stubPages([[200, { items: [{ id: 'bare' }] }]])
    const [cal] = await run()
    expect(cal).toEqual({ id: 'bare', summary: '', primary: false, accessRole: 'reader' })
    expect(Object.keys(cal).filter((k) => k.endsWith('Color'))).toEqual([])
  })

  for (const status of [403, 401, 500]) {
    it(`rejects with no partial result when page 2 returns ${status}`, async () => {
      stubPages([
        [200, { items: [{ id: 'c1' }], nextPageToken: 'next' }],
        [status, { error: 'nope' }],
        [status, { error: 'nope' }],
        [status, { error: 'nope' }],
        [status, { error: 'nope' }],
      ])
      await expect(run()).rejects.toThrow()
    })
  }
})
