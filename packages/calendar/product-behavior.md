# Calendar product behavior

Source of truth: `notesdiary/product-behavior.md`, "Google Calendar" section. This file lists the parts the package implements ("Package") versus what the host app owns ("Host").

## Package

- Both `CalendarPane` and standalone `CalendarSelector` accept optional `theme?: 'system' | 'light' | 'dark'`. Omitted/undefined defaults to system and follows OS/browser color-scheme changes live; explicit light/dark ignore the OS.
- Theme changes on mounted components preserve dropdown open/search/focus/keyboard-active state, selected calendars and the pane's saved RSVP selection, without selection callbacks or controller refreshes. Every pane state and internal selector uses the pane's mode; standalone selectors choose independently. Adjacent/nested opposite-theme instances stay isolated, including system selectors under explicit-theme ancestors.
- Shipped CSS themes all built-in states and native controls with the existing palettes and layout, without a document/body theme switch or persisted theme state.
- Window: rolling 30 days back to 30 days ahead; empty state "No matching events in the next 30 days". Events are shown when they overlap the window (end after now-30d, start before now+30d).
- RSVP chips appear in order Accepted, Maybe, Declined, Unaccepted. Accepted, Maybe, and Declined toggle individual statuses; zero-selected snaps back to the default (accepted, tentative, needsAction).
- Unaccepted is an exclusive shortcut, pressed only for exactly `needsAction` (not a mixed selection containing it). Entering exclusive mode saves the previous selection locally in the pane; clicking again restores it, or the defaults if unavailable. Another chip toggles against the saved selection or defaults. An external nonexclusive selection clears the saved selection.
- Unaccepted always shows a count badge, including zero, counting `needsAction` events from the controller's selected-calendar ±30-day snapshot before RSVP filtering. Visible counts cap at `99+`; the chip's `aria-label` and `title` expose the full count. Badge CSS class: `.calendar-rsvp-chip-badge`.
- Scroll-to-today button; initial recenter on current -> next upcoming -> today; current-event highlight; idle autoscroll.
- Sticky RSVP row with day headers pinned beneath it (offset via `--chip-row-height`).
- Day headers: "Today · {Month Day}", "Tomorrow · {Month Day}", else "{Month Day}" (year when different); today always rendered.
- All-day events are banner rows; timed events show time range, optional "Join" link, title link to `htmlLink`, organizer label. Title opens a reused popup (`popupName`) on desktop (>=960px), new tab on mobile or with modifier/middle click; blocked popup falls back to a new tab.
- RSVP bar: 3px left bar (accepted green, tentative amber, declined rose, needsAction gray), light and dark.
- Calendar selector: one footer combobox opens a shared searchable dropdown with color dots and keyboard support, grouped under account headings for multiple accounts. Each account has Clear (resets to primary, else first) and filtered Select all (adds matches, retaining existing selections); neither affects other accounts. Each account's last selected calendar cannot be deselected, including a non-primary selection. The exported standalone selector keeps its single-list behavior. Non-primary calendar events show calendar name with dot; event identity is source + calendar + event id.
- Selection: primary is the default but not forced. A saved selection is kept as long as its calendars exist; if none remain, the selection falls back to primary (else first). Newly selected calendars are fetched right away.
- Deselected calendars keep their cached events; they reappear immediately when re-selected.
- Organizer label: display name, else email, else "You" for self; suppressed if equal to the shown calendar name.
- Cache first: stored events show before the network call, and stay visible offline.
- Sync: failed calendars keep cached events/tokens and are retried once; "Couldn't load calendar events. Try again shortly." only when every selected calendar failed and nothing is cached.
- Full windowed sync when there is no sync token, no prior full sync, or the last full sync is over 24h old; otherwise incremental via syncToken. 410 triggers a full windowed refresh.
- Deferred refreshes are silent: no error banner, no status change; the host retries later.
- Cached events remain available offline; payloads encrypted via the host `CryptoAdapter`.
- Multi-source: events from several accounts merged, per-source color/email; per-source status (`ok | needs-scope | error`); all sources `needs-scope` shows the reauth prompt.

## Host

- Theme-picker UI, preference persistence and passing the saved choice through the `theme` prop. Styling custom `emptyState`, `sourceNotice` and `renderEventAction` slot content remains host-owned, including explicit colors where needed.
- 📅 toggle, desktop auto-open, mobile overlay and close button, connect/reconnect prompts (`connected`, `needsReauth`, `onConnect`, `onReconnect`, or the `emptyState`/`sourceNotice` slots), insert-link action (`renderEventAction`), 10-minute refresh cadence and focus catch-up, per-project storage and migration, disconnect cache clearing, token acquisition.
