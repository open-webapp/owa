# @open-webapp/drive-sync

Plain-TypeScript, React-free library for Google Drive OAuth token lifecycle,
storage, and low-level Drive file/permission operations. Extracted from
`open-webapp/planning` and `notesdiary/app`, which each had their own fork of
this logic (and the same 11 bugs).

The library owns auth + storage + Drive I/O. Merge logic, file naming, and
content format stay app-side.

## Usage

```ts
import { createDriveSync } from '@open-webapp/drive-sync'

const drive = createDriveSync({
  appId: 'my-app',
  clientId: 'xxx.apps.googleusercontent.com',
  folderPath: ['MyApp', 'Data'],
  // additionalScopes?: string[] — request extra OAuth scopes alongside the
  // library's own Drive scopes. Omitted/empty = identical behavior to before
  // this option existed.
})

const dispose = drive.activate()
await drive.reconcile(knownProjectIds)

const p = drive.project(projectId)
await p.connect()
const picked = await p.pickFile({ apiKey: PICKER_API_KEY, appId: GCP_PROJECT_NUMBER })
const folderId = await p.ensureFolderPath()
await p.files.write({ folderId, name: 'data.json', content: '{}', mimeType: 'application/json' })

// ensureFolderPath() with subPath for nested folder navigation
const nestedFolderId = await p.ensureFolderPath({ subPath: ['Archive', 'Q1'] })

// files.update() for metadata-only or baseline-preserving updates
const ref = await p.files.update(fileId, {
  name: 'renamed.json',  // metadata-only change
  mimeType: 'application/json',
})
```

### Calendar events (read-only)

Reuses the same connected Google account — no second OAuth flow — as long as
`additionalScopes: ['https://www.googleapis.com/auth/calendar.readonly']` was
passed to `createDriveSync`. The caller supplies the time window; this
library hardcodes no date range:

```ts
const events = await p.calendar.listEvents({
  timeMin: new Date(Date.now() - 7 * 86400_000).toISOString(),
  timeMax: new Date(Date.now() + 30 * 86400_000).toISOString(),
})
```

Read-only (no create/update/delete). Non-interactive by default, like
`p.files.*` — a background poll never pops a consent screen; pass
`{ interactive: true }` to allow one. Every event in range is returned,
unfiltered — callers decide what to show/hide, including declined events.
Each `CalendarEvent` includes `selfResponseStatus`, a best-effort `joinUrl`,
and `isAllDay`-aware `start`/`end` (an all-day event has `date` set and
`dateTime` left `undefined`).

#### Multiple calendars (0.10.0)

`p.calendar.listCalendars(callOpts?)` returns every calendar on the account's
calendar list as `CalendarInfo[]` (`id`, `summary`, `primary`, `accessRole`,
and optional `backgroundColor`, `foregroundColor`, `selected`). Pagination is
handled internally; it uses the same `calendar.readonly` scope and is
non-interactive by default, like `listEvents`. `listEvents` takes an optional
`calendarId` (default `'primary'`, URL-encoded in the request path), and each
returned `CalendarEvent.calendarId` is the id you passed (or `'primary'`), not
resolved to an email.

```ts
const calendars = await p.calendar.listCalendars()
const timeMin = new Date().toISOString()
const timeMax = new Date(Date.now() + 7 * 86400_000).toISOString()
const perCalendar = await Promise.all(
  calendars
    .filter((c) => c.selected)
    .map((c) => p.calendar.listEvents({ timeMin, timeMax, calendarId: c.id })),
)
const events = perCalendar.flat() // each event.calendarId identifies its source
```

**0.10.0 note:** `calendarId: string` is now a required field on
`CalendarEvent`. Consumers that hand-build `CalendarEvent` literals (tests,
mocks) must add it.

### Synchronous connection snapshot

`p.getConnectionSync()` / `p.subscribeConnection()` give a framework store a
synchronous, referentially-stable `Connection | null` without polling:

```ts
const store = {
  get: () => p.getConnectionSync(),
  subscribe: (onChange: () => void) => p.subscribeConnection(onChange),
}
```

This pairing is the intended backing for `@open-webapp/drive-connect`'s React
hook (`useDriveConnection`), and works equally well for any other
`useSyncExternalStore`-shaped store.

See `SPEC.md` for the full design: the 36 resolved decisions, storage layout,
and refresh state machine. `SPEC.md` is descriptive, written from the shipped
code — if it ever disagrees with the source, the source wins.

## Server-facilitated token exchange

By default the library runs the legacy GIS flow: an implicit-style access token
acquired in the browser, refreshed silently through GIS, with no
`refresh_token` anywhere. Pass `tokenExchangeUrl` to `createDriveSync` to opt in
to the server-facilitated variant instead:

```ts
import { createDriveSync } from '@open-webapp/drive-sync'

const drive = createDriveSync({
  appId: 'my-app',
  clientId: 'xxx.apps.googleusercontent.com',
  folderPath: ['MyApp', 'Data'],
  tokenExchangeUrl: 'https://open-webapp.duckdns.org/callback',
})
```

**Code → envelope → replay.** With `tokenExchangeUrl` set, `connect()` uses
GIS `initCodeClient` (popup) to obtain a one-time authorization **code**, then
`POST {tokenExchangeUrl}` with `{ code }`. The server does the code→token
exchange, keeps the `refresh_token` server-side, and returns a signed, opaque
**envelope** `{ v, guid, payload, sig }` whose `payload` carries the
`access_token`, `expiry_date`, and `scope`. The client persists the whole
envelope verbatim and derives its normal `token` record from `payload`.

**Replay for refresh.** When the access token is stale, the client does not
talk to GIS — it replays the stored envelope byte-for-byte:
`POST {tokenExchangeUrl}` with `{ envelope }`. The server mints a fresh access
token from its stored `refresh_token` and returns a new envelope, which
replaces the stored one. A local freshness check skips the network entirely
while the current token is still outside the 5-minute refresh buffer, and
concurrent refreshes for the same `projectId` are coalesced.

**`refresh_token` stays server-side.** The client never sees or stores a
`refresh_token`; it only ever holds the opaque envelope and replays it. The
`sig` is a server signature that is **never** verified client-side — the
envelope is treated as fully opaque.

**Opt-in / legacy path unchanged.** When `tokenExchangeUrl` is absent,
`connect()`, refresh, and `disconnect()` behave exactly as before (GIS token
client, silent refresh, no envelope). Nothing about the legacy flow changes.

**CORS.** The reference exchange server's CORS allowlist is
`https://notesdiary.github.io` and `https://open-webapp.github.io` **only**,
with credentials disabled. `localhost` is not on the allowlist, so the
`drive-sync-oauth-tester` app runs its requests through a Vite dev-server proxy
that rewrites the `Origin` header to `https://open-webapp.github.io` (an
Origin-spoof proxy) — without it the browser blocks the exchange call.

The full request/response contract is documented at
`https://open-webapp.duckdns.org/callback-api.md`.

## Testing

Import fakes for GIS and Drive from the `./testing` subpath:

```ts
import { createGisFake, createDriveFake } from '@open-webapp/drive-sync/testing'
```
