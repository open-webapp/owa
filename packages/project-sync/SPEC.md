# `@open-webapp/project-sync` — Spec

**Status: descriptive, not normative.** Written from the shipped code in `src/`. If anything here disagrees with the source, the source is right and this file should be corrected.

## 1. Overview

`project-sync` is a plain-TypeScript (React hooks optional via `./react`, testing fakes via `./testing`; runtime dependencies: `idb`, `@open-webapp/drive-sync` as peerDependency) library that owns three things for an app that organizes user data into projects, each backed up to Google Drive:

- **Project registry** — a canonical list of all user projects, keyed by opaque id, uniqued by name (case-insensitive, trimmed), and ordered by creation time. Stored in IndexedDB (one registry per app).
- **Per-project data-store lifecycle** — opening, versioning, upgrading, and deleting per-project IndexedDB databases. The app supplies the schema (stores, indexes); the package manages handles, active pointer, and clean shutdown.
- **Sync orchestration** — running the sync loop per project, owned by the package: scheduling (interval, visibility regain, debounce, single-flight per project, cross-tab leader election), merging (app-supplied, opaque payloads), status tracking, and error taxonomy (re-exported from `drive-sync`).

It deliberately does **not** implement the merge algorithm, file-naming convention, or "what documents to sync" — those are owned by the app. The package provides the plumbing; apps decide what goes into the pipeline.

### Public API

`src/index.ts` exports one factory and types:

```ts
import { createProjectSync } from '@open-webapp/project-sync';

const app = createProjectSync({
  drive,                                  // caller-owned DriveSync instance (peerDep)
  appName: 'Notes Diary',                 // → folderPath ['OpenWebApp', 'Notes Diary']
  registryDbName: 'notes-diary-registry',
  data: { version: 2, upgrade(db, oldV, newV, tx) { /* app's object stores */ } },
  documents: (project) => SyncDocument[], // DYNAMIC — called per sync
  interval: 5 * 60 * 1000,                // null = manual only
});

// Registry CRUD
await app.projects.list();                // Project[] sorted by createdAt
await app.projects.get(id);               // Project | null
await app.projects.create(name);          // Project (unique, trimmed, case-insensitive)
await app.projects.rename(id, name);      // Project (unique validation)
await app.projects.remove(id);            // void (no Drive deletion)

// Project selection
await app.projects.setActive(id);         // void
await app.projects.getActive();           // Project | null

// Per-project database access
const db = await app.data.getActiveDb();  // IDBPDatabase<any>
const state = await app.data.getDocumentState(projectId, docKey);  // DocumentState | null
await app.data.forgetDocument(projectId, docKey);  // void

// Connection (OAuth, one per app)
await app.connection.connect();           // interactive; throws typed errors
await app.connection.disconnect();        // clears credentials
await app.connection.status();            // { email, needsReauth } | null

// Sync control
app.sync.start();                         // start scheduler (if interval != null)
app.sync.stop();                          // stop scheduler
await app.sync.syncNow(projectId?);       // trigger immediate sync; single-flight
app.sync.markDirty(projectId);            // trigger sync after debounce

// Status observable
const unsubscribe = app.subscribe((status) => {
  // { phase, lastSyncedAt, error, needsReauth, conflicts }
});
```

Files implementing the surface: `index.ts` (factory + main interface), `registry.ts` (projects CRUD + uniqueness), `migrations.ts` (marker plumbing for app-side migrations), `dataStore.ts` (per-project db lifecycle), `folders.ts` (Drive folder resolution, names-are-truth), `documents.ts` (document sync engine, version-directed), `syncState.ts` (per-document state tracking + single writer), `scheduler.ts` (interval/visibility/debounce/leader election), `status.ts` (observable + reauth poll), `errors.ts` (error taxonomy re-exported from drive-sync), `types.ts` (interfaces), `react/index.tsx` (hooks: `ProjectSyncProvider`, `useProjects`, `useActiveProject`, `useSyncStatus`), `testing/index.ts` (fakes for tests), `testing/contracts.ts` (export contract suites for app-level merge testing).

## 2. The 36 resolved design decisions

