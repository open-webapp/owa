# drive-connect — product behavior

Structure / API / data flow: see `design.md`.

Scope: user-visible behavior of `<GoogleDriveWidget />` and the `DriveAuthHandle` it reads (`auth.ts`).

## Widget render states

`<GoogleDriveWidget />` renders exactly one state block, driven by `connected` + `needsReauth` from `useDriveConnection`. Root element: `<div class="owa-drive-root">`.

| State | Condition | Rendered markup |
|-------|-----------|-----------------|
| Disconnected | `!connected && !needsReauth` | `<button type="button" class="owa-drive-connect">Connect Google Drive</button>` |
| Connecting | same as Disconnected, while `connecting` | same button, `disabled`, label `Connecting…` (U+2026) |
| Connected | `connected && !needsReauth` | `<p class="owa-drive-status">Connected as <span class="owa-drive-email">{email}</span></p>` then `<button type="button" class="owa-drive-disconnect">Disconnect</button>` |
| Needs reauth | `connected && needsReauth` | `<div class="owa-drive-reauth">Reconnect to restore sync<button type="button" class="owa-drive-connect">Reconnect</button></div>` |

- `Connecting…` label appears only in the Disconnected block. In Connected / Needs-reauth blocks the button keeps its label (`Disconnect` / `Reconnect`) and only goes `disabled` while `connecting`.
- Needs-reauth state shows no `Connect Google Drive` button.
- `needsReauth` can be true while a connection still exists — widget shows the reauth prompt; sync stays broken until Reconnect succeeds.

## Buttons

- All three buttons are native `<button type="button">` — Tab to focus, Enter/Space to activate. No custom key handling. `Disconnect` is a real button, not a `<span onClick>`.
- All three are `disabled` while `connecting` is true.
- Connect / Reconnect → `auth.connect()`; on success fires `onConnected(connection)`.
- Disconnect → `auth.disconnect()`; on success fires `onDisconnected()`.
- Failure of either handler is swallowed by the widget (no throw to user); the error is surfaced via the status store instead (see Errors).

## Optional description slot

- If the `description` prop is non-null, renders `<div class="owa-drive-description">{description}</div>` after all state/error output. Arbitrary `ReactNode`.

## Errors

- Any interactive failure renders inline as exactly one `<p class="owa-drive-error" role="alert">{message}</p>`, below the current state block.
- The package NEVER calls `window.alert`.
- After a failed connect: status resets to disconnected + error; the `Connect Google Drive` button re-enables.
- After a failed disconnect: widget still shows the Connected state; only `connecting`/`error` change, so the account is not visually dropped. Error `<p>` shows alongside the connected markup.
- Connect timeout message: `Google auth timed out`.
- Connect resolving with no connection: `No connection returned from Google Drive`.
- A closed OAuth popup that drive-sync recovers from silently → connect still succeeds, no error shown. A popup-closed / auth error drive-sync cannot recover from → its message shows inline next to the re-enabled Connect button; drive-connect adds no retry of its own.

## Status-freshness triggers

Status is push-updated, not polled or re-read. It comes from drive-sync's connection-snapshot subscription (`drive.project(id).subscribeConnection`) fanned in with the local `{connecting, error}` overlay by an internal helper reachable only through the `useDriveConnection` React hook — there is no standalone `auth.subscribe()` any more.

The widget's status refreshes when:

- The drive-sync snapshot changes after any `connect()`/`disconnect()` — this tab's own, or another tab's. For this tab's own call, the re-read is already `await`ed by drive-sync before `connect()`/`disconnect()` resolves, so there is nothing left to wait for.
- Drive-sync's background warm-up runs (wired via `activate()`).
- A cross-tab logout/token broadcast arrives (**new:** cross-tab logout now propagates to the widget — disconnecting in one tab is reflected in another tab's widget).

`tokenValid` updates on that same notify cadence rather than being recomputed continuously — it is frozen between notifies (last connect/disconnect/warm-up/broadcast) rather than recomputed on every render.

There is no mount re-read, no `visibilitychange` handler in the widget, and no `auth.refresh()` — none of those exist any more. Warm-up/visibility handling lives entirely in drive-sync's `activate()`, host-wired.

## Edge cases

- Double-click Connect → one Google popup. `connect()` and `ensureFresh()` share one in-flight guard per handle, so concurrent interactive requests fold into one flow.
- Interactive connect that does not resolve within 10s → rejects with `Google auth timed out`; status returns to disconnected.
- Token-runway buffer `tokenBufferMs` (default 5 min): `ensureFresh()` returns the cached connection without any interactive call only if it is not `needsReauth`, has a real `expiresAt`, and `expiresAt` is strictly greater than `Date.now() + tokenBufferMs`. Otherwise it opens an interactive connect.
- Cross-tab logout: disconnecting in another tab now flips this tab's widget to the disconnected state (via drive-sync's `logout` broadcast) while `auth.activate()` is wired.
- `tokenValid` can be briefly stale between notifies (frozen at the last connect/disconnect/warm-up/broadcast), not recomputed on every render — acceptable given the existing token buffer.

## Host-readable status

`DriveAuthHandle` no longer exposes `getStatus()` or `subscribe()` — status is readable **only** through the `useDriveConnection(auth)` React hook, which surfaces `connected`, `email`, `connecting`, `error`, `needsReauth` (`refresh` removed).

A non-React host previously could call `auth.getStatus()`/`auth.subscribe()` directly; that capability is gone. A non-React host must now read `drive.project(id).getConnectionSync()`/`subscribeConnection()` itself and build its own `tokenValid`/overlay merge — drive-connect provides no equivalent outside React.

`DriveAuthStatus` (the hook's underlying return shape) is unchanged in its 5-field meaning (`connected`, `email`, `connecting`, `error`, `needsReauth`).

## Class-name hooks

Package classes (host classes prepended via `classNames` prop): `owa-drive-root`, `owa-drive-connect`, `owa-drive-status`, `owa-drive-email`, `owa-drive-disconnect`, `owa-drive-reauth`, `owa-drive-error`, `owa-drive-description`.
