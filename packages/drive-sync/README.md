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
})

const dispose = drive.activate()
await drive.reconcile(knownProjectIds)

const p = drive.project(projectId)
await p.connect()
const picked = await p.pickFile({ apiKey: PICKER_API_KEY, appId: GCP_PROJECT_NUMBER })
const folderId = await p.ensureFolderPath()
await p.files.write({ folderId, name: 'data.json', content: '{}', mimeType: 'application/json' })
```

See `SPEC.md` for the full design: the 34 resolved decisions, storage layout,
and refresh state machine. `SPEC.md` is descriptive, written from the shipped
code — if it ever disagrees with the source, the source wins.

## Testing

Import fakes for GIS and Drive from the `./testing` subpath:

```ts
import { createGisFake, createDriveFake } from '@open-webapp/drive-sync/testing'
```
