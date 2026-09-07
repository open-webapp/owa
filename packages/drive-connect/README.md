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
npm i @open-webapp/drive-connect@^0.1.0 @open-webapp/drive-sync@^0.6.0 react@^19
```

Both peers are required (non-optional). Pin `^0.1.0` — see
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

  const { connected, email, connecting, error, needsReauth, refresh } =
    useDriveConnection(driveAuth)

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
| `getStatus()` | no | current `DriveAuthStatus` |
| `subscribe(fn)` | no | returns an unsubscribe fn |
| `refresh()` | no | recompute status from the stored connection; public so hosts can call it after their own Drive op hits `NeedsReauthError` |
| `connect()` | yes | races a 10s `Error('Google auth timed out')`; on failure clears status to disconnected + error, on success refreshes status |
| `disconnect()` | yes | leaves connected status intact on failure |
| `ensureFresh()` | maybe | cached-token fast path, else `connect()` — the call plain module code makes before Drive I/O |
| `activate()` | no | host-called passthrough to `drive.activate()`; returns a disposer |

One `connectInFlight` guard per handle is shared by `connect()` and
`ensureFresh()` — two concurrent callers open **one** Google popup. Status also
refreshes on widget mount and on `document` `visibilitychange -> visible`.

`DriveAuthStatus` = `{ connected, email, expiresAt, needsReauth, tokenValid,
connecting, error }`.

### `useDriveConnection(auth)`

`useSyncExternalStore`-backed, no mount side effects. Returns
`{ connected, email, connecting, error, needsReauth, refresh }`.

### `<GoogleDriveWidget auth ... />`

`GoogleDriveWidgetProps` = `{ auth, onConnected?, onDisconnected?, classNames?,
description? }`. Renders four states (not connected / connecting /
connected + Disconnect / connected + needsReauth + Reconnect). Errors render
inline via `role="alert"` — never `window.alert`. The widget calls
`auth.refresh()` on mount but **never** `auth.activate()`. `onConnected(connection)`
and `onDisconnected()` let the host do its own content work.

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

### Install from npm

Consume the published package and pin `^0.1.0`. No `file:` / workspace-link
consumption.

### Popup-closed recovery is drive-sync's job

drive-connect surfaces auth errors as-is. drive-sync already handles
popup-closed recovery internally — don't add app-level retries on top.

---

See `design.md` and `product-behavior.md` (shipped in the package) for the full
API contract and user-visible behavior.
