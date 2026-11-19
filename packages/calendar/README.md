# @open-webapp/calendar

Multi-account Google Calendar read-only sync (controller) plus React UI (`CalendarPane`, `CalendarSelector`). Storage and encryption are host-supplied adapters.

> **0.14.0 is additive and non-breaking.** The event details overlay is redesigned, and the optional `onRsvpChange` prop lets the host write RSVP changes. See [0.14.0](#0140-minor-additive-non-breaking).
>
> **0.13.0 is BREAKING.** Clicking an event title now opens an in-pane event details overlay instead of a popup window. See [0.13.0](#0130-breaking-pre-10-minor).
>
> **0.12.0 is BREAKING.** See [0.12.0](#0120-breaking-pre-10-minor) for exclusive Unaccepted filtering and new RSVP defaults.
>
> **0.10.0 is BREAKING.** See [0.10.0](#0100-breaking-pre-10-minor) for the approved CalendarPane selector-popup geometry correction.

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
| `selectedRsvpStatuses` | `Set<RsvpStatus>` | host-controlled filter; `DEFAULT_RSVP_STATUSES` = accepted, tentative (O unpressed) |
| `onRsvpStatusesChange` | `(next) => void` | |
| `renderEventAction?` | `(event) => ReactNode` | per-event slot |
| `connected?` | `boolean` | defaults to `sources.length > 0` (back-compat). `false` shows the not-connected block |
| `needsReauth?` | `boolean` | defaults to every source being `needs-scope`. Shows the reauth block |
| `onConnect?` | `() => void` | wired to the built-in "Connect Google Calendar" button |
| `onReconnect?` | `() => void` | wired to the built-in "Reconnect to restore sync" button |
| `emptyState?` | `ReactNode` | replaces the built-in not-connected block |
| `sourceNotice?` | `(source) => ReactNode` | per-source slot, rendered for `needs-scope` sources (e.g. re-consent button); without it the built-in reauth block is shown |
| `onClose?` | `() => void` | |
| `popupName?` | `string` | `window.open` name for the event popup window (default `notesdiary-cal-event`). The popup now opens only from the overlay's "Open in Google Calendar" link |
| `onRsvpChange?` | `(event: CalendarEvent, status: RsvpStatus) => Promise<void>` | 0.14.0. Host-owned RSVP writer. When absent, the overlay has no "Change RSVP" row. The package never writes to Google itself. See [Change RSVP](#change-rsvp-onrsvpchange) |

#### Event details overlay

A plain left click on an event title opens a bottom-sheet overlay inside the pane (`role="dialog"`, `aria-modal="true"`). The sheet is laid out like the event card, but larger, top to bottom:

1. Top row, same information as the card: time range (or `All day`), Join (only when `joinUrl` is set), a read-only RSVP status, and the close (×) button.
2. Title (the dialog's accessible name, an `h2`).
3. Organizer row: the label "Organizer", the organizer label, and "(you)" when `organizer.self` is true. Hidden when there is no organizer label.
4. Calendar line: calendar color dot, calendar name, source (account) label, and location when set.
5. Description: plain text (HTML is stripped), with links kept clickable.
6. Invitees (see [Invitee rules](#invitee-rules)).
7. Change RSVP (see [Change RSVP](#change-rsvp-onrsvpchange)).
8. "Open in Google Calendar" link (only when `htmlLink` is set).

- Close with Escape, the close (X) button, or a click on the backdrop. Focus is trapped inside the sheet while it is open, starts on the sheet, and returns to the title that opened it when it closes.
- Modified clicks (ctrl, cmd, shift, alt, or middle click) keep the native new-tab behavior of the title link.
- Events without an `htmlLink` still open the overlay. The "Open in Google Calendar" link is hidden for them.
- There is no prop to opt out. Hosts that relied on the title click opening a popup window must use the overlay's link or handle the click themselves.
- The time-range formatting is the same as the event card's.

##### Invitee rules

- The heading reads `Invitees (N)`, where N is the total number of attendees.
- The summary line counts each status: `yes` (accepted), `maybe` (tentative), `awaiting` (needs action, and any unknown status), `no` (declined), joined with ` · `. Zero buckets are omitted, so the summary reads, for example, `2 yes · 1 maybe · 1 awaiting`. An empty attendee list gives an empty summary.
- Order: the organizer first, then you (self), then accepted, tentative, needs action, declined. Within each status, rows sort by name (display name, else email), case-insensitively. An organizer who is also you appears once, first.
- Tags: `Organizer` on the organizer's row and `(you)` on your row. Every row shows its status glyph and label (Accepted, Maybe, Declined, Unaccepted). An attendee without a display name shows the email.
- At most 10 rows show at first. A `Show all N` button expands the list in place and changes to `Show fewer`. It sets `aria-expanded`.

##### Hidden-row matrix

| Case | Invitees | Change RSVP | Organizer row |
| --- | --- | --- | --- |
| No attendees | hidden | hidden | shown when there is an organizer label |
| Only you are listed | hidden | hidden | shown when there is an organizer label |
| You are not invited (no attendee is `self`) | shown | hidden | shown when there is an organizer label |
| Invited, no `onRsvpChange` | shown | hidden | shown when there is an organizer label |
| Invited, `onRsvpChange` provided | shown | shown | shown when there is an organizer label |

##### Change RSVP (`onRsvpChange`)

`onRsvpChange` is an optional prop on `CalendarPane`. The host does the write; the package makes no Google request for it and asks for no new OAuth scopes. Recurring events are handled per instance: the `event` passed to the host is the instance the user opened.

- The row is a radiogroup labeled "Change RSVP" with three options: Yes (accepted), Maybe (tentative), and No (declined). Unaccepted is not offered. Each option is a radio with `aria-checked`. Arrow keys move between options. The row shows only when the prop is set, you are an attendee, and the event has attendees.
- Choosing an option calls `onRsvpChange(event, status)` once. Choosing the already selected option still calls it, so a host can rely on one call per click.
- Optimistic update: the overlay and the event card show the new status at once. The options are disabled while the write is pending, and a live region reads "Updating RSVP...".
- Success: the override stays until a controller refresh delivers that event, so the server's status takes over then. If the new status is hidden by the RSVP filter chips, the overlay stays open, and the card leaves the list only after the overlay closes. Changing filter chips still closes the overlay, as before.
- Failure: if the promise rejects or throws, or does not settle within **60 seconds** (`RSVP_PENDING_TIMEOUT_MS = 60000`), the previous status comes back and the live region shows "Couldn't update RSVP. Retry". Retry sends the last chosen status again. A result that arrives after the timeout is ignored. The timer is not cleared by closing the overlay, so a timed-out write still rolls back. In that case no error message shows, because the overlay is closed.
- The overlay's status and the card's status come from the same override, so both change together.

Host example. The host owns the token and the Google request. Fetch the event, change only your own attendee entry, then patch the attendee list:

```tsx
<CalendarPane
  // ...other props
  onRsvpChange={async (event, status) => {
    const token = await getAccessToken(event.sourceId); // host-owned token
    const calendarId = encodeURIComponent(event.calendarId ?? 'primary');
    const eventUrl = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(event.id)}`;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const current = await fetch(eventUrl, { headers }).then((r) => {
      if (!r.ok) throw new Error(`GET event failed: ${r.status}`);
      return r.json();
    });
    const attendees = (current.attendees ?? []).map((a: { self?: boolean; responseStatus?: string }) =>
      a.self ? { ...a, responseStatus: status } : a,
    );

    const res = await fetch(`${eventUrl}?sendUpdates=all`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ attendees }),
    });
    if (!res.ok) throw new Error(`PATCH event failed: ${res.status}`); // rejects, so the overlay rolls back
  }}
/>
```

Google's `responseStatus` values match `RsvpStatus` for the three options (`accepted`, `tentative`, `declined`). Choose `sendUpdates` to match your notification policy.

##### Footer-safe overlay

- When the pane renders its footer (`.calendar-pane--has-footer`, which needs calendars), the backdrop and sheet stop at the footer's top edge. The footer stays visible, undimmed, and clickable. Without a footer, the overlay covers the whole pane.
- The footer height comes from `--calendar-footer-height` (default `64px`). If the host changes the footer height, set this variable on `.calendar-pane` to match.
- The sheet's maximum height is 80% of the area above the footer, and it scrolls internally.
- A click on the footer while the overlay is open closes the overlay, and the footer action still runs (for example, the calendar dropdown opens). Focus does not return to the title in that case, because the footer action takes focus.

`CalendarEvent` gains optional fields used by the overlay: `location?: string`, `description?: string` (HTML is converted to plain text for display), and `attendees?: CalendarEventAttendee[]`, where `CalendarEventAttendee` is `{ email: string; displayName?: string; responseStatus: RsvpStatus; self?: boolean; organizer?: boolean }`. Missing fields are simply not shown.

#### RSVP chips

The chips appear in order: Accepted, Maybe, Declined, Unaccepted (O). Accepted, Maybe and Declined independently toggle current supplied membership. Defaults are accepted and tentative, so O is unpressed by default.

O is an exclusive shortcut: clicking it saves the current RSVP selection and selects only `needsAction`. Clicking O again restores that saved selection. O is pressed only when `needsAction` is the sole selected status. Unanswered events follow the active membership within existing calendar/window filters. Explicit empty host selections remain empty; host rerenders do not normalize membership or emit callbacks.

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

In a `CalendarPane`, the upward dropdown now starts at the trigger's left edge and fits the pane's existing 16px footer-content inset. Its usual 220px minimum and 320px maximum yield to the available pane width when necessary. While it is open, the entire popup is limited to the pane/viewport space above the trigger after the preserved 6px clearance; search and actions stay reachable while the options list shrinks and scrolls (retaining its 240px cap when space allows). Geometry updates without closing the popup or resetting its query when its pane/root, window, scroll position, query, groups or theme layout changes. This is a popup-only change: it does not impose a pane root height or repair a separately unconfirmed missing-footer symptom. Standalone `CalendarSelector` placement, normal width and 240px listbox cap are unchanged.

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

Each pane forwards its requested mode to its unified grouped footer selector, including both account groups, account-local actions and the shared search. The single-trigger structure and cross-account keyboard navigation are preserved; the approved trigger geometry and action-only styling exceptions are described here. Standalone selectors choose their own mode: an omitted/system selector follows the OS even inside an explicitly dark or light pane. Adjacent and nested instances can use opposite modes independently; no document/body theme switch is applied.

The host owns theme-picker UI and preference persistence (for example, saving a choice and passing it back as `theme`). The package neither stores the choice nor adds it to the controller. Hosts also own styling of `emptyState`, `sourceNotice` and `renderEventAction` slot content; give custom content explicit styles where needed rather than relying on the built-in palette.

The exported standalone selector keeps its single-list props and behavior; Select all adds only search matches while retaining existing selections.

### Day headers

Sticky day headers show `Today · Sunday`, `Tomorrow · Monday`, or just the full English weekday for other dates. The weekday follows the date key without timezone shifts, including across year boundaries; Today remains the browser-local date. Vertical ribbon labels continue to show Month Day (for example, `Oct 26`), with the existing layout and styling.

### Host CSS

Day ribbon styling: each day's ribbon alternates between two tones by day parity (`data-parity="even|odd"`), set with `--calendar-day-ribbon-a` and `--calendar-day-ribbon-b`. Parity is stable across scroll, filtering and month boundaries, and the ribbon does not mark today. Labels center in the actual ribbon/viewport intersection below the measured chips and that day's header, including empty Today before an event day. Short ribbons center within their bounds. Scroll, resize, rendered-content and mounted theme changes update measurements; `--calendar-day-header-height` no longer positions the label.

`styles.css` is self-contained, using component-scoped semantic palette tokens and native-control `color-scheme`. Each pane/selector root resets the full palette; explicit dark overrides and system-only `prefers-color-scheme` rules keep instances isolated. It requires no host CSS variables. Layout/status variables:

- `--calendar-footer-height` (default `64px`, set on `.calendar-pane`; override to match host footer)
- `--chip-row-height` (fallback `44px`; host may set it to match its chip row for sticky headers)
- `--rsvp-bar` (set internally per RSVP status; do not override)

The Unaccepted count badge uses `.calendar-rsvp-chip-badge`, with light and dark styling included in `styles.css`.

Event details overlay (0.13.0, footer-safe and redesigned in 0.14.0): `.calendar-event-details` is the backdrop (absolutely positioned inside the pane root, dimmed, bottom-aligned). In a pane with a footer, `.calendar-pane--has-footer > .calendar-event-details` sets `bottom: var(--calendar-footer-height)` so the footer is not covered. `.calendar-event-details-sheet` is the bottom sheet (max 80% of the area above the footer, scrolls internally). Both use the pane's palette tokens, so they follow the pane's `theme`. The overlay is positioned against the nearest positioned ancestor, so the pane root must stay positioned.

Overlay hooks (0.14.0). Layout: `-grabber`, `-toprow`, `-time`, `-close`, `-header`, `-title`, `-dot`, `-body`. Sections: `-organizer`, `-calendar`, `-location` (span inside `-calendar`), `-description`, `-invitees` (contains `h3`, `-invitee-summary`, `ul`/`li`), `-tag` (Organizer and (you) tags), `-rsvp` (contains `[role='radiogroup']`, `[role='radio']` with `aria-checked`, and `-rsvp-status` for the live region), `-open`. The per-row status pill uses the shared `.calendar-event-rsvp` and `.calendar-event-rsvp--{status}` classes. The 0.13.0 `-when`, `-actions` and `-attendees` section classes are no longer rendered. Disabled RSVP options carry the native `disabled` attribute and the `:disabled` style.

The `--calendar-footer-height` variable is the one host value the overlay reads. Keep it equal to the host's footer height when the footer is changed.

The shared `.calendar-selector-trigger` uses border-box inline-flex, centered alignment, an 8px gap, 36px minimum height, 8px 12px padding, 6px radius, a 1px solid control border, inherited font and pointer cursor. `.calendar-selector-trigger-label` bounds long labels with ellipsis; `.calendar-selector-chevron` stays 12px and does not shrink or add a tab stop. Existing scoped surface/text/control-border tokens style the resting trigger, the hover token supplies its hover background, and the focus token supplies a 2px `:focus-visible` outline with 2px offset. The default 64px footer and 6px upward clearance remain unchanged. Only pane dropdowns use the approved trigger-left, pane-inset and available-height exception; standalone selectors retain their existing right-aligned 220px-to-320px geometry and 240px options cap. Import the shipped stylesheet for both footer and standalone use.

Done, Select all and Clear use the approved action-only flat styling via `.calendar-selector-actions > button` in standalone and grouped footer dropdowns: transparent resting background, zero border, no shadow, inherited font, `--calendar-selector-text` color and pointer cursor. Hover uses `--calendar-hover`; pointer focus has no decorative outline, while keyboard `:focus-visible` uses a 2px solid `--calendar-focus` outline with 2px offset. Action padding, row flex layout and 8px gap/top/bottom margins, footer/dropdown geometry, trigger/search/option styling, other native controls and all selection, callback and focus-return contracts are preserved.

## 0.14.2 (patch)

- The overlay top row carries the card's `calendar-event-row--rsvp-{status}` class so the Join link gets the same status-coloured styling as on the card. The Organizer row under the title is dropped when the invitee list is shown (the organizer is tagged in the list), and invitee statuses use the card's icon-only status badge instead of a text pill. No API change.

## 0.14.1 (patch)

- The event details overlay top row now reuses the event card's markup and classes (`calendar-event-header`, `calendar-event-time`, `calendar-event-actions`, `calendar-event-join`, and the same RSVP status icon), so Join and the RSVP badge look identical to the card. The close button sits at the end of the actions group. No API change.

## 0.14.0 (minor, additive, non-breaking)

- Additive only. No existing prop, return value, thrown error, storage field or contract test changed. No migration is required. The version bump is 0.13.0 to 0.14.0.
- Event details overlay redesigned: a top row matching the card (time or `All day`, Join, read-only RSVP status, close), then title, Organizer, calendar and location, description, Invitees, Change RSVP, and "Open in Google Calendar".
- Invitees section: `Invitees (N)`, a summary line (`yes`, `maybe`, `awaiting`, `no`), and a sorted list with Organizer and (you) tags. Ten rows show first, with a `Show all N` button that expands in place.
- New optional `onRsvpChange?: (event, status) => Promise<void>` prop on `CalendarPane`. The host performs the Google write with its own token. The package makes no Google write and requests no new scopes. Without the prop, the overlay has no Change RSVP row.
- RSVP changes are optimistic: the overlay and card update at once. A rejected or timed-out (60 seconds) write rolls back and shows "Couldn't update RSVP. Retry", with Retry resending the last status.
- The overlay is footer-safe. With a footer rendered, the footer stays visible and clickable above the overlay, and the overlay height is limited by `--calendar-footer-height`.
- New and renamed overlay CSS hooks are listed under [Host CSS](#host-css). `-when`, `-actions` and `-attendees` are no longer rendered.

## 0.13.0 (BREAKING pre-1.0 minor)

- Plain left click on an event title opens an in-pane event details overlay (bottom sheet, `role="dialog"`, `aria-modal`) instead of the event popup window. It closes with Escape, the X button or the backdrop, traps focus while open and returns focus to the title on close.
- The overlay shows time, calendar, organizer, Join and RSVP, location, plain-text description, and the first 10 attendees, with an "Open in Google Calendar" link.
- The `popupName` popup window now opens only from that link. Modified clicks (ctrl/cmd/shift/alt/middle) keep the native new-tab behavior. Events without `htmlLink` open the overlay too.
- `CalendarEvent` gains optional `location`, `description` and `attendees` (`CalendarEventAttendee[]`). Existing rows without them still read.
- New host CSS hooks: `.calendar-event-details` and `.calendar-event-details-sheet`.
- Breaking for hosts relying on the title click opening a popup. There is no opt-out prop. No storage migration is required.

## 0.12.0 (BREAKING pre-1.0 minor)

- Unaccepted (O) is again an exclusive `needsAction` shortcut. It saves the current RSVP selection when enabled and restores it when disabled; it is no longer an independent toggle.
- `DEFAULT_RSVP_STATUSES` now contains only accepted and tentative, so O is unpressed by default.
- Hosts that persist RSVP selections, including selections containing `needsAction`, must adapt to the exclusive O and new-default behavior.

## 0.11.1 (patch)

- Pin the storage contract harness's injected controller clock near its literal legacy fixtures so adapter checks remain deterministic as the wall clock advances. Regression coverage runs the contract with wall clocks in 2000 and 2100.

## 0.10.0 (BREAKING pre-1.0 minor)

- Approved CalendarPane selector-popup geometry correction: the upward popup is aligned to the trigger's left edge, adapts to the pane's 16px content inset, and uses the pane/viewport space above the trigger as its complete height budget. Options shrink and scroll before search/actions become inaccessible.
- The default 64px footer, 36px-minimum trigger and 6px upward clearance are preserved. There is no pane-height/fill change and no missing-footer fix. Standalone selector geometry, public API, selection/data behavior and storage schema are unchanged; no migration is required.

## 0.9.0 (BREAKING pre-1.0 minor)

- User-approved replacement of the frozen native dropdown-action appearance: Done, Select all and Clear are flat and themed with hover and keyboard-focus treatment as described above. Hosts relying on the former native action appearance must adapt. Other visual, interaction, public API and storage contracts are preserved; no data migration is required.

## 0.8.0 (BREAKING pre-1.0 minor)

- Unaccepted independently toggled `needsAction` at this release. This behavior changed in 0.12.0.
- Defaults and last-deselection fallback were accepted/tentative/needsAction at this release.
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

- Added the Unaccepted exclusive shortcut after Accepted, Maybe, and Declined, with local selection restoration and default fallback. The exclusive shortcut behavior returns in 0.12.0.
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
