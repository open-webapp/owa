# @open-webapp/calendar SPEC

## Scope

Read-only Google Calendar sync for N accounts ("sources"), local encrypted cache via host adapters, React presentation. No OAuth: the host provides `getToken(sourceId)`.

## Public surface

Package exports: `.`, `./testing`, `./styles.css`.

`.` re-exports: types (`Source`, `RsvpStatus`, `CalendarEvent`, `CalendarEventDateTime`, `CalendarInfo`, `ParseContext`), events helpers (`DEFAULT_RSVP_STATUSES`, `reconcileSelectedCalendarIds`, `filterCalendarsByName`, `getCalendarEventKey`, `summarizeCalendarSelection`, `isAllDay`, `getRollingWindow`, `filterByRsvp`, `getOrganizerLabel`, `isEventCurrent`, `findNextUpcomingEvent`, `groupByDay`, `formatDayHeader`, `DayGroup`, `deriveSelfResponseStatus`, `extractJoinUrl`, `parseEvent`, `parseEvents`), storage types (`SyncState`, `StorageRow`, `StorageAdapter`, `CryptoAdapter`), fetch (`CalendarFetchError`, `fetchCalendarList`, `fetchEvents`, `EventsPage`), `syncCalendar`, `reconcileSelection`, `applyChanges`, controller (`createCalendarController`, `CalendarController`, `CalendarControllerOptions`, `SourceStatus`), UI (`CalendarPane`, `CalendarPaneProps`, `RsvpSelection`, `CalendarSelector`).

`./testing`: `runStorageAdapterContract`, `StorageContractHarness`, `LEGACY_EVENT`, `createMemoryStorage`, `identityCrypto`, `installFakeFetch`/`FakeReply`. Requires optional peer `vitest`.

## Controller invariants

1. `refresh()` never rejects. Each source is refreshed independently and concurrently.
2. `getEvents()` is concatenation of per-source events in `sources` order; reference changes only on publish.
3. Persistence is best effort; failure never affects in-memory state.
4. Rows: `events` and `syncState` encrypted JSON strings; `selectedIds` plain. Reads accept plain legacy values; corrupt/undecryptable data yields empty state.
5. Selection: stored selection filtered to existing calendars; if empty, primary (else first). Primary is always included.
6. `setSelectedIds` always retains the primary calendar, removes events and tokens of deselected calendars, persists, notifies.

## sourceStatus

| Event | Status |
| --- | --- |
| successful refresh | `ok` |
| 403 containing `insufficientPermissions` | `needs-scope` |
| 401, other 403, other HTTP, parse error, unexpected exception | `error` |
| network failure | unchanged (cached events retained) |

Initial: `ok` for every source.

## Sync

- Window: `getRollingWindow(now)` = now-30d .. now+30d, ISO timestamps; API times sent without milliseconds.
- Full sync: `singleEvents=true`, `timeMin/timeMax`, `maxResults=250`, paginated; `nextSyncToken` stored per calendarId.
- Incremental: `syncToken` only (no time params); changes applied by event id; cancelled removed.
- 410 (`CalendarFetchError.kind === 'gone'`): fall back to full windowed sync.
- `CalendarFetchError.kind`: `network | auth | scope | gone | http`.

## Adapter contract

`StorageAdapter` and `CryptoAdapter` as in README. `runStorageAdapterContract(factory)` is the normative test suite; a host adapter must pass it. Harness fields: `storage`, `crypto`, optional `seedRaw`, `wrongKeyCrypto`, `encryptedFixture`, `corruptRow`.

## UI contract

`CalendarPane` and `CalendarSelector` props as in README. Multi-source (2+ sources): events colored per source, email shown. `needs-scope` for all sources shows a re-auth prompt; per-source notices via `sourceNotice`. Selector keeps at least one calendar selected. Event popup opens via `window.open(url, popupName)` falling back to `_blank`.

## Styling

`./styles.css` standalone, `prefers-color-scheme` dark variants. Variables: `--calendar-footer-height`, `--chip-row-height` (optional host overrides), `--rsvp-bar` (internal). No required host variables.

## Versioning

Independent semver; tag `calendar-v<version>` publishes. Breaking changes to exports, row shapes or status semantics require a major (0.x: minor) bump.
