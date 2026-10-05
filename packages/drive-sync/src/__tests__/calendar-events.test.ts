import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync, type ProjectHandle } from '../index.js'
import { REQUIRED_SCOPES } from '../files.js'
import { deriveSelfResponseStatus, extractJoinUrl, mapEvent } from '../calendar.js'
import { createGisFake, type GisFake } from '../testing/gisFake.js'

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3'
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo'

let idSeq = 0
function freshId(prefix: string): string {
  idSeq += 1
  return `${prefix}-${idSeq}`
}

describe('calendar pure helpers', () => {
  describe('deriveSelfResponseStatus', () => {
    it('finds the self attendee and passes its responseStatus through', () => {
      const status = deriveSelfResponseStatus({
        id: 'e1',
        htmlLink: 'https://calendar.google.com/e1',
        attendees: [
          { self: false, responseStatus: 'accepted' },
          { self: true, responseStatus: 'tentative' },
        ],
      })
      expect(status).toBe('tentative')
    })

    it('returns accepted when there is no attendees array at all', () => {
      const status = deriveSelfResponseStatus({ id: 'e1', htmlLink: 'https://calendar.google.com/e1' })
      expect(status).toBe('accepted')
    })

    it('returns declined for a declined self-attendee (still returned, not filtered, proven at listEvents level)', () => {
      const status = deriveSelfResponseStatus({
        id: 'e1',
        htmlLink: 'https://calendar.google.com/e1',
        attendees: [{ self: true, responseStatus: 'declined' }],
      })
      expect(status).toBe('declined')
    })
  })

  describe('extractJoinUrl', () => {
    it('prefers hangoutLink over a conferenceData video entry point', () => {
      const url = extractJoinUrl({
        id: 'e1',
        htmlLink: 'https://calendar.google.com/e1',
        hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc',
        conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xxx' }] },
      })
      expect(url).toBe('https://meet.google.com/aaa-bbbb-ccc')
    })

    it('prefers conferenceData video entry point over a Zoom URL in description', () => {
      const url = extractJoinUrl({
        id: 'e1',
        htmlLink: 'https://calendar.google.com/e1',
        conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/xxx' }] },
        description: 'join at https://zoom.us/j/12345',
      })
      expect(url).toBe('https://meet.google.com/xxx')
    })

    it('falls back to a Zoom URL found in description', () => {
      const url = extractJoinUrl({
        id: 'e1',
        htmlLink: 'https://calendar.google.com/e1',
        description: 'join at https://zoom.us/j/12345',
      })
      expect(url).toBe('https://zoom.us/j/12345')
    })

    it('returns null when there is no link anywhere', () => {
      const url = extractJoinUrl({
        id: 'e1',
        htmlLink: 'https://calendar.google.com/e1',
        location: 'Conference Room B',
        description: 'Bring your own laptop.',
      })
      expect(url).toBeNull()
    })
  })

  describe('mapEvent', () => {
    it('marks an all-day event correctly without throwing, leaving dateTime undefined', () => {
      const event = mapEvent({
        id: 'e1',
        summary: 'Offsite',
        start: { date: '2026-10-01' },
        end: { date: '2026-10-02' },
        htmlLink: 'https://calendar.google.com/e1',
      })
      expect(event.isAllDay).toBe(true)
      expect(event.start.dateTime).toBeUndefined()
      expect(event.start.date).toBe('2026-10-01')
    })

    it('marks a timed event as not all-day', () => {
      const event = mapEvent({
        id: 'e1',
        summary: 'Standup',
        start: { dateTime: '2026-10-01T09:00:00-07:00' },
        end: { dateTime: '2026-10-01T09:30:00-07:00' },
        htmlLink: 'https://calendar.google.com/e1',
      })
      expect(event.isAllDay).toBe(false)
    })

    it('defaults calendarId to primary when called with one arg', () => {
      const event = mapEvent({ id: 'e1', htmlLink: 'https://calendar.google.com/e1' })
      expect(event.calendarId).toBe('primary')
    })
  })
})

