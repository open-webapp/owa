import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDriveSync, type ProjectHandle } from '../index.js'
import { REQUIRED_SCOPES } from '../files.js'
import { deriveSelfResponseStatus, extractJoinUrl, mapEvent, fullSync, syncChanges, type FullSyncCallOptions, type SyncChangesCallOptions } from '../calendar.js'
import { DriveSyncError, TransientError, NeedsReauthError, SyncTokenExpiredError } from '../errors.js'
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

  function stubPages(pages: { items?: unknown[]; nextPageToken?: string; nextSyncToken?: string; status?: number }[]): void {
    let page = 0
    fetchMock = vi.fn(async (input: unknown) => {
      if (String(input).startsWith(USERINFO_URL)) {
        return new Response(JSON.stringify({ email: 'user@example.com' }), { status: 200 })
      }
      const response = pages[page++]
      if (!response) throw new Error('Unexpected extra page request')
      return new Response(JSON.stringify(response), { status: response.status ?? 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  function eventRequests(): URL[] {
    return fetchMock.mock.calls
      .filter(([input]) => String(input).startsWith(`${CALENDAR_BASE}/calendars/`))
      .map(([input]) => new URL(String(input)))
  }

  function fullSyncOptions(): FullSyncCallOptions {
    return {
      appId: freshId('app'), projectId: freshId('proj'), clientId: 'client-1',
      requiredScopes: REQUIRED_SCOPES,
      timeMin: '2026-10-01T00:00:00Z', timeMax: '2026-11-01T00:00:00Z',
    }
  }

  function syncChangesOptions(): SyncChangesCallOptions {
    const { timeMin: _min, timeMax: _max, ...options } = fullSyncOptions()
    return { ...options, syncToken: 'a+b/c=' }
  }

  describe('syncChanges (exported seam)', () => {
    it('splits changed events and cancelled id-only stubs across pages, using the final token', async () => {
      const first = { id: 'e1', htmlLink: 'link', summary: 'Updated' }
      const second = { id: 'e2', htmlLink: 'link2', start: { date: '2026-10-01' } }
      stubPages([
        { items: [first, { id: 'deleted1', status: 'cancelled' }], nextPageToken: 'page+2/=', nextSyncToken: 'ignore' },
        { items: [{ id: 'deleted2', status: 'cancelled' }, second], nextSyncToken: 'final' },
      ])
      grant()
      expect(await syncChanges(syncChangesOptions())).toEqual({
        events: [mapEvent(first), mapEvent(second)], deletedIds: ['deleted1', 'deleted2'], nextSyncToken: 'final',
      })
      const requests = eventRequests()
      expect(requests.map(url => url.searchParams.get('pageToken'))).toEqual([null, 'page+2/='])
      for (const url of requests) {
        expect(url.pathname).toBe('/calendar/v3/calendars/primary/events')
        expect(url.href).toContain('syncToken=a%2Bb%2Fc%3D')
        expect(url.searchParams.get('syncToken')).toBe('a+b/c=')
        expect(url.searchParams.get('maxResults')).toBe('250')
        expect(url.searchParams.get('singleEvents')).toBe('true')
        for (const key of ['orderBy', 'timeMin', 'timeMax']) expect(url.searchParams.has(key)).toBe(false)
      }
      for (const [, init] of fetchMock.mock.calls) expect(init.method).toBe('GET')
      expect(gisFake.calls[0].prompt).toBe('none')
    })

    it('encodes calendarId and preserves it on mapped events', async () => {
      stubPages([{ items: [{ id: 'e1' }], nextSyncToken: 'next' }])
      grant()
      const result = await syncChanges({ ...syncChangesOptions(), calendarId: 'a@b#c/d' })
      expect(eventRequests()[0].pathname).toBe('/calendar/v3/calendars/a%40b%23c%2Fd/events')
      expect(result.events[0].calendarId).toBe('a@b#c/d')
    })

    it.each([false, true])('translates 410 with preceding page=%s without restarting sync', async (preceding) => {
      stubPages([...(preceding ? [{ items: [{ id: 'e1' }], nextPageToken: 'second' }] : []), { status: 410 }])
      grant()
      const error = await syncChanges(syncChangesOptions()).catch(error => error)
      expect(error).toBeInstanceOf(SyncTokenExpiredError)
      expect(error).toMatchObject({ status: 410, reason: 'sync_token_expired' })
      expect(eventRequests()).toHaveLength(preceding ? 2 : 1)
    })

    it.each([401, 403, 500])('preserves the existing error type for %s', async (status) => {
      stubPages(Array.from({ length: status === 500 ? 3 : status === 401 ? 2 : 1 }, () => ({ status })))
      grant()
      if (status === 401) grant()
      const error = await syncChanges(syncChangesOptions()).catch(error => error)
      expect(error.constructor).toBe(status === 401 ? NeedsReauthError : status === 500 ? TransientError : DriveSyncError)
      expect(error.status).toBe(status)
    })

    it('rejects a missing final sync token', async () => {
      stubPages([{ nextPageToken: 'second', nextSyncToken: 'ignore' }, {}])
      grant()
      await expect(syncChanges(syncChangesOptions())).rejects.toThrow(DriveSyncError)
    })

    it('requires syncToken and forbids time windows at compile time', () => {
      const options = syncChangesOptions()
      const { syncToken: _token, ...withoutToken } = options
      // @ts-expect-error incremental sync requires syncToken
      const missing: SyncChangesCallOptions = withoutToken
      // @ts-expect-error incremental sync forbids timeMin
      const min: SyncChangesCallOptions = { ...options, timeMin: 'a' }
      // @ts-expect-error incremental sync forbids timeMax
      const max: SyncChangesCallOptions = { ...options, timeMax: 'b' }
      void [missing, min, max]
    })
  })

  describe('fullSync (exported seam)', () => {
    it('merges mapped events from two pages and uses only the last sync token', async () => {
      const first = { id: 'e1', htmlLink: 'https://calendar.google.com/e1', start: { date: '2026-10-01' } }
      const second = { id: 'e2', htmlLink: 'https://calendar.google.com/e2', attendees: [{ self: true, responseStatus: 'declined' }] }
      stubPages([
        { items: [first], nextPageToken: 'page 2+/&=', nextSyncToken: 'ignore-first' },
        { items: [second], nextSyncToken: 'final-token' },
      ])
      grant()
      const opts = fullSyncOptions()
      expect(await fullSync(opts)).toEqual({ events: [mapEvent(first), mapEvent(second)], nextSyncToken: 'final-token' })
      const requests = eventRequests()
      expect(requests).toHaveLength(2)
      expect(requests.map(url => url.searchParams.get('pageToken'))).toEqual([null, 'page 2+/&='])
      for (const url of requests) {
        expect(url.pathname).toBe('/calendar/v3/calendars/primary/events')
        expect(url.searchParams.get('timeMin')).toBe(opts.timeMin)
        expect(url.searchParams.get('timeMax')).toBe(opts.timeMax)
        expect(url.searchParams.get('singleEvents')).toBe('true')
        expect(url.searchParams.get('maxResults')).toBe('250')
        expect(url.searchParams.has('orderBy')).toBe(false)
      }
      for (const [, init] of fetchMock.mock.calls) expect(init.method).toBe('GET')
      expect(gisFake.calls[0].prompt).toBe('none')
    })

    it('encodes the calendar id literally in the path and preserves it on events', async () => {
      stubPages([{ items: [{ id: 'e1' }], nextSyncToken: 'token' }])
      grant()
      const result = await fullSync({ ...fullSyncOptions(), calendarId: 'a@b#c' })
      expect(eventRequests()[0].pathname).toBe('/calendar/v3/calendars/a%40b%23c/events')
      expect(result.events[0].calendarId).toBe('a@b#c')
      expect(eventRequests()[0].searchParams.has('orderBy')).toBe(false)
    })

    it('propagates the existing driveFetch error after page two exhausts 500 retries', async () => {
      stubPages([
        { items: [{ id: 'e1' }], nextPageToken: 'second' },
        { status: 500 }, { status: 500 }, { status: 500 },
      ])
      grant()
      const error = await fullSync(fullSyncOptions()).catch(error => error)
      expect(error).toBeInstanceOf(TransientError)
      expect(error).toMatchObject({ status: 500, message: 'Drive request failed with status 500: {"status":500}' })
      expect(eventRequests().map(url => url.searchParams.get('pageToken'))).toEqual([null, 'second', 'second', 'second'])
    })

    it('rejects when the last page omits a sync token even if an earlier page had one', async () => {
      stubPages([
        { items: [{ id: 'e1' }], nextPageToken: 'second', nextSyncToken: 'not-final' },
        {},
      ])
      grant()
      await expect(fullSync(fullSyncOptions())).rejects.toThrow(DriveSyncError)
      expect(eventRequests()).toHaveLength(2)
    })

    it('requires timeMin at compile time', () => {
      const { timeMin: _timeMin, ...withoutTimeMin } = fullSyncOptions()
      // @ts-expect-error fullSync requires the initial window's timeMin
      const invalid: FullSyncCallOptions = withoutTimeMin
      void invalid
    })
  })

  it('follows three pages in order using each response page token', async () => {
    stubPages([
      { items: [{ id: 'e1' }], nextPageToken: 'page 2+/' },
      { items: [{ id: 'e2' }], nextPageToken: 'page 3&=' },
      { items: [{ id: 'e3' }] },
    ])
    grant()
    const events = await makeProject().calendar.listEvents({ timeMin: 'a', timeMax: 'b' })
    expect(events.map(event => event.id)).toEqual(['e1', 'e2', 'e3'])
    const requests = eventRequests()
    expect(requests).toHaveLength(3)
    expect(requests.map(url => url.searchParams.get('pageToken'))).toEqual([null, 'page 2+/', 'page 3&='])
    for (const url of requests) {
      expect(url.searchParams.get('maxResults')).toBe('250')
      expect(url.searchParams.get('timeMin')).toBe('a')
      expect(url.searchParams.get('timeMax')).toBe('b')
      expect(url.searchParams.get('singleEvents')).toBe('true')
      expect(url.searchParams.get('orderBy')).toBe('startTime')
    }
  })

  it('returns a single page without requesting another page', async () => {
    stubPages([{ items: [{ id: 'e1' }] }])
    grant()
    const events = await makeProject().calendar.listEvents({ timeMin: 'a', timeMax: 'b' })
    expect(events.map(event => event.id)).toEqual(['e1'])
    expect(eventRequests()).toHaveLength(1)
    expect(eventRequests()[0].searchParams.has('pageToken')).toBe(false)
  })

  it('continues through an empty page with a next page token', async () => {
    stubPages([
      { items: [{ id: 'e1' }], nextPageToken: 'second' },
      { items: [], nextPageToken: 'third' },
      { items: [{ id: 'e3' }] },
    ])
    grant()
    const events = await makeProject().calendar.listEvents({ timeMin: 'a', timeMax: 'b' })
    expect(events.map(event => event.id)).toEqual(['e1', 'e3'])
    expect(eventRequests().map(url => url.searchParams.get('pageToken'))).toEqual([null, 'second', 'third'])
  })

  it('rejects the whole call when page two fails instead of returning partial events', async () => {
    stubPages([
      { items: [{ id: 'e1' }], nextPageToken: 'second' },
      { status: 404 },
    ])
    grant()
    await expect(makeProject().calendar.listEvents({ timeMin: 'a', timeMax: 'b' })).rejects.toThrow()
    expect(eventRequests()).toHaveLength(2)
  })

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
