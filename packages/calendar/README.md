# @open-webapp/calendar

Multi-account Google Calendar read-only sync (controller) plus React UI (`CalendarPane`, `CalendarSelector`). Storage and encryption are host-supplied adapters.

## Install

```bash
npm install @open-webapp/calendar
```

Peer: `react ^19`. `vitest` is an optional peer, needed only for `@open-webapp/calendar/testing`'s `runStorageAdapterContract`.

## Entry points

| Import | Contents |
| --- | --- |
| `@open-webapp/calendar` | core types, event helpers, fetch/sync/reconcile helpers, `createCalendarController`, `CalendarPane`, `CalendarSelector` |
| `@open-webapp/calendar/testing` | `runStorageAdapterContract`, `LEGACY_EVENT`, `StorageContractHarness`, `createMemoryStorage`, `identityCrypto`, `installFakeFetch` |
| `@open-webapp/calendar/styles.css` | stylesheet for the React components (import once) |

## Usage

```tsx
import { createCalendarController, CalendarPane } from '@open-webapp/calendar';
import '@open-webapp/calendar/styles.css';

const controller = createCalendarController({
  sources: [{ id: 'a', email: 'me@example.com' }],
  getToken: async (sourceId) => accessTokenFor(sourceId),
  storage,   // StorageAdapter
  crypto,    // CryptoAdapter
});
await controller.refresh();

<CalendarPane
  sources={sources}
  controller={controller}
  selectedRsvpStatuses={statuses}          // Set<RsvpStatus>
  onRsvpStatusesChange={setStatuses}
/>
```

## Controller

`createCalendarController({ sources, getToken, storage, crypto, now? })`

- `refresh(): Promise<void>` syncs every source in parallel; never throws.
- `getEvents(): CalendarEvent[]` stable snapshot (updated on `refresh`/`setSelectedIds`), sources concatenated in `sources` order.
- `getSourceStatus()` / `sourceStatus`: `Record<sourceId, 'ok' | 'needs-scope' | 'error'>`.
- `getCalendars(sourceId)`, `getSelectedIds(sourceId)`.
- `setSelectedIds(sourceId, ids)`: primary calendar is always kept; drops events/tokens of deselected calendars, persists, notifies.
- `clearSelectedIds(sourceId)`: same as `setSelectedIds(sourceId, [])` (leaves primary only).
- `subscribe(listener): () => void`.

### sourceStatus

- `ok`: last refresh succeeded (also the initial value).
- `needs-scope`: Google returned 403 `insufficientPermissions`; the host should prompt re-consent.
- `error`: any other failure (401, 5xx, non-403 HTTP, unexpected exception).
- Network failures leave the previous status unchanged and keep cached events.

## Adapters

```ts
interface StorageAdapter {
  get(sourceId): Promise<StorageRow | null>;
  put(sourceId, row: StorageRow): Promise<void>;
  delete(sourceId): Promise<void>;
  clear(sourceId): Promise<void>;
}
interface StorageRow { events: CalendarEvent[] | string | unknown[]; syncState: SyncState | string | null | unknown; selectedIds: string[] }
interface SyncState { tokens: Record<calendarId, string> }
interface CryptoAdapter { encrypt(s: string): Promise<string>; decrypt(s: string): Promise<string> }
```

The controller writes `events` and `syncState` as `crypto.encrypt(JSON.stringify(...))` strings and `selectedIds` as a plain array. On read, string values are decrypted and parsed; non-string (legacy plain) values are used as-is. Corrupt rows or decrypt failures read back as empty.

### Contract harness

```ts
import { runStorageAdapterContract } from '@open-webapp/calendar/testing';
runStorageAdapterContract(() => ({ storage, crypto, seedRaw?, wrongKeyCrypto?, encryptedFixture?, corruptRow? }));
```

Call at top level of a vitest file; it registers a `describe('StorageAdapter contract')` suite (round trip, source isolation, delete/clear, missing source, legacy plain row, legacy encrypted fixture, corrupt row, wrong key).

## Sync behavior

- First sync per calendar: full fetch, `singleEvents=true`, window now -30d .. now +30d (RFC3339, no milliseconds), all pages (`maxResults=250`); stores `nextSyncToken`.
- Later syncs: incremental with `syncToken` (no time bounds); cancelled items remove events.
- HTTP 410: token dropped, full windowed resync.
- Several sources are fetched independently; one failing source does not affect others.

## UI

### CalendarPane props

| Prop | Type | Notes |
| --- | --- | --- |
| `sources` | `Source[]` | shown accounts; 2+ enables multi-source UI (per-source color and email) |
| `controller` | `CalendarController` | |
| `selectedRsvpStatuses` | `Set<RsvpStatus>` | filter; `DEFAULT_RSVP_STATUSES` = accepted, tentative, needsAction |
| `onRsvpStatusesChange` | `(next) => void` | |
| `renderEventAction?` | `(event) => ReactNode` | per-event slot |
| `emptyState?` | `ReactNode` | shown when no sources are connected |
| `sourceNotice?` | `(source) => ReactNode` | per-source slot (e.g. re-consent button when `needs-scope`) |
| `onClose?` | `() => void` | |
| `popupName?` | `string` | `window.open` name for the event popup (default `notesdiary-cal-event`) |

### CalendarSelector props

`calendars: CalendarInfo[]`, `selectedIds: string[]`, `onChange(ids)`, `heading?: string` (account heading in multi-source use). It has no slot props or `popupName`. At least one calendar stays selected; "Clear" resets to the primary calendar.

### Host CSS

`styles.css` is self-contained (plain colors, dark mode via `prefers-color-scheme`). It requires no host CSS variables. Variables it reads, all with defaults:

- `--calendar-footer-height` (default `64px`, set on `.calendar-pane`; override to match host footer)
- `--chip-row-height` (fallback `44px`; host may set it to match its chip row for sticky headers)
- `--rsvp-bar` (set internally per RSVP status; do not override)