describe('listEvents (integration)', () => {
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

  function stubFetch(items: unknown[], status = 200): void {
    fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input)
      if (url.startsWith(USERINFO_URL)) {
        return new Response(JSON.stringify({ email: 'user@example.com' }), { status: 200 })
      }
      if (status !== 200) return new Response('boom', { status })
      return new Response(JSON.stringify({ items }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  function grant(): void {
    gisFake.queueResponse({ access_token: 'tok', expires_in: 3600, scope: REQUIRED_SCOPES.join(' ') })
  }

  function makeProject(additionalScopes?: string[]): ProjectHandle {
    const appId = freshId('app')
    const projectId = freshId('proj')
    const sync = createDriveSync({
      appId,
      clientId: 'client-1',
      folderPath: ['Root'],
      additionalScopes,
    })
    return sync.project(projectId)
  }

  it('issues a GET to the expected URL shape with timeMin/timeMax/singleEvents/orderBy', async () => {
    stubFetch([])
    grant()
    const p = makeProject()

    await p.calendar.listEvents({ timeMin: '2026-09-20T00:00:00Z', timeMax: '2026-10-27T00:00:00Z' })

    const calendarCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes('/calendars/primary/events')
    )
    expect(calendarCall).toBeDefined()
    const url = String(calendarCall![0])
    expect(url).toContain(`timeMin=${encodeURIComponent('2026-09-20T00:00:00Z')}`)
    expect(url).toContain(`timeMax=${encodeURIComponent('2026-10-27T00:00:00Z')}`)
    expect(url).toContain('singleEvents=true')
    expect(url).toContain('orderBy=startTime')
  })

  it('defaults to non-interactive token acquisition', async () => {
    stubFetch([])
    grant()
    const p = makeProject()

    await p.calendar.listEvents({ timeMin: 'a', timeMax: 'b' })

    expect(gisFake.calls[0].prompt).toBe('none')
  })

  it('allows the interactive path when callOpts.interactive is true', async () => {
    stubFetch([])
    grant()
    const p = makeProject()

    await p.calendar.listEvents({ timeMin: 'a', timeMax: 'b' }, { interactive: true })

    // interactive:true -> prompt '' (not 'none'), letting GIS skip through
    // silently when a live grant already exists; see token.ts.
    expect(gisFake.calls[0].prompt).not.toBe('none')
  })

  it('returns a declined event unfiltered (end-to-end proof, not just the pure-function level)', async () => {
    stubFetch([
      {
        id: 'e1',
        summary: 'Skippable meeting',
        start: { dateTime: '2026-10-01T09:00:00-07:00' },
        end: { dateTime: '2026-10-01T09:30:00-07:00' },
        htmlLink: 'https://calendar.google.com/e1',
        attendees: [{ self: true, responseStatus: 'declined' }],
      },
    ])
    grant()
    const p = makeProject()

    const events = await p.calendar.listEvents({ timeMin: 'a', timeMax: 'b' })

    expect(events).toHaveLength(1)
    expect(events[0].selfResponseStatus).toBe('declined')
  })

  it('requests additionalScopes as part of the token used for the Calendar call', async () => {
    stubFetch([])
    const expectedScope = [...REQUIRED_SCOPES, CALENDAR_SCOPE].join(' ')
    gisFake.queueResponse({ access_token: 'tok', expires_in: 3600, scope: expectedScope })
    const p = makeProject([CALENDAR_SCOPE])

    await p.calendar.listEvents({ timeMin: 'a', timeMax: 'b' })

    expect(gisFake.calls[0].scope).toBe(expectedScope)
  })

  describe('calendarId', () => {
    const raw = {
      id: 'e1',
      summary: 'X',
      start: { dateTime: '2026-10-01T09:00:00-07:00' },
      end: { dateTime: '2026-10-01T09:30:00-07:00' },
      htmlLink: 'https://calendar.google.com/e1',
    }
    function calUrl(): string {
      return String(fetchMock.mock.calls.find(([i]) => String(i).includes('/calendars/'))![0])
    }
    it('defaults to primary in URL and events', async () => {
      stubFetch([raw])
      grant()
      const events = await makeProject().calendar.listEvents({ timeMin: 'a', timeMax: 'b' })
      expect(calUrl()).toContain('/calendars/primary/events')
      expect(events[0].calendarId).toBe('primary')
    })

    it('encodes a group calendar id and tags events with it', async () => {
      stubFetch([raw])
      grant()
      const events = await makeProject().calendar.listEvents({
        timeMin: 'a',
        timeMax: 'b',
        calendarId: 'a@group.calendar.google.com',
      })
      expect(calUrl()).toContain('/calendars/a%40group.calendar.google.com/events')
      expect(events[0].calendarId).toBe('a@group.calendar.google.com')
    })

    it('encodes # and / in ids', async () => {
      stubFetch([raw])
      grant()
      const p = makeProject()
      await p.calendar.listEvents({
        timeMin: 'a',
        timeMax: 'b',
        calendarId: 'holiday#x@group.v.calendar.google.com',
      })
      expect(calUrl()).toContain('/calendars/holiday%23x%40group.v.calendar.google.com/events')
      stubFetch([raw])
      grant()
      await p.calendar.listEvents({ timeMin: 'a', timeMax: 'b', calendarId: 'a/b' })
      expect(calUrl()).toContain('/calendars/a%2Fb/events')
    })

    it('throws on a non-ok response', async () => {
      stubFetch([raw], 404)
      grant()
      await expect(
        makeProject().calendar.listEvents({ timeMin: 'a', timeMax: 'b', calendarId: 'zzz' })
      ).rejects.toThrow()
    })
  })
})
