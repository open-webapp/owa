# @open-webapp/calendar

Multi-account Google Calendar read-only sync (controller) plus React UI (`CalendarPane`, `CalendarSelector`). Storage and encryption are host-supplied adapters.

> **0.8.0 is BREAKING.** See [0.8.0](#080-breaking-pre-10-minor) for independent Unaccepted toggling.

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
await controller.hydrate();  // publishes cached events immediately (no network)
void controller.refresh();   // then syncs from Google

<CalendarPane
  sources={sources}
  controller={controller}
  theme="system"                           // optional: 'system' | 'light' | 'dark'
  selectedRsvpStatuses={statuses}          // Set<RsvpStatus>
  onRsvpStatusesChange={setStatuses}
  connected={connected}                    // optional, see CalendarPane props
  needsReauth={needsReauth}
  onConnect={connect}
  onReconnect={reconnect}
/>
```

## Controller

`createCalendarController({ sources, getToken, storage, crypto, now? })`

- `hydrate(): Promise<void>` loads the stored rows and publishes cached events before any network call. Never throws. Offline, the cache stays visible.
- `refresh(): Promise<void>` syncs every source in parallel; never throws.
- `retryDeferred(): Promise<void>` re-runs a refresh after a deferred pass (see [Deferred refresh](#deferred-refresh)).
- `getEvents(): CalendarEvent[]` stable snapshot (updated on `hydrate`/`refresh`/`setSelectedIds`/`clearSelectedIds`), sources concatenated in `sources` order. Only events that pass the read-time filter are returned (see [Window](#window)).
- `getState(): { loading, error, deferred, lastSyncAt }`:
  - `loading`: a refresh pass is in flight.
  - `error`: true only when every selected calendar (across sources) errored and nothing is cached.
  - `deferred`: the last pass was deferred.
  - `lastSyncAt`: ms epoch of the most recent refresh pass across sources, or `null`.
- `getSourceStatus()` / `sourceStatus`: `Record<sourceId, 'ok' | 'needs-scope' | 'error'>`.
- `getCalendars(sourceId)`, `getSelectedIds(sourceId)`.
- `setSelectedIds(sourceId, ids)`: see [Selection](#selection). Fetches calendars newly added to the selection; drops nothing it has cached for deselected calendars.
- `clearSelectedIds(sourceId)`: resets the selection to the primary calendar.
- `subscribe(listener): () => void`.

### Selection

- Default selection is the primary calendar.
- On refresh, the stored selection is filtered to calendars that still exist. If none remain, the selection falls back to the primary calendar (else the first calendar).
- Primary is not forced: a stored selection that omits primary is kept.
- `setSelectedIds(id, [])` is ignored; at least one calendar always remains selected. Use `clearSelectedIds` to reset to primary.
- `setSelectedIds` persists the selection and fetches any calendars newly added to it.
- Deselecting a calendar keeps its cached events and sync tokens (retained, hidden by the read-time filter). Re-selecting it shows the cache immediately and syncs it.

### sourceStatus

- `ok`: last refresh succeeded, or only some calendars failed (also the initial value).
- `needs-scope`: Google returned 403 `insufficientPermissions`; the host should prompt re-consent.
- `error`: any other failure (401, 5xx, non-403 HTTP, unexpected exception).
- Network failures leave the previous status unchanged and keep cached events.

### Deferred refresh

- A host `getToken` (or fetch path) may throw `RefreshDeferredError`, or any error with `deferred: true`. `isRefreshDeferredError(e)` recognises both.
- A deferred pass is quiet: it does not change `sourceStatus`, does not set `getState().error`, and is not retried immediately. `getState().deferred` becomes `true`; the host calls `retryDeferred()` when it is ready.

## Sync behavior

Per calendar:

- Full (windowed) sync when there is no sync token, no `lastFullSyncAt` for that calendar, or the last full sync is more than 24h old. Full sync uses `singleEvents=true`, window now -30d .. now +30d (RFC3339, no milliseconds), all pages (`maxResults=250`), and stores `nextSyncToken` and `lastFullSyncAt`.
- Otherwise incremental with `syncToken` (no time bounds); cancelled items remove events.
- HTTP 410 (`gone`): token dropped, full windowed resync.
- A failing calendar is retried once immediately (deferred errors are not retried).
- Calendars are isolated: one failing calendar keeps its cached events and token; other calendars and sources are unaffected.
- Per-source status: if some targeted calendars succeed and none reports a scope error, the source is `ok` (failed calendars keep their cached events). A scope error gives `needs-scope`. If every targeted calendar fails, the status follows the `sourceStatus` rules above (`error` for non-network failures, unchanged on network-only failures).

### Window

- Stored events whose end is strictly before now -30d are pruned on refresh.
- Read-time filter (`getEvents()`): events on deselected calendars are hidden; events are kept when they end after now -30d and start before now +30d (edges excluded, overlaps kept).

## Adapters

```ts
interface StorageAdapter {
  get(sourceId): Promise<StorageRow | null>;
  put(sourceId, row: StorageRow): Promise<void>;
  delete(sourceId): Promise<void>;
  clear(sourceId): Promise<void>;
}
interface StorageRow { events: CalendarEvent[] | string | unknown[]; syncState: SyncState | string | null | unknown; selectedIds: string[] }
interface SyncState {
  tokens: Record<calendarId, string>;
  lastFullSyncAt?: Record<calendarId, number>; // ms epoch; absent on 0.1.0 rows
  lastSyncAt?: number;                         // ms epoch; absent on 0.1.0 rows
}
interface CryptoAdapter { encrypt(s: string): Promise<string>; decrypt(s: string): Promise<string> }
```

The controller writes `events` and `syncState` as `crypto.encrypt(JSON.stringify(...))` strings and `selectedIds` as a plain array. On read, string values are decrypted and parsed; non-string (legacy plain) values are used as-is. Corrupt rows or decrypt failures read back as empty.

Rows written by 0.1.0 (no `lastFullSyncAt`/`lastSyncAt`, no retained-calendar data) still read. A missing `lastFullSyncAt` triggers one full windowed sync on the next refresh.

### Contract harness

```ts
import { runStorageAdapterContract } from '@open-webapp/calendar/testing';
runStorageAdapterContract(() => ({ storage, crypto, seedRaw?, wrongKeyCrypto?, encryptedFixture?, corruptRow? }));
```

Call at top level of a vitest file; it registers a `describe('StorageAdapter contract')` suite (round trip, source isolation, delete/clear, missing source, legacy plain row, legacy encrypted fixture, corrupt row, wrong key).

### Event key

`getCalendarEventKey(event)` returns `${sourceId}:${calendarId}:${eventId}` (e.g. `src1:calA:ev1`). This multi-source form is the one intentional divergence from notesdiary (`calA:ev1`), kept by decision for multi-source.

## UI

### CalendarPane props

| Prop | Type | Notes |
| --- | --- | --- |
| `sources` | `Source[]` | shown accounts; 2+ enables multi-source UI (per-source color and email) |
| `controller` | `CalendarController` | |
| `theme?` | `'system' \| 'light' \| 'dark'` | defaults to `'system'`, including when `undefined`; applies to every pane state and all internal selectors |
| `selectedRsvpStatuses` | `Set<RsvpStatus>` | host-controlled filter; `DEFAULT_RSVP_STATUSES` = accepted, tentative, needsAction (O pressed) |
| `onRsvpStatusesChange` | `(next) => void` | |
| `renderEventAction?` | `(event) => ReactNode` | per-event slot |
| `connected?` | `boolean` | defaults to `sources.length > 0` (back-compat). `false` shows the not-connected block |
| `needsReauth?` | `boolean` | defaults to every source being `needs-scope`. Shows the reauth block |
| `onConnect?` | `() => void` | wired to the built-in "Connect Google Calendar" button |
| `onReconnect?` | `() => void` | wired to the built-in "Reconnect to restore sync" button |
| `emptyState?` | `ReactNode` | replaces the built-in not-connected block |
| `sourceNotice?` | `(source) => ReactNode` | per-source slot, rendered for `needs-scope` sources (e.g. re-consent button); without it the built-in reauth block is shown |
| `onClose?` | `() => void` | |
| `popupName?` | `string` | `window.open` name for the event popup (default `notesdiary-cal-event`) |

#### RSVP chips

The chips appear in order: Accepted, Maybe, Declined, Unaccepted (O). All four independently toggle current supplied membership. Defaults remain accepted, tentative, needsAction, so O is pressed by default.

O is pressed iff `needsAction` belongs to the selection, including mixed sets. Unanswered events follow that membership within existing calendar/window filters. Clicking O preserves other statuses; no previous RSVP selection is saved/restored. Removing the last status returns `DEFAULT_RSVP_STATUSES`: O-only -> O returns defaults with O still pressed. Explicit empty host selections remain empty; host rerenders do not normalize membership or emit callbacks.

The Unaccepted badge is always visible, including at zero. It counts `needsAction` events from the controller's selected-calendar, rolling ±30-day snapshot before RSVP filtering. Visible counts cap at `99+`; the chip's `aria-label` and `title` expose the full count.

Built-in copy (overridable only through the slots above):

- Not connected: "Not connected to Google Calendar." with "Connect Google Calendar".
- Reauth: "Calendar connection needs reauthorization." with "Reconnect to restore sync".
- Error with nothing cached: "Couldn't load calendar events. Try again shortly."
- Loading: "Loading calendar…".
- Empty: "No matching events in the next 30 days".

#### Footer calendar selection

One footer combobox opens a shared searchable dropdown, with calendars grouped under account headings in multi-source use. Each account has its own Clear (primary, else first calendar) and filtered Select all, which adds matching calendars while retaining existing selections. Actions affect only their account; its last selected calendar cannot be deselected, including a non-primary selection.

The footer and standalone `CalendarSelector` share a padded, rounded trigger with a visible decorative chevron, themed hover surface and keyboard-only focus outline. Long labels ellipsize visually while retaining the full accessible name. This is a visual-only correction to the former native trigger geometry: click, native Enter/Space activation, search, keyboard navigation, Escape/Done focus return, combobox relationships and selection callbacks/rules are unchanged. The default footer remains 64px high, with the upward dropdown 6px above the trigger.

### CalendarSelector props

`calendars: CalendarInfo[]`, `selectedIds: string[]`, `onChange(ids)`, `heading?: string` (account heading in multi-source use), `theme?: 'system' | 'light' | 'dark'` (defaults to `'system'`, including when `undefined`). It has no slot props or `popupName`. At least one calendar stays selected (deselecting the last one is ignored). "Clear" resets to the primary calendar. Built-in copy: "Search calendars", "Select all", "Clear", "Done", "No calendars found", "No calendars available".

```tsx
import { CalendarSelector } from '@open-webapp/calendar';
import '@open-webapp/calendar/styles.css';

<CalendarSelector
  calendars={calendars}
  selectedIds={selectedIds}
  onChange={setSelectedIds}
  heading="me@example.com"
  theme="dark"
/>;
```

### Theme behavior

Timed meeting headers keep the time left and `[Join] [RSVP glyph]` right, with a 4px gap; title and organizer follow below. Join retains its text and fits it at an intrinsic width, matching the RSVP glyph's 24px outer height, 1px border, 4px radius and exact status foreground/background/border for accepted, tentative, needsAction and declined in every theme. Hover underlines Join; keyboard focus has a visible theme-colored outline. Without a meeting URL only the right-aligned RSVP glyph appears. The pair stays together when a narrow header wraps. Join keeps its original URL, new-tab attributes and click propagation behavior.

Both components follow the OS/browser `prefers-color-scheme` preference live in `'system'` mode; omitting `theme` preserves this default. Explicit `'light'` and `'dark'` ignore OS changes. Hosts can change the prop on a mounted component (including back to `'system'` or `undefined`) without remounting, closing an open dropdown, losing its search query, focus or keyboard-active option, changing selected calendars, or resetting the pane's current RSVP selection. Theme changes do not trigger selection callbacks or controller refreshes.

Each pane forwards its requested mode to its unified grouped footer selector, including both account groups, account-local actions and the shared search. The single-trigger structure and cross-account keyboard navigation are preserved; the approved trigger geometry exception is described above. Standalone selectors choose their own mode: an omitted/system selector follows the OS even inside an explicitly dark or light pane. Adjacent and nested instances can use opposite modes independently; no document/body theme switch is applied.

The host owns theme-picker UI and preference persistence (for example, saving a choice and passing it back as `theme`). The package neither stores the choice nor adds it to the controller. Hosts also own styling of `emptyState`, `sourceNotice` and `renderEventAction` slot content; give custom content explicit styles where needed rather than relying on the built-in palette.

The exported standalone selector keeps its single-list props and behavior; Select all adds only search matches while retaining existing selections.

### Host CSS

Day ribbon styling: each day's ribbon alternates between two tones by day parity (`data-parity="even|odd"`), set with `--calendar-day-ribbon-a` and `--calendar-day-ribbon-b`. Parity is stable across scroll, filtering and month boundaries, and the ribbon does not mark today. Labels center in the actual ribbon/viewport intersection below the measured chips and that day's header, including empty Today before an event day. Short ribbons center within their bounds. Scroll, resize, rendered-content and mounted theme changes update measurements; `--calendar-day-header-height` no longer positions the label.

`styles.css` is self-contained, using component-scoped semantic palette tokens and native-control `color-scheme`. Each pane/selector root resets the full palette; explicit dark overrides and system-only `prefers-color-scheme` rules keep instances isolated. It requires no host CSS variables. Layout/status variables:

- `--calendar-footer-height` (default `64px`, set on `.calendar-pane`; override to match host footer)
- `--chip-row-height` (fallback `44px`; host may set it to match its chip row for sticky headers)
- `--rsvp-bar` (set internally per RSVP status; do not override)

The Unaccepted count badge uses `.calendar-rsvp-chip-badge`, with light and dark styling included in `styles.css`.

The shared `.calendar-selector-trigger` uses border-box inline-flex, centered alignment, an 8px gap, 36px minimum height, 8px 12px padding, 6px radius, a 1px solid control border, inherited font and pointer cursor. `.calendar-selector-trigger-label` bounds long labels with ellipsis; `.calendar-selector-chevron` stays 12px and does not shrink or add a tab stop. Existing scoped surface/text/control-border tokens style the resting trigger, the hover token supplies its hover background, and the focus token supplies a 2px `:focus-visible` outline with 2px offset. This approved visual-only exception changes trigger geometry and its derived dropdown position, preserving surrounding layout and theme isolation. Import the shipped stylesheet for both footer and standalone use.

## 0.8.0 (BREAKING pre-1.0 minor)

- Unaccepted independently toggles `needsAction`, replacing the exclusive shortcut and local restoration introduced in 0.3.0. Hosts relying on pending-only callbacks or restoration must adapt to callbacks reflecting current membership.
- Defaults and last-deselection fallback remain accepted/tentative/needsAction; O is pressed for defaults and mixed selections containing needsAction.
- Ribbon labels center in the measured visible intersection, including empty Today, scrolling, resizing and mounted theme changes.

## 0.7.0 (minor, breaking-visual)

- Day ribbons alternate between two tones by day parity (`data-parity="even|odd"`, days since 1970 of the date key mod 2) instead of highlighting today. Parity is stable across scroll, filter and month boundaries.
- "Today" is now the browser's local date (previously UTC, which could be off by a day for users away from UTC). Sticky day header text ("Today · Oct 26") is unchanged.
- Migration: `--calendar-today-accent` was removed in 0.7.0; use `--calendar-day-ribbon-a` / `--calendar-day-ribbon-b`. The ribbon no longer marks today (`data-today` is now `data-parity`).

## 0.6.0 (minor, additive-visual)

- Each day has a thin vertical ribbon left of its events with a rotated `Mmm D` label; ribbons alternate tones by day parity (see 0.7.0). The sticky day header is unchanged.
- The RSVP status bar moved from the left edge to the right edge of event rows.
- New helper `formatRibbonLabel`.

## 0.5.1 (patch)

- Corrects footer and standalone selector affordance with a padded, rounded 36px-minimum trigger, decorative chevron, themed hover and keyboard-focus treatment, and long-label containment.
- Approved visual-only exception to native trigger geometry/surface treatment; the default 64px footer and 6px dropdown clearance are preserved. Public props, copy, accessible names/relationships, interactions, selection semantics, controller and storage/schema contracts are unchanged. No migration is required.

## 0.5.0 (minor, additive)

- Adds optional `theme?: 'system' | 'light' | 'dark'` to both React components, with live OS tracking by default and live per-instance overrides.
- Themes all built-in pane states and internal/standalone selectors while preserving existing palettes, layout, copy and interaction contracts. Existing callers need no migration.

## 0.4.0 (BREAKING pre-1.0 minor)

- CalendarPane replaces per-account footer triggers with one shared dropdown grouped by account. Hosts relying on multiple footer triggers must adapt. Account-local selection rules and the exported standalone CalendarSelector remain compatible.

## 0.3.0 (minor, additive)

- Added the Unaccepted exclusive shortcut after Accepted, Maybe, and Declined, with local selection restoration and default fallback. This historical behavior is superseded by the independent toggle in 0.8.0.
- Adds an always-visible Unaccepted count badge, including zero, computed before RSVP filtering from the controller's selected-calendar ±30-day snapshot. Counts above 99 display `99+`, with the full count in the chip's `aria-label` and `title`.
- Adds the `.calendar-rsvp-chip-badge` host styling hook. Public props and default RSVP statuses remain compatible.

## 0.2.1 (patch)

Fixes only, no behavior contract change: `getState().loading` is now published while a sync pass is in flight; a selection-change (partial) pass no longer clears `deferred` set by an earlier full pass; `CalendarPane` tolerates controllers without `getState`/`hydrate`.

## Breaking changes in 0.2.0

BREAKING (0.1.0 to 0.2.0):

- **Selection semantics.** Primary is no longer forced into the selection. Stored selections are honored (filtered to existing calendars). `setSelectedIds` no longer always adds primary, and an empty list is ignored. `clearSelectedIds` resets to primary.
- **Cache and storage rows.** `setSelectedIds` no longer drops events and sync tokens of deselected calendars; they are retained. `syncState` gains optional `lastFullSyncAt` and `lastSyncAt`. Window pruning and the read-time window filter are new. 0.1.0 rows still read (missing fields take their defaults).
- **Pane behavior.** `CalendarPane` gains `connected`, `needsReauth`, `onConnect`, `onReconnect`. Omitting `connected` keeps the old behavior (`sources.length > 0`). Deferred refreshes are quiet. `getState()` and `hydrate()` are new; hosts that want cache-first display should call `hydrate()` before `refresh()`.
- Unchanged: event key form (`src1:calA:ev1`), `sourceStatus` values, `StorageAdapter`/`CryptoAdapter` signatures.