### Architectural foundation (decisions 1–8)

1. **Adapter-based, not canonical-model** — Package owns orchestration; apps keep their data shapes. The package does not parse or validate document payloads (decision 10); does not ship a merge algorithm (decision 11); does not assume what "a project contains" (decision 9). Apps adapt via callbacks (`documents(project)`, `merge`, `readLocal`, `writeLocal`).

2. **One package, Drive-concrete** — `@open-webapp/drive-sync` is a **peerDependency**, not a regular dependency. A duplicate copy in the tree means two background token refreshers racing the same IndexedDB connection record, creating a heisenbug (non-deterministic sync failures across tabs). Duplicate instances must fail at install time, not at runtime. Apps install both; the package never constructs its own `DriveSync` instance.

3. **Package owns registry storage** — The canonical `projects` list is IDB-backed, schema owned by the package, no adapter. Notesdiary's legacy `savedProjects` snapshot mechanism (planning's localStorage equivalent) is deleted, not wrapped — the old data is migrated (decisions 25–28), not carried forward in two forms.

4. **Package owns per-project data-store lifecycle** — The derived `dbName` is deterministic function of project id. The package holds the handle cache, active pointer, open/close/delete operations. Apps supply only `{version, upgrade}` to define their stores. IndexedDB is mandatory for project data (no fallback to localStorage).

5. **Uniform Drive layout `['OpenWebApp', <App Name>]/<Project Name>/`** — All three apps share the same folder hierarchy on Drive. No app-specific root folder; no special-case legacy db name (`notes-diary` root). Users migrating between apps see the same folder structure. Users' old Drive files are migrated in place (decision 26), not abandoned.

6. **`migrateLegacyDbIfNeeded()` and its tests are dropped** — Notesdiary's legacy db name detection code is deleted as dead wood. The migration already happened in the field; the package never needs it.

7. **Folder/file NAMES are the source of truth. `driveFolderId` is a disposable cache** — Folder resolution uses cached id only after verification (exists, not trashed, name still matches) per session (decision 24). On cache miss, name lookup under the parent → else create. A folder renamed in Drive is simply no longer that project's folder; a new folder is created under the new (old) name. Files never resolve via cached id on failure — a `NotFoundError` or write failure triggers name lookup.

8. **Project names unique** — Trimmed, lowercased for uniqueness check. Rename to an existing name is rejected. If Drive somehow holds two same-named folders at the same level, oldest `createdTime` wins, deterministically. App propagates its own renames to Drive. Deleting a project never deletes Drive data (decision 31).

### Document sync unit and payloads (decisions 9–11)

9. **Sync unit = a document SET per project, and the set is a function of app state** — Notesdiary's user-defined filter rules define the document set at sync time. Planning's per-project tasks are one document. The app calls `documents(project)` at the start of each sync; the package never caches the result. An empty set is valid (e.g., during data load) and is never interpreted as "delete all Drive files" (decision 32).

10. **Payloads are opaque** (`string | Uint8Array`), never parsed by the package. `mimeType` is per-document, app-chosen. Planning is `text/csv`, notesdiary is `application/json`, portfolio is encrypted `application/octet-stream`. The package never calls `JSON.parse`, never looks inside.

11. **`merge` is app-supplied, returns `{ merged, conflicts[] }`.** Package ships **no default merge** — a default here is a silent-data-loss footgun. Apps decide winner-on-conflict (local-wins, remote-wins, union, user-prompted, etc.). The package calls `merge(local, remote)` only on the read-merge-write fallback path (decision 20); never on pure push.

### Connection and projects (decisions 12–14)

12. **App-wide single connection** — One OAuth grant per app, mapped onto one reserved Drive `projectId` inside `drive-sync`. All user projects are folders inside that one account. Per-project Google accounts are deferred (not implemented); multi-account use is not supported. A breaking change for planning users (decision 12 forces single-account), but no data migration can paper over it — users reconnect once.

13. **`drive-sync` gets `project(id).ensureFolderPath(subPath?)`** — The package can request nested folder creation/navigation without re-parenting. Notesdiary's throwaway-instance hack (creating a handle just to call `ensureFolderPath` and never `.activate()`) is now deletable; a normal instance handles it.

