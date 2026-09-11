# @open-webapp/drive-connect

React + plain-TypeScript library for the Google Drive **auth** lifecycle of a
single-user webapp: connect / disconnect, token freshness, status subscription,
and a drop-in connect widget. Extracted from portfolio's `DriveRestorePanel`
and notesdiary's `SettingsView` drive block, which each had their own fork of
this logic.

The library owns **auth only**. It knows nothing about synced content: no
codec / encryption, no Picker, no restore / conflict / merge, no
`SyncDocument`, no backup-file lookup. The host builds the drive-sync facade
itself with `createDriveSync(...)` and passes it in; content work happens in the
host's `onConnected` / `onDisconnected` callbacks.

## Install

```sh
npm i @open-webapp/drive-connect@^0.2.0 @open-webapp/drive-sync@^0.8.0 react@^19
```

Both peers are required (non-optional). Pin `^0.2.0` — see
[Install from npm](#install-from-npm).

## Usage

```tsx
import { useEffect } from 'react'
import { createDriveSync } from '@open-webapp/drive-sync'
import {
  createDriveAuth,
  useDriveConnection,
  GoogleDriveWidget,
} from '@open-webapp/drive-connect'
import '@open-webapp/drive-connect/styles.css'

// 1. The host builds the drive-sync facade itself.
const drive = createDriveSync({
  appId: 'my-app',
  clientId: 'xxx.apps.googleusercontent.com',
  folderPath: ['MyApp', 'Data'],
})

// 2. drive-connect wraps it with an auth-only handle for one project.
const driveAuth = createDriveAuth({
  drive,
  projectId: 'default',
  // tokenBufferMs?: number         — default 5 * 60 * 1000
  // beforeInteractive?: <T>(fn: () => Promise<T>) => Promise<T>
  //   wraps interactive connect/disconnect only; default identity.
  //   notesdiary passes `withReloadSuppressed`; portfolio passes nothing.
})

function DriveSettings() {
  // Warm-up is host-wired — see the note below.
  useEffect(() => driveAuth.activate(), [driveAuth])

  const { connected, email, connecting, error, needsReauth } =
    useDriveConnection(driveAuth)
  // Status updates arrive automatically — this tab's own connect()/disconnect(),
  // drive-sync's background warm-up, and cross-tab logout/token broadcasts all
  // push a re-render with no manual refresh call.

  return (
    <GoogleDriveWidget
      auth={driveAuth}
      onConnected={(connection) => {
        // host content work, e.g. portfolio's backup-file-id lookup
      }}
      onDisconnected={() => {
        // host cleanup
      }}
      description="Sync your data across devices."
    />
  )
}

// 3. Plain module code — call ensureFresh() before any Drive I/O.
async function saveToDrive(json: string): Promise<void> {
  const connection = await driveAuth.ensureFresh()
  // cached-token fast path: no popup, no beforeInteractive, no store write
  // when the token still has runway; otherwise runs the interactive connect().
  // ... now write with a fresh token.
}
```

### `createDriveAuth(options): DriveAuthHandle`

`DriveAuthOptions` = `{ drive, projectId, tokenBufferMs?, beforeInteractive? }`.

`DriveAuthHandle`:

| Member | Interactive? | Notes |
|---|---|---|
| `connect()` | yes | races a 10s `Error('Google auth timed out')`; on failure the overlay records the error, on success drive-sync's own awaited snapshot re-read means status is already current |
| `disconnect()` | yes | leaves connected status intact on failure |
| `ensureFresh()` | maybe | cached-token fast path, else `connect()` — the call plain module code makes before Drive I/O |
| `activate()` | no | host-called passthrough to `drive.activate()`; returns a disposer |

That's the whole interface — `getStatus()`, `subscribe()`, and `refresh()` are
**all** removed. `DriveAuthHandle` exposes no way to read or subscribe to
status any more; the only supported way to read live status is
`useDriveConnection(auth)`. A non-React host must read
`drive.project(id).getConnectionSync()` / `subscribeConnection()` directly and
build its own merge — see
[Migrating from 0.1.x](#migrating-from-01x).

One `connectInFlight` guard per handle is shared by `connect()` and
`ensureFresh()` — two concurrent callers open **one** Google popup. Status
updates arrive automatically via drive-sync's connection-snapshot
subscription and drive-sync's own `activate()`-driven warm-up/cross-tab
broadcasts — no mount re-read, no `visibilitychange` handler in this package.

`DriveAuthStatus` = `{ connected, email, expiresAt, needsReauth, tokenValid,
connecting, error }` — the hook's underlying shape, unchanged.

### `useDriveConnection(auth)`

`useSyncExternalStore`-backed, no mount side effects. Returns
`{ connected, email, connecting, error, needsReauth }`.

### `<GoogleDriveWidget auth ... />`

`GoogleDriveWidgetProps` = `{ auth, onConnected?, onDisconnected?, classNames?,
description? }`. Renders four states (not connected / connecting /
connected + Disconnect / connected + needsReauth + Reconnect). Errors render
inline via `role="alert"` — never `window.alert`. The widget never re-reads
status itself and **never** calls `auth.activate()` — it only renders whatever
`useDriveConnection` currently reports, which updates automatically.
`onConnected(connection)` and `onDisconnected()` let the host do its own
content work.

`Connection` is re-exported from `@open-webapp/drive-sync` for typing the
`onConnected` / `ensureFresh` / `connect` result.

## Styling

```ts
import '@open-webapp/drive-connect/styles.css'
```

Classes: `owa-drive-{root,connect,status,email,disconnect,reauth,error,description}`.
No `:root` block ships — every value is `var(--owa-drive-<token>, <fallback>)`,
so the stylesheet works unthemed and hosts override tokens as needed.

| Token | Controls | Fallback |
|---|---|---|
| `--owa-drive-fg` | primary text / foreground | `#1a1a1a` |
| `--owa-drive-muted` | Disconnect link + description text | `#666` |
| `--owa-drive-accent` | Connect / Reconnect button background | `#1a73e8` |
| `--owa-drive-accent-fg` | Connect / Reconnect button text | `#ffffff` |
| `--owa-drive-danger` | inline error text | `#b00020` |
| `--owa-drive-gap` | `owa-drive-root` flex gap + button padding | `8px` |
| `--owa-drive-radius` | Connect button corner radius | `6px` |
| `--owa-drive-font` | `font` shorthand for all text | `inherit` |

### `classNames` prop bag (`DriveWidgetClassNames`)

Per-element host classes, merged with (not replacing) the package class — the
host class is prepended, the `owa-drive-*` class always stays. Keys: `root`,
`status`, `email`, `connectButton`, `disconnectButton`, `reauth`, `error`,
`description`.

## Notes

### Warm-up is yours to wire

`activate()` is **host-called** and returns a disposer; the widget never calls
it. Wire it from the host:

```tsx
useEffect(() => driveAuth.activate(), [driveAuth])
```

An app may delay it — e.g. until after a password unlock — since the widget can
mount before unlock.

Wiring `drive.activate()` is now also what keeps the widget's connection
status fresh: it drives drive-sync's visibility-based warm-up and cross-tab
broadcast handling, both of which push a snapshot-change notify that
`useDriveConnection` observes. Without it, the widget still updates on this
tab's own `connect()`/`disconnect()` (drive-sync awaits that snapshot re-read
before those calls resolve), but **not** on cross-tab events or background
token refresh.

### Install from npm

Consume the published package and pin `^0.2.0`. No `file:` / workspace-link
consumption.

### Popup-closed recovery is drive-sync's job

drive-connect surfaces auth errors as-is. drive-sync already handles
popup-closed recovery internally — don't add app-level retries on top.

### Migrating from 0.1.x

- `auth.refresh()` / `useDriveConnection(auth).refresh` are removed.
- `auth.getStatus()` / `auth.subscribe()` are **also** removed —
  `useDriveConnection(auth)` is now the only supported way to read status. A
  non-React host must hand-roll its own merge over
  `drive.project(id).getConnectionSync()` / `subscribeConnection()`.
- Delete any host code calling the removed methods.
- Make sure `drive.activate()` is wired (see above) for cross-tab and warm-up
  freshness — without it the widget only updates on its own `connect()`/`disconnect()`.
- Bump `@open-webapp/drive-sync` to `^0.8.0`.

---

See `design.md` and `product-behavior.md` (shipped in the package) for the full
API contract and user-visible behavior.