14. **Package owns the scheduler**: interval, sync-on-visibility-regain, `markDirty()` debounce, single-flight coalescing per project, cross-tab leader election via BroadcastChannel. Also owns the sync-status observable and `needsReauth` polling (every 60s, no network call). Error taxonomy is re-exported from `drive-sync`.

### React and testing (decisions 15–17)

15. **`./react` is thin read-only hooks** over `useSyncExternalStore`. No components, no CSS. Mutations only via the core instance (`app.projects.create()`, `app.sync.markDirty()`, etc., never via a hook). React is a permissive peerDependency (`^18 || ^19`). Hooks work on any instance — router/context plumbing is app-side.

16. **Testing: fakes + exported contract suites** — Fakes for in-memory testing (no network, no IndexedDB required). Contract suites (`describeMergeContract`, `describeDocumentContract`) are exported from `./testing` for apps to verify their own merge/codec implementations. Each app's hand-written merge is a checkable claim, not assumed correct.

17. **Sequence:** ① drive-sync minor (0.5.0) → ② portfolio debt paydown → ③ extract + adopt in notesdiary (hardest app first) → ④ portfolio adopts → ⑤ planning adopts. No app touches `project-sync` until T23 (package published).

18. **Package starts at `0.1.0` and churns** — No 1.0 promise until all three apps are on it. Pre-release `0.1.x` can break on minor version bumps; breaking changes must be called out in release notes, and each app's adoption is gated on its own test suite.

### Version-directed sync engine (decisions 19–24)

19. **The sync engine is version-directed (try-write-first), not read-merge-write** — Per document: attempt `files.write({fileId, content})` with no read. If the cached baseline matches Drive, succeeds — pure push, zero reads, zero merges, zero `writeLocal` calls. Only on `RemoteChangedError` does the engine fall back to read-merge-write. Notesdiary shipped this optimization; regressing it would add a network read to every 5-minute sync.

20. **On pure-push success there is no pull and no `writeLocal`** — A matching baseline means this client was current; nothing needs merging. `writeLocal` is called only on the fallback path (read-merge-write or create-new-file), never on pure push success. Decision 19's whole point is "zero side effects on baseline match."

21. **Bounded at 3 total write attempts** (1 direct + up to 2 read-merge-write cycles), then throw `Error('Sync conflict could not be resolved')`. Both `RemoteChangedError` reasons (`'remote-changed'`, `'never-restored'`) get identical functional handling, differing only in log wording. **Non-`RemoteChangedError` failures never retry** — they propagate on the first attempt (network errors, permission errors, etc., are not transient from the package's perspective).

22. **Merged content is rebuilt from each fresh read, never accumulated across attempts** — Accumulating would resurrect entries deleted remotely between read-merge-write attempts. Each loop iteration starts with a fresh `files.read`, merges against that, and writes the fresh merge.

23. **The package owns per-document sync state, with a single accumulating writer + serialized persist queue** — Notesdiary just fixed a data-loss bug: concurrent per-rule syncs committed closure-captured maps and clobbered each other's `driveFileId`/`lastSynced`. The package therefore needs both a synchronously-updated in-memory map (no `await` in the critical section) **and** a promise-chained persist queue (so writes land in call order). A failed persist does not wedge the queue; later persists still land.

24. **File-id cache is verified lazily; folder-id cache is verified once per session** — Files use cached id directly and fall back to name lookup only on `NotFoundError`/write failure (decision 24). Folders verify their cached `driveFolderId` exactly once per session (in memory, not persisted), re-verifying only on explicit user sync or reconnect. Background interval syncs pay one `files.get` per project per page load, not per sync.

### Migration decisions (25–28)

25. **Every app ships a real migration. Nobody re-syncs, nobody starts over** — Implementations live in each app's own repo at `src/lib/migrations/`, app-specific archaeology (old db names, old localStorage keys, old Drive layout). Data and Drive files are migrated in place; users do not need to re-enter data or reconnect Drive.

26. **The package provides only the marker plumbing**, not the migrations: `app.migrations.hasRun(key)` / `markRun(key)`, persisted in the registry db. Idempotency and once-only semantics are generic and dangerous to re-derive; the *content* of a migration is not. Migrations run once, before first sync, and are safe to re-enter after a mid-way crash.

27. **Package-derived `dbName` is non-negotiable** — IndexedDB has no rename, so migrations copy rather than adopt. Adding a legacy `dbName` override to the registry would reintroduce exactly the escape hatch rejected in decision 4. Each app's migration copies old db → new derived db (verification of counts/sample records) → `deleteDatabase` on the old one, only after verification succeeds.

28. **Migrations are forward-only and non-destructive until verified** — No migration deletes or moves anything before its replacement is confirmed readable. A failed migration leaves the app on old data with a clear error, never half-migrated.

### Open questions — all resolved as decisions 29–36

29. **`drive-sync`'s picker has three real gaps; all three are fixed upstream in 0.5.0** — Verified against source: dialog never tears down (portfolio fixed it locally; now T1c), missing `setOrigin()` (breaks on deploy under base path), missing `setIncludeFolders()`. All three land in `drive-sync` 0.5.0. Apps inherit the fix; no local workaround needed.

30. **planning has no Google Sheets integration to preserve** — `src/lib/googleSheets.ts` is a 4-line tombstone pointing at a deleted file. Delete it and fix stale "spreadsheet sync" language (one comment, one test name) to say CSV/Drive sync.

31. **No opt-in for deleting a project's Drive folder** — Package never touches Drive on project delete — no flag, no second method. An irreversible destructive op behind a boolean is one bad spread away from deleting a user's only backup. Drive's own trash UX is better than anything we'd build. Apps that want it call `files.remove()` themselves, beside their own confirmation dialog.

32. **Per-document Drive deletion stays app-side, and the package exposes the state needed for it** — Notesdiary already ships `removeFilterRule(id, alsoDeleteFromDrive)` calling `files.remove()` on user opt-in — that behavior survives unchanged. Package adds a read-only document-state accessor (`getDocumentState(projectId, docKey)` → `{driveFileId, lastSynced, status}`) plus `forgetDocument(projectId, docKey)` (forget state for a removed document). **Auto-deleting Drive files for documents that vanish from the set is REJECTED** — a cold-start data-loss trap (see Rejected designs).

33. **Registry returns projects in `createdAt` ascending order and exposes nothing else about ordering** — Ordering/pinning/recency is presentation state, persisted app-side keyed by project id. No `order` field, no `lastOpenedAt`. Apps can implement recency sort on their own.

34. **Folder-id verification: once per session, memo invalidated on explicit user-triggered sync and on reconnect** — Background interval syncs pay one `files.get` per project per page load. Per-sync verification (~864 extra calls/day for 3 projects) buys a rounding error but creates observable latency on every sync. Verify-on-failure-only was rejected: it costs nothing but silently guts decision 7, since a renamed folder still resolves by id and the app keeps writing into it with nothing erroring.

35. **Migrations retire after 12 months** — Retiring them outright would silently break a long-dormant install; keeping them forever is ~150 dead lines per app. At 12 months post-ship, swap each migration body for a detector + raw JSON export at the same file path and the same `runOnce` key. User can import the JSON to restore data. "Go run the previous version" was rejected (PWAs have no old build), and keeping a legacy deployment alive forever was rejected (untested = broken).

36. **The remaining `App.tsx` closure-capture slices get an audit, not a fix, in Phase 3** — Inherited follow-up from the version-direction plan: `entries` and drive-meta are also mutated from async handlers. `entries` is the exposed one — merge path calls `setEntries` from inside per-document sync, which the package now runs concurrently. Auditing is ~20 minutes; fixing carries its own concurrency-test burden and must not ride along with a phase that swaps the sync engine and runs three migrations.

## 3. Storage layout

### Registry database: `{registryDbName}`

One per app (e.g., `'notes-diary-registry'`), version determined by `src/registry.ts`. Contains two object stores:

**Store: `projects`** (keyPath `id`)
| Field | Type | Notes |
|---|---|---|
| `id` | string | Opaque stable uuid, generated at creation. |
| `name` | string | User-assigned, unique (trimmed, case-insensitive). |
| `createdAt` | string | ISO timestamp. Lists return `createdAt` ascending. |
| (index: `by-name-key`) | derived | `name.trim().toLowerCase()` for fast lookup. |
| (index: `by-created`) | derived | `createdAt` then id for stable sort. |

**Store: `migrations`** (keyPath `key`)
| Field | Type | Notes |
|---|---|---|
| `key` | string | Marker key (e.g., `'db-names-v1'`, `'adopt-existing-state-v1'`). |
| `runAt` | number | Epoch ms when the migration completed. |

### Per-project databases: `owa-project-sync-{appId}-{projectId}`

One per project, version inherited from `options.data.version`, opened fresh on every `getActiveDb()` and cached in memory (one open handle per active project, released on `setActive(otherId)` or project `remove()`). Contains app-defined object stores plus one package-managed store:

**Store: `__project_sync_state`** (keyPath `docKey`)
| Field | Type | Notes |
|---|---|---|
| `docKey` | string | From `SyncDocument.key` — stable local document identity. |
| `driveFileId` | string \| null | Cached Drive file id. Null until first successful create/resolve. |
| `lastSynced` | number \| null | Epoch ms of the last successful sync. Null until first merge/write. Never updated on pure push (decision 20). |
| `status` | string | `'pending'`, `'syncing'`, `'synced'`, or `'error'`. Transient `'syncing'` never persisted. |
| `error` | Error \| null | Serialized error object from the last failed sync. Cleared on next success. |

Open handles are cached in-process in a `Map<string, IDBPDatabase>` keyed by `projectId`, so repeated calls for the same project reuse one connection. Handles are released (`.close()`) when the project is deleted or a different project becomes active.

### Drive layout

```
[Google Drive]
  OpenWebApp/
    <App Name>/                (e.g., "Notes Diary")
      <Project Name 1>/        (e.g., "Work", "Personal")
        <Document>.json
        <Document>.csv
      <Project Name 2>/
        <Document>.json
```

All folder and file names are chosen by the app and the user. Folder ids are cached in memory (verified once per session, decision 24) and re-verified on each session start. File ids are cached and self-healing on `NotFoundError` (decision 24). If a folder is renamed in Drive, the old folder is orphaned and a new one is created; no data is lost (the files stay in the old location until the user manually cleans them up, which is honest rather than surprising).

## 4. Known limitations / accepted tradeoffs

- **Single connection per app** — Multi-account per-project is not supported (decision 12). Apps are single-account. A future phase could add per-project OAuth, but data migration would be required (break planning users). Deferred deliberately.

- **IndexedDB-only for project data** — No localStorage fallback or alternate persistence (decision 4). IndexedDB is mandatory. Apps that need to persist UI state outside projects (e.g., current view, scroll position) keep that in localStorage or sessionStorage at their own discretion.

- **No default merge strategy** — The package ships zero merge implementations (decision 11). Apps must supply one. A default would silently drop data (the wrong kind of safe). Contract suites are exported to help verify correctness, but they do not replace testing.

- **Package never auto-deletes Drive files** — No `trashDriveFolder` flag on project deletion (decision 31). No auto-deletion when a document vanishes from the set (decision 32 — rejected as a cold-start data-loss trap). Apps can delete files themselves via `files.remove()` if they choose. This is honest: Drive's trash exists for recovery if needed.

- **Per-folder re-verification pays a small cost** — Verifying folder cache once per session costs one `files.get` per project per page load (decision 34). Per-sync verification (~864 calls/day for 3 projects, 5-min interval) was rejected because the cost is not worth the minimal protection it adds beyond the once-per-session check.

## 5. Rejected designs

The following ideas have been considered and deliberately rejected. They appear here to prevent them from being re-proposed every six months.

### Rejected: Auto-delete Drive files for vanished documents (decision 32)

**Proposal:** When a document disappears from `documents(project)` (e.g., user deletes a filter rule in notesdiary), automatically delete its Drive file.

**Why it's wrong:** The document set is a function of app state, computed fresh on each sync. During a cold start, before app data loads from IndexedDB, `documents(project)` returns `[]`. This window is typically 10–100ms, but on a slow device or slow network, could stretch longer. If an auto-delete were triggered during that window, the sync loop would interpret the empty set as "user deleted everything" and destroy every backup file in the project.

**Safe alternative:** Apps expose read-only document state via `getDocumentState(projectId, docKey)` → `{ driveFileId, ... }`. Apps that want to offer file deletion do so explicitly on user opt-in, calling `files.remove(driveFileId)` themselves (notesdiary's current `removeFilterRule(id, alsoDeleteFromDrive)` is the model). The package never infers intent from absence.

### Rejected: Default merge strategy (decision 11)

**Proposal:** Ship a default merge (e.g., "remote wins", "union by id", "last-write-wins") so apps don't have to define one.

**Why it's wrong:** Any default silently drops data. Notesdiary's filter rules are a union with collision handling (local wins). Planning's tasks need user-prompted conflict resolution. Portfolio's encrypted state should never merge (wrong key = data corruption). A one-size-fits-all merge creates a hidden class of failures — users don't notice data disappearing.

**Safe alternative:** Package exports contract suites (`describeMergeContract`) so apps can verify their own merge implementations. Provide clear guidance in docs. Make the merge required (non-optional) in TypeScript, forcing the API to speak up at compile time.

### Rejected: `trashDriveFolder` flag on project deletion (decision 31)

**Proposal:** Add a `remove(id, { trashDriveFolder: true })` option so projects can auto-delete their Drive folder.

**Why it's wrong:** An irreversible destructive op behind a boolean flag is one bad spread (`...opts`) or one careless refactoring away from deleting a user's only backup. The folder tree stays in Drive trash for 30 days, but if a code path somewhere accidentally calls `remove(id, true)`, the damage is silent and the user's option to recover is time-limited.

**Safe alternative:** Apps that want to delete a project's Drive folder call `files.remove()` directly, next to their own confirmation dialog. The explicit call site and UI affordance together communicate intent. Google Drive's own trash/recovery UX is better than anything we'd ship.

### Rejected: Per-sync folder re-verification (decision 34)

**Proposal:** Verify folder cache on every sync instead of once per session, catching Drive-side renames immediately.

**Why it's wrong:** Background syncs run every 5 minutes (3 projects = 3 calls, 3 calls/hour × 24 hours = ~72 extra API calls per day per user). At scale, that's a non-trivial quota burn. The check catches exactly one user mistake (user renamed the folder in Drive and wonders why new files appear elsewhere) — a rare case. The cost-to-benefit is poor.

**Safe alternative:** Verify once per session (in-memory memo). Invalidate the memo on explicit user-triggered sync (when the user clicked "Sync now" and presumably is watching the app) and on reconnect. One check per page load catches most cases without the tax on background syncs. If a user renames a folder in Drive, a new one is created and the old one orphaned — files are not lost, and the user can recover them manually from Drive's folder history if needed.

## 6. File index

**Core:** `index.ts` (factory), `types.ts` (interfaces), `errors.ts` (error taxonomy, re-exported from drive-sync).

**Registry:** `registry.ts` (projects CRUD + uniqueness + `by-name` index), `migrations.ts` (once-only marker plumbing).

**Per-project data:** `dataStore.ts` (handle cache + lifecycle + active pointer), `syncState.ts` (per-document state + single writer + persist queue), `folders.ts` (Drive folder resolution, names-are-truth + cached-id verification).

**Sync:** `documents.ts` (version-directed engine, try-write-first + read-merge-write fallback + 3-attempt bound), `scheduler.ts` (interval + visibility + debounce + single-flight + BroadcastChannel leader election), `status.ts` (status observable + needsReauth poll).

**React:** `react/index.tsx` (thin hooks: `ProjectSyncProvider`, `useProjects`, `useActiveProject`, `useSyncStatus`).

**Testing:** `testing/index.ts` (fakes), `testing/contracts.ts` (contract suites for app-level verification).
