# Plan: `@open-webapp/project-sync` — shared project organization + Drive backup/sync/restore

## Goal
Three apps (notesdiary, planning, portfolio) each rebuilt the same two things by hand: "user data is organized into projects" and "each project backs up to Google Drive." Three different ways, three sets of bugs. Make one package that owns the boring dangerous parts — project registry, per-project IndexedDB lifecycle, Drive folder/file resolution, sync scheduling, status + error surface — and let each app keep only what is truly its own: how its data merges, how it serializes, how it looks. Apps `use` instead of rebuild.

## Scope

**In scope:**
- New package `@open-webapp/project-sync` in the `owa` monorepo (entrypoints `.`, `./react`, `./testing`).
- Minor `drive-sync` release adding per-project `ensureFolderPath(subPath?)`, **`files.update()` for rename/move**, and **three picker fixes** (teardown bug, `setOrigin`, `setIncludeFolders`).
- Deleting portfolio's 830-line stale reimplementation of things `drive-sync` already does.
- Adopting the package in all three apps: notesdiary → portfolio → planning.
- **A real migration implementation per app, living in that app's own repo** (`src/lib/migrations/`): notesdiary moves its Drive files into the new layout; portfolio adopts its existing db as the first project; planning lifts localStorage into IDB. No user is asked to re-sync or start over.
- Per-app breaking change that survives migration: planning loses per-project Google accounts (one app-wide connection). Data is migrated; the multi-account *feature* is dropped.

**Out of scope:**
- Fixing the remaining `App.tsx` closure-capture slices — **audited** in T29b, fixed separately.
- Retiring any migration — the 12-month detector swap (decision 35) is a future task, not this plan.
- Any shared UI component. Pickers, settings tabs, routing stay in apps.
- Encryption. Stays inside portfolio (`crypto.ts`), invisible to the package.
- Merge strategies. Package ships none, deliberately.
- Multi-account / per-project OAuth. Deferred; recoverable later without data migration.
- Converting the app repos into monorepo workspaces. They stay separate repos on npm semver.

## Resolved decisions
Locked in by interview. Do not re-litigate.

1. **Adapter-based, not canonical-model.** Package owns orchestration; apps keep their data shapes.
2. **One package**, Drive-concrete. `@open-webapp/drive-sync` is a **`peerDependency`** — a duplicate copy in the tree means two background token refreshers racing the same IndexedDB connection record, so make it an install-time error, not a production heisenbug.
3. **Package owns registry storage** (canonical IDB shape, db name configurable). No adapter. planning's `savedProjects` snapshot mechanism is deleted, not wrapped. *(Amended: its data is no longer discarded — see decisions 25–28.)*
4. **Package owns per-project data-store lifecycle.** `dbName` derived from project id; package holds the handle cache; `getActiveDb()` is the only way to reach a handle; delete closes handles and `deleteDatabase`. App supplies `{ version, upgrade }` only. IndexedDB is mandatory for project data.
5. **Uniform Drive layout `['OpenWebApp', <App Name>]/<Project Name>/`.** notesdiary's `dbName === 'notes-diary'` root special-case is deleted. *(Amended: users are no longer asked to re-sync — a Drive-side migration moves the files, see decision 26.)*
6. **`migrateLegacyDbIfNeeded()` and its tests are dropped**, not ported. Migration already happened in the field.
7. **Folder/file NAMES are the source of truth. `driveFolderId` is a disposable cache.** Resolution = use cached id only after verifying (exists, not trashed, name still matches) → else name lookup → else create. A folder renamed in Drive is simply no longer that project's folder.
8. **Project names unique** — trimmed, case-insensitive. Rename to an existing name is rejected. If Drive somehow holds two same-named folders, **oldest `createdTime` wins**. App propagates its own renames to Drive. Deleting a project never deletes Drive data. No `appProperties`.
9. **Sync unit = a document SET per project, and the set is a function of app state** (not static config) — this is what carries notesdiary's user-defined filter rules.
10. **Payloads are opaque** (`string | Uint8Array`), never parsed by the package. `mimeType` is per-document (planning is `text/csv`).
11. **`merge` is app-supplied, returns `{ merged, conflicts[] }`.** Package ships **no default merge** — a default here is a silent-data-loss footgun. Conflicts are data; the package never renders or resolves them.
12. **App-wide single connection** — one OAuth grant per app, mapped onto one reserved `drive-sync` projectId. Projects are folders inside that one account.
13. **`drive-sync` gets `project(id).ensureFolderPath(subPath?)`** so notesdiary's throwaway-instance / never-call-`.activate()` hack can be deleted rather than relocated.
14. **Package owns the scheduler**: interval, sync-on-visibility-regain, `markDirty()` debounce, single-flight coalescing, cross-tab leader election. Also owns the sync-status observable and `needsReauth` polling. Error taxonomy re-exported from drive-sync.
15. **`./react` is thin read-only hooks** over `useSyncExternalStore`. No components. Mutations only via the core instance. React is a permissive peer dep (`^18 || ^19`).
16. **Testing: fakes + exported contract suites** (`describeDocumentContract`, `describeMergeContract`) so each app's hand-written merge is a checkable claim.
17. **Sequence:** ① drive-sync minor → ② portfolio debt paydown → ③ extract + adopt in notesdiary (hardest app first, on purpose) → ④ portfolio adopts → ⑤ planning adopts.
18. Package starts at `0.1.0` and churns. No 1.0 until all three apps are on it.

### Decisions inherited from `notesdiary/plans/drive-sync-version-direction.md` (BUILT — already shipped)

That plan is implemented and its behavior is now notesdiary's documented contract. The package must **absorb** it, not regress it.

19. **The sync engine is version-directed (try-write-first), not read-merge-write.** Per document: attempt `files.write({fileId, content})` with no read. If the library's cached baseline matches Drive, that succeeds — pure push, zero reads, and **`merge` is never called**. Only on `RemoteChangedError` does the engine fall back to `files.read` (which resets the baseline) → `merge` → write. Naively porting an always-read engine would add a network read to every 5-minute sync in notesdiary and undo shipped work.
20. **On pure-push success there is no pull and no `writeLocal`.** A matching baseline means this client was current; there is nothing to merge in. `writeLocal` is called only on the fallback path.
21. **Bounded at 3 total write attempts** (1 direct + up to 2 read-merge-write cycles), then throw `Error('Sync conflict could not be resolved')`. Both `RemoteChangedError` reasons (`'remote-changed'`, `'never-restored'`) get identical functional handling, differing only in log wording. **Non-`RemoteChangedError` failures never retry** — they propagate on the first attempt.
22. **Merged content is rebuilt from each fresh read, never accumulated across attempts** — accumulating would resurrect entries deleted remotely between attempts.
23. **The package owns per-document sync state, with a single accumulating writer + serialized persist queue.** notesdiary just fixed a real data-loss bug here: concurrent per-rule syncs committed closure-captured maps and clobbered each other's `driveFileId`/`lastSynced`, and a functional `setState` updater alone was insufficient because the persist path `await`s `getDB()` before opening its IDB transaction, so write ordering isn't guaranteed. The package therefore needs **both** a synchronously-updated in-memory map (no `await` in the read-modify-write critical section) **and** a promise-chained persist queue. This is exactly the "boring and dangerous" plumbing the extraction exists to centralize — it must not be re-derived per app.
24. **File-id cache is verified lazily; folder-id cache is verified once per session.** The built plan explicitly rejected re-verifying a cached `driveFileId` by name on every sync (pure API cost). Files therefore use the cached id directly and fall back to name lookup only on `NotFoundError`/write failure. Folders keep decision 7's semantics but verify **once per session**, not per sync — enough to detect a user's Drive-side rename without paying for it every 5 minutes.

### Migration decisions (added after the interview)

25. **Every app ships a real migration. Nobody re-syncs, nobody starts over.** Implementations live **in each app's own repo** at `src/lib/migrations/`, because each one is app-specific archaeology (old db names, old localStorage keys, old Drive layout) that has no business in shared code.
26. **The package provides only the marker plumbing**, not the migrations: `app.migrations.hasRun(key)` / `markRun(key)`, persisted in the registry db. Idempotency and once-only semantics are generic and dangerous to re-derive; the *content* of a migration is not. Migrations run once, before first sync, and are safe to re-enter after a mid-way crash.
27. **Package-derived `dbName` is non-negotiable (decision 4), so migrations copy rather than adopt.** IndexedDB has no rename, and adding a legacy `dbName` override to the registry would reintroduce exactly the escape hatch rejected in the interview. Each app's migration therefore **copies old db → new derived db, verifies the copy, then `deleteDatabase` on the old one**. Delete only after verification.
28. **Migrations are forward-only and non-destructive until verified.** No migration deletes or moves anything before its replacement is confirmed readable. A failed migration leaves the app on old data with a clear error, never half-migrated.

### Answers to the open questions (locked — nothing here is open)

29. **`drive-sync`'s picker has three real gaps; all three are fixed upstream in 0.5.0 (T1c), not worked around in apps.** Verified against source: `openPicker()` ends at `build().setVisible(true)` and on PICKED/CANCEL only settles the promise — it **never tears the dialog down**, so the modal backdrop stays in the DOM and blocks the app (portfolio hit this and fixed it locally). Also missing: `setOrigin()` (these apps deploy under a base path, so origin mismatch breaks Picker) and `setIncludeFolders()`. All three land in `drive-sync`; every app inherits the fix. `extractDriveFileId` (paste a Drive URL) is **not** picker functionality and stays in portfolio.
30. **planning has no Google Sheets integration to preserve.** `src/lib/googleSheets.ts` is a 4-line tombstone pointing at `src/lib/googleAuth.ts`, which no longer exists. Delete the tombstone and fix two stale "spreadsheet sync" mentions (`state.ts:819` comment, `syncDropdowns.test.ts:40` test name). No Sheets modeling, no `SyncDocument` for spreadsheets.
31. **No opt-in for deleting a project's Drive folder.** Package never touches Drive on project delete — no flag, no second method. An irreversible destructive op behind a boolean is one bad spread away from deleting a user's only backup, and Drive's own trash UX is better than anything we'd build. An app that wants it calls `files.remove()` itself, beside its own confirmation dialog.
32. **Per-document Drive deletion stays app-side, and the package exposes the state needed for it.** notesdiary **already** ships `removeFilterRule(id, alsoDeleteFromDrive)` (`App.tsx:281`) calling `files.remove()` on user opt-in — that behavior must survive unchanged. Package adds a read-only document-state accessor (`driveFileId`, `lastSynced`, `status`) plus `forgetDocument(projectId, docKey)`. **Auto-deleting Drive files for documents that vanish from the set is a REJECTED design, recorded as such in SPEC:** `documents(project)` is a function of app state and returns `[]` during the window before filter rules load from IndexedDB, so auto-delete would read that as "user removed every rule" and destroy every backup in the project — silently, and only on a cold start with slow IDB.
33. **Registry returns projects in `createdAt` ascending order and exposes nothing else about ordering.** Today there is no sorting anywhere, so `ProjectPicker` renders in IDB key (uuid) order — arbitrary. `createdAt` fixes that for free. Ordering/pinning/recency is presentation state, persisted app-side keyed by project id. No `order` field, no `lastOpenedAt` (additive later if an app ever wants recency sort).
34. **Folder-id verification: once per session, memo invalidated on explicit user-triggered sync and on reconnect.** Background interval syncs pay one `files.get` per project per page load. Verify-on-failure-only was rejected: it costs nothing but silently guts decision 7, since a renamed folder still resolves by id and the app keeps writing into it with nothing erroring. Per-sync verification (~864 extra calls/day for 3 projects) buys a rounding error.
35. **Migrations retire after 12 months, replaced by a detector + raw JSON export at the same file path and the same `runOnce` key.** Retiring them outright would silently break a long-dormant install; keeping them forever is ~150 dead lines per app. The detector finds old-shape data and dumps it to a JSON download the user can import — actionable with no old build and no legacy deployment. "Go run the previous version" was rejected: these are PWAs, the old build is gone on deploy. Keeping a legacy deployment alive forever was rejected: an untested deployment is a broken one.
36. **The remaining `App.tsx` closure-capture slices get an audit, not a fix, in Phase 3 (T29b).** Inherited follow-up from the version-direction plan: `entries` and drive-meta are also mutated from async handlers. `entries` is the likely-exposed one — T28's merge path calls `setEntries` from inside per-document sync, which the package now runs concurrently. Auditing is ~20 minutes; fixing carries its own concurrency-test burden and must not ride along with a phase that already swaps the sync engine and runs three migrations.

## Target API (sketch — T4 freezes this)

```ts
const app = createProjectSync({
  drive,                                  // caller-owned DriveSync instance (peer dep)
  appName: 'Notes Diary',                 // → folderPath ['OpenWebApp', 'Notes Diary']
  registryDbName: 'notes-diary-registry',
  data: { version: 2, upgrade(db, oldV, newV, tx) { /* app's object stores */ } },
  documents: (project) => SyncDocument[], // DYNAMIC — called per sync
  interval: 5 * 60 * 1000,                // null = manual only
})

interface SyncDocument {
  key: string          // stable local identity, for status keying
  name: string         // Drive file name — the source of truth (decision 7)
  mimeType: string
  readLocal(): Promise<Payload | null>
  writeLocal(merged: Payload): Promise<void>
  merge(local: Payload | null, remote: Payload | null):
    Promise<{ merged: Payload; conflicts: unknown[] }>
}
type Payload = string | Uint8Array

app.projects.list() / get(id) / create(name) / rename(id, name) / remove(id)
app.projects.setActive(id) / getActive() / getActiveDb()
app.connection.connect() / disconnect() / status()
app.sync.start() / stop() / syncNow(projectId?) / markDirty(projectId)
app.subscribe(cb)   // { phase, lastSyncedAt, error, needsReauth, conflicts }
```

## Affected files

### `owa` (monorepo)
- `packages/drive-sync/src/index.ts` — `ProjectHandle.ensureFolderPath(subPath?: string[])` + `FilesHandle.update()` (rename/move — currently absent)
- `packages/drive-sync/src/picker.ts` — dialog teardown (bug), `setOrigin`, `setIncludeFolders`
- `packages/drive-sync/src/testing/pickerFake.ts` — expose teardown for assertions
- `packages/drive-sync/src/files.ts` (or wherever path-walking lives) — append `subPath` segments
- `packages/drive-sync/src/__tests__/files.test.ts` — subPath cases
- `packages/drive-sync/{package.json,README.md,SPEC.md}` — bump to `0.5.0`, document
- `.github/workflows/publish.yml` — generalize, or add a `project-sync-v*` job
- `CLAUDE.md` — extend auto-tag rule to `project-sync`
- `packages/project-sync/**` — NEW package
- `plans/project-sync-extraction.md` — this file

### `notesdiary`
- `src/lib/migrations/{dbNames,driveLayout,filterSyncState}.ts` — **NEW** (app-specific migrations, T26b/T26c/T28b)
- `src/App.tsx` — also loses the shipped `updateFilterSyncState`/`persistFilterSyncState` ref writer and the `MAX_WRITE_ATTEMPTS` try-write-first loop (both move into the package, T16/T16b)
- `src/__tests__/driveSyncFilterRuleVersioning.test.tsx`, `src/__tests__/driveSyncConcurrentFilterState.test.tsx` — the 9 shipped assertions become the package's parity gate before deletion
- `src/lib/projectRegistry.ts` — **deleted** (package owns it)
- `src/lib/db.ts` — **deleted** (package owns handle map + active pointer)
- `src/lib/drive.ts` — shrinks to `createProjectSync` config + `ensureJsonExtension`; `ensureProjectFolderId` deleted
- `src/lib/entriesRepo.ts` / `src/lib/metaRepo.ts` — read/write via `getActiveDb()`
- `src/App.tsx` — sync loop, `needsReauth` poll, status flags replaced by `subscribe()`
- `src/__tests__/projectRegistry*.test.ts` — deleted
- `src/__tests__/drive.test.ts` — `folderPath` pin assertion moves to the package
- `src/components/ProjectPicker.tsx` — reads hooks instead of `projectRegistry`
- `CLAUDE.md`, `schema-spec.md`, `product-behavior.md` — architecture sections rewritten

### `portfolio`
- `src/lib/migrations/adoptExistingState.ts` — **NEW** (T32b)
- `src/lib/drive.ts` — 830 lines → ~80 (codec + merge + config)
- `src/lib/persist.ts` — per-project via `getActiveDb()`
- `src/lib/crypto.ts` — unchanged, now called from inside `merge`/`readLocal`
- `src/lib/drive.test.ts` — rewritten against fakes + contract suites
- `src/App.tsx` — connection/sync/status wiring
- `CLAUDE.md`, `schema-spec.md` — updated

### `planning`
- `src/lib/migrations/localStorageToIdb.ts` — **NEW** (T36b)
- `src/lib/googleSheets.ts` — **deleted** (4-line tombstone pointing at a file that no longer exists)
- `src/lib/state.ts:819`, `src/__tests__/syncDropdowns.test.ts:40` — stale "spreadsheet sync" wording
- `src/lib/drive.ts`, `src/lib/sync.ts`, `src/lib/syncErrors.ts` — collapse into config + merge; `parseSyncError` deleted in favour of the shared taxonomy
- `src/lib/state.ts` — `savedProjects`, `authByProject`, `googleBusy`, `syncBusy`, `syncStatus`, `syncError` removed
- `src/lib/persist.test.ts` — localStorage tests deleted
- `src/lib/googleSheets.ts` — untouched
- `CLAUDE.md`, `schema-spec.md`, `product-behavior.md` — updated

---

## Tasks

Each task ≤30 min. Phases live in different repos, so worktree bookends repeat per phase.

### Phase 0 — `drive-sync` 0.5.0 (repo: `owa`)

#### T0 — Create worktree (owa)
**Deps:** none
**Files:** none (git only)
**Do:** `git worktree add ../worktree-drive-sync-subpath -b drive-sync/subpath`, cd in.
**Test cases:** n/a
**Acceptance:** worktree exists, branch checked out, cwd is worktree.

#### T1 — `ensureFolderPath(subPath?)`
**Deps:** T0
**Files:** `packages/drive-sync/src/index.ts`, path-walk impl
**Do:** Add optional `subPath?: string[]`. Walk instance `folderPath` then each `subPath` segment, create-if-missing per segment. When multiple folders match a segment name, pick **oldest `createdTime`** (decision 8) — request `createdTime` in the list query and sort. No arg = today's behavior exactly.
**Test cases:**
- happy: `ensureFolderPath(['My Notes'])` creates nested folder, returns its id
- happy: no-arg call unchanged (existing tests must pass untouched)
- edge: segment already exists → reuse, no duplicate created
- edge: two same-named sibling folders → oldest `createdTime` returned, deterministically
- edge: empty array `[]` behaves as no-arg
- error: name with a `'` is escaped in the Drive query (no injection into `name = '...'`)
**Acceptance:** `npm -w packages/drive-sync test` green; no existing test modified.

#### T1b — `files.update()` for rename + move
**Deps:** T0
**Files:** `packages/drive-sync/src/index.ts` (`FilesHandle`), `src/files.ts`, `src/__tests__/files.test.ts`
**Do:** `FilesHandle` currently exposes only `list/read/status/write/remove` — there is **no way to rename or re-parent** anything. Add `update({ fileId, name?, addParents?, removeParents? })` → `PATCH /files/{id}` with `addParents`/`removeParents` query params. Needed by three things downstream: T15's rename-follow, T27b's Drive-layout migration, and T15's folder rename.
**Test cases:**
- happy: rename → new name returned, content and id untouched
- happy: move → `addParents` new folder, `removeParents` old; single parent afterwards
- happy: rename + move in one call
- edge: no-op call (neither name nor parents) → rejected as a programming error, not silently sent
- edge: moving a **folder** works identically (folders are files in Drive)
- error: `NotFoundError` on unknown id; `NeedsReauthError` propagates unchanged
- edge: does **not** disturb the version baseline used by `write()`'s optimistic concurrency (metadata-only change) — assert a subsequent `write({fileId})` still succeeds without `RemoteChangedError`
**Acceptance:** tests green; the last test case is mandatory — an `update()` that invalidates the baseline would break decision 19's pure-push path on every rename.

#### T1c — Picker: teardown, `setOrigin`, `setIncludeFolders`
**Deps:** T0
**Files:** `packages/drive-sync/src/picker.ts`, `src/testing/pickerFake.ts`, `src/__tests__/picker.test.ts`
**Do:** Fix decision 29's three gaps.
1. **Teardown (the bug):** on both PICKED and CANCEL, `setVisible(false)`, call `dispose?.()` if present, and remove leftover Picker chrome from the DOM before settling the promise. Guard against double-dispose (null the instance first, as portfolio does). Extend the `PickerInstance` ambient type with optional `dispose()`.
2. `setOrigin(window.location.origin)` on the builder — required for apps served under a base path.
3. `setIncludeFolders(true)` support via an `includeFolders?: boolean` option; extend the `DocsView` ambient type.
Port portfolio's implementation as the reference — it is the version that has actually been run against real Drive.
**Test cases:**
- happy: pick a file → promise resolves AND dialog hidden, disposed, chrome removed
- happy: cancel → `PickerCancelledError` AND same teardown
- edge: callback fires twice → single dispose, no throw
- edge: `dispose` absent on the instance → `setVisible(false)` + chrome removal still happen
- edge: `includeFolders: true` → `setIncludeFolders` called; omitted → not called
- edge: `setOrigin` receives `window.location.origin`
- error: script load failure → rejects, cache reset so a retry re-injects (existing behavior preserved)
- **regression: after a full pick→resolve cycle, `document.body` has no Picker backdrop element left** — this is the assertion that pins the bug
**Acceptance:** tests green; `pickerFake` updated so the teardown assertions are testable; portfolio's `openDrivePicker` becomes deletable with no behavior loss.

#### T2 — Release 0.5.0
**Deps:** T1, T1b, T1c
**Files:** `packages/drive-sync/{package.json,README.md,SPEC.md}`
**Do:** bump `0.4.1` → `0.5.0`. README usage snippets for both additions. SPEC: new resolved decisions recording `subPath` semantics + oldest-wins, and `files.update()`'s metadata-only/baseline-preserving guarantee. Commit; per `CLAUDE.md` tag `drive-sync-v0.5.0` and push.
**Test cases:** n/a
**Acceptance:** version bumped, tag pushed, publish workflow green, `0.5.0` on npm.

#### T3 — Teardown worktree (owa)
**Deps:** T2
**Files:** none
**Do:** cd back, `git worktree remove ../worktree-drive-sync-subpath`.
**Acceptance:** worktree gone, branch retains commit.

---

### Phase 1 — portfolio debt paydown (repo: `portfolio`)

Pure deletion phase. No new abstraction — get portfolio onto a current baseline so Phase 4 is a small diff instead of an archaeology dig.

#### T4 — Create worktree (portfolio)
**Deps:** T2
**Do:** `git worktree add ../worktree-portfolio-drivesync-upgrade -b portfolio/drive-sync-upgrade`.
**Acceptance:** worktree active.

#### T5 — Audit the 830 lines
**Deps:** T4
**Files:** `src/lib/drive.ts` (read-only)
**Do:** Classify every export into: (a) duplicates `drive-sync` 0.5 → delete, (b) genuine app logic (envelope encrypt/decrypt, `AppState` shape) → keep, (c) unclear → list. Expect (a) to cover `getDriveConnection`, `getAccessTokenForPicker`, `getDriveAuthStatus`, `ensureFreshConnection`, `connectDrive`, `disconnectDrive`, `PICKER_LOADER_SRC`, `openDrivePicker`, `extractDriveFileId`, `TOKEN_REAUTH_BUFFER_MS`.
**Test cases:** n/a (analysis)
**Acceptance:** written classification in the PR description; every export accounted for.

#### T6 — Bump to `^0.5.0`, replace connection/auth helpers
**Deps:** T5
**Files:** `package.json`, `src/lib/drive.ts`, `src/App.tsx`
**Do:** Bump dep. Delete category (a) connection helpers; call `drive.project('app').connect()/getConnection()/disconnect()` and use the library's `needsReauth` instead of the app's own token-buffer math.
**Test cases:**
- happy: connect → status shows connected email
- happy: disconnect → connection cleared, no stale token in IDB
- edge: scope change → `needsReauth` true without a network call
- error: connect rejected by user → typed drive-sync error surfaced, app not wedged
**Acceptance:** existing portfolio tests green; `TOKEN_REAUTH_BUFFER_MS` gone.

#### T7 — Replace picker with `drive-sync`'s
**Deps:** T6
**Files:** `src/lib/drive.ts`, callers
**Do:** Delete `PICKER_LOADER_SRC`, `loadPickerApi`, `openDrivePicker`, and the local Picker ambient types; use `project.pickFile({ includeFolders: true })`. The three gaps that previously justified the local copy are fixed upstream in T1c — do **not** reintroduce local script loading. **Keep `extractDriveFileId`** (paste-a-Drive-URL is an app affordance, not picker functionality, per decision 29). Keep portfolio's actionable env-var error messages for a missing API key / unresolvable app id — those are app config concerns.
**Test cases:**
- happy: pick a file → id + name returned; dialog fully torn down (no leftover backdrop)
- edge: user cancels → `PickerCancelledError` handled, app not wedged
- edge: picker opens at My Drive root (not pinned to the app folder) and folders are browsable
- edge: `extractDriveFileId` still handles `/file/d/<id>/`, `?id=<id>`, and bare ids
- error: missing `VITE_GOOGLE_PICKER_API_KEY` → the existing actionable error, unchanged
- error: picker script blocked → typed error, no hang
**Acceptance:** no `apis.google.com` string remains in portfolio; picker tests green; restore-from-picked-file works end to end.

#### T8 — Commit + teardown (portfolio)
**Deps:** T7
**Do:** Verify `drive.ts` is ≤~250 lines and holds only crypto + state logic. Commit, `git worktree remove`.
**Acceptance:** clean tree, commit exists, tests green.

---

### Phase 2 — build the package (repo: `owa`)

#### T9 — Create worktree (owa)
**Deps:** T2
**Do:** `git worktree add ../worktree-project-sync -b project-sync/initial`.
**Acceptance:** worktree active.

#### T10 — Scaffold package
**Deps:** T9
**Files:** `packages/project-sync/{package.json,tsconfig.json,README.md}`
**Do:** Mirror drive-sync's setup. `@open-webapp/project-sync@0.1.0`, `type: module`, exports `.` / `./react` / `./testing`, deps `idb`, **peerDeps** `@open-webapp/drive-sync ^0.5.0` + `react ^18 || ^19` (react optional via `peerDependenciesMeta`), devDeps typescript/vitest/fake-indexeddb + RTL.
**Test cases:** trivial smoke test imports each entrypoint and passes.
**Acceptance:** `npm -w packages/project-sync run build` and `test` both green; workspace picks it up.

#### T11 — Publish workflow + auto-tag rule
**Deps:** T10
**Files:** `.github/workflows/publish.yml`, `CLAUDE.md`
**Do:** Add `project-sync-v*` trigger (parameterize the existing job over package name, or copy the job). Extend the `CLAUDE.md` auto-tag rule to cover `packages/project-sync`.
**Test cases:** n/a
**Acceptance:** workflow file valid; rule documented for both packages.

#### T12 — Freeze public types
**Deps:** T10
**Files:** `packages/project-sync/src/types.ts`
**Do:** Write the API-sketch types for real: `ProjectSyncOptions`, `Project`, `SyncDocument`, `Payload`, `SyncStatus`, `ProjectSync`. Types only, no impl. Enforce in the type system: no codec type exists (decision 10), `merge` is required (decision 11), `documents` is a function (decision 9).
**Test cases:** type-level test file asserting a config missing `merge` fails to compile (`@ts-expect-error`).
**Acceptance:** builds; every interview decision expressible; nothing app-specific leaked in.

#### T13 — Registry: CRUD + unique names
**Deps:** T12
**Files:** `src/registry.ts`, `src/__tests__/registry.test.ts`
**Do:** IDB `projects` store keyed by `id`, plus a `by-name-key` index over a normalized (trimmed, lowercased) name and a `by-created` index. `create/list/get/rename/remove`. Generate opaque stable ids. **`list()` returns `createdAt` ascending** (decision 33) — no ordering API beyond that. `remove()` never touches Drive (decision 31).
**Test cases:**
- happy: create → list returns it with `createdAt`
- happy: `list()` is `createdAt` ascending regardless of insertion or id order
- edge: two projects created in the same millisecond → order is still deterministic (tie-break on id)
- edge: `remove()` issues zero Drive calls
- happy: rename → new name persisted
- edge: create `"Work"` then `"  work "` → rejected as duplicate
- edge: rename to an existing name → rejected, original untouched
- error: empty/whitespace-only name → rejected
- edge: `remove` of unknown id → no-op, no throw
**Acceptance:** tests green under `fake-indexeddb`.

#### T13b — Migration marker plumbing
**Deps:** T13
**Files:** `src/migrations.ts`, `src/__tests__/migrations.test.ts`
**Do:** Implement decision 26 — the only migration code in the package. `app.migrations.hasRun(key)` / `markRun(key)` persisted in the registry db, plus `runOnce(key, fn)` that skips if already marked, runs `fn`, and marks **only on success**. Single-flight so two tabs racing at startup run it once. **No app-specific migration logic here.**
**Test cases:**
- happy: `runOnce` runs `fn` once; second call skips
- edge: `fn` throws → not marked, retried next boot (decision 28)
- edge: two concurrent `runOnce` with the same key → `fn` invoked exactly once, both callers await the same result
- edge: distinct keys are independent
- error: marker write fails after a successful `fn` → surfaced, not swallowed (otherwise the migration silently re-runs forever)
**Acceptance:** tests green; `grep` shows no app names (`notes-diary`, `portfolio`, `planning`) anywhere in package source.

#### T14 — Per-project data-store lifecycle
**Deps:** T13
**Files:** `src/dataStore.ts`, `src/__tests__/dataStore.test.ts`
**Do:** `dbName` = deterministic function of project id. Handle cache. `setActive(id)` / `getActiveDb()`. App-supplied `{version, upgrade}` runs on open. On project delete: close handle, evict cache, `deleteDatabase`. Handle IDB's `versionchange`/blocked events (another tab).
**Test cases:**
- happy: `setActive(a)` then `getActiveDb()` → a's db, app's stores present
- happy: switch a→b→a → correct db each time, handle reused not reopened
- edge: `getActiveDb()` with no active project → **throws a clear error** (never silently defaults — this is decision 4's whole point)
- edge: delete active project → handle closed, database gone, active pointer cleared
- error: `upgrade` throws → open rejects, no half-created db cached
**Acceptance:** tests green; no export lets a caller obtain a handle for a non-active project by accident.

#### T15 — Folder resolution: names-are-truth
**Deps:** T12
**Files:** `src/folders.ts`, `src/__tests__/folders.test.ts`
**Do:** `resolveProjectFolder(project)`: verify cached `driveFolderId` (exists, not trashed, **name still matches**) **once per session** — cache the verification result in memory so a 5-minute sync loop pays for it once, not every tick (decision 24) → else name lookup under `['OpenWebApp', appName]` → else create. Persist the id back to the registry as cache. Two matches → oldest `createdTime`. Rename-follow uses `files.update({fileId, name})` from T1b.
**Test cases:**
- happy: first run → creates `OpenWebApp/<App>/<Project>`, caches id
- happy: second run in the same session → cache hit, **no list and no verify call issued**
- happy: new session → exactly one verification call, then cached
- edge: explicit user-triggered sync ("Sync now") invalidates the memo → exactly one re-verification (decision 34)
- edge: reconnect invalidates the memo
- edge: 10 background interval syncs in one session → exactly one verification total
- edge: folder renamed in Drive → cache discarded, new folder created (old orphaned, per decision 7)
- edge: folder trashed → treated as absent, recreated
- edge: two same-named folders → oldest returned on every call
- edge: app-side project rename → Drive folder renamed, cache preserved
- error: sibling already holds the target name on rename → rejected, no clobber
**Acceptance:** tests green; nothing resolves via `appProperties`.

#### T16 — Document sync engine (version-directed)
**Deps:** T14, T15
**Files:** `src/documents.ts`, `src/__tests__/documents.test.ts`
**Do:** Port notesdiary's **already-shipped** try-write-first algorithm verbatim in semantics (decisions 19–22), generalized over `SyncDocument`. Per project: call `documents(project)` fresh, resolve folder (T15), then per document:
1. Resolve `fileId` — cached id used directly (decision 24); unknown id → `files.list({folderId, nameEquals})` self-heal; still absent → create via `files.write({folderId, name, content, mimeType})` with **no** `fileId` and **no** retry (nothing to conflict with).
2. `content = await doc.readLocal()`. Loop, max **3** attempts: `files.write({fileId, content, mimeType})`. Success → `break` (pure push: no `files.read`, no `merge`, no `writeLocal`).
3. `catch`: rethrow immediately unless `err instanceof RemoteChangedError`. At attempt 3 → `throw new Error('Sync conflict could not be resolved')`. Otherwise `remote = await files.read(fileId)` (resets baseline), `{merged, conflicts} = await doc.merge(await doc.readLocal(), remote)`, `await doc.writeLocal(merged)`, `content = merged`, retry.
Rebuild `merged` from each fresh read; never accumulate across attempts. Log the two `RemoteChangedError` reasons distinguishably. Payloads stay opaque end to end.
**Test cases:** (mirror notesdiary's shipped `driveSyncFilterRuleVersioning.test.tsx` cases so parity is checkable)
- happy: **pure push** — cached `fileId`, write resolves first try → `files.read` NOT called, `files.list` NOT called, `merge` NOT called, `writeLocal` NOT called, write called exactly once with `fileId` and no `folderId`/`name`
- happy: conflict `'remote-changed'` → `files.read` once, `files.write` twice, `merge` got both payloads, `writeLocal` got `merged`
- happy: conflict `'never-restored'` (first sync against a pre-existing file) → same handling, distinguishable log
- happy: create-new-file path — no cached id, `list` returns `[]` → single write with `folderId`+`name`, no `fileId`, no read
- happy: self-heal — no cached id, `list` finds it by name → id flows into the loop, hits `'never-restored'`, resolves
- edge: **retry exhaustion** — `RemoteChangedError` every time → exactly 3 writes, exactly 2 reads, throws `Sync conflict could not be resolved`
- edge: non-`RemoteChangedError` (network) → exactly **1** write, 0 reads, no retry (pins decision 21)
- edge: remote read returns `null`/empty → `merge` receives `null` remote, write proceeds, no crash
- edge: document set changes between syncs (rule added/removed) → new doc synced, removed doc left alone in Drive
- edge: `Uint8Array` payload round-trips byte-identical (portfolio's encrypted case)
- edge: `merge` returns conflicts → surfaced in status, write still proceeds with `merged`
- error: one document fails → other documents still sync; failure reported per document
**Acceptance:** tests green; package source contains no `JSON.parse` of any payload; the pure-push test asserts **zero** reads — that assertion is the guard against regressing the shipped optimization.

#### T16b — Per-document sync state: single writer + serialized persist
**Deps:** T16
**Files:** `src/syncState.ts`, `src/__tests__/syncState.test.ts`
**Do:** Implement decisions 23 and 32. Own `{ [docKey]: { status, driveFileId, lastSynced } }` per project. Expose a **read-only accessor** (`getDocumentState(projectId, docKey)` / all-for-project) so apps can render "last synced" and can perform their own opt-in Drive deletion, plus **`forgetDocument(projectId, docKey)`** to drop state for a document the app removed. The package itself **never** deletes a Drive file, and never infers deletion from a document vanishing from the set (rejected design, decision 32). All mutation goes through one `update(fn)` that applies `fn` to a **synchronously-held** map (no `await` in the critical section, so concurrent document syncs accumulate instead of clobbering) and mirrors it to the status observable. Persist through a **promise-chained queue** so writes land in call order — a bare `await getDB()` before the IDB transaction defeats IDB's creation-order guarantee. A failed persist must not wedge the queue. Transient `'syncing'` is not persisted; only committed `'synced'` snapshots are.
**Test cases:**
- happy: single document sync → state persisted with `driveFileId` + numeric `lastSynced`
- **edge: N documents syncing concurrently, settling in reverse start order → the persisted map contains every document's `driveFileId` and `lastSynced`** (this is the exact bug notesdiary just fixed; it must be impossible here)
- edge: second sync round → no `files.list` for any document (every `driveFileId` survived round one)
- edge: two overlapping `update()` calls → both mutations present, neither lost
- edge: transient `'syncing'` never appears in persisted storage
- error: one persist rejects → queue continues, later persists still land
- edge: stable across `--repeat 4` — a race test that passes intermittently is not a guard
- happy: `getDocumentState` returns `driveFileId` for an app-driven `files.remove()` (decision 32)
- edge: `forgetDocument` clears state without any Drive call
- edge: a document disappearing from `documents(project)` triggers **zero** Drive deletions — including when the set is transiently `[]` before app data loads (the cold-start data-loss trap)
**Acceptance:** exactly one mutation entry point exists (grep-verifiable); concurrency test stable across repeats; the reverse-order test fails if the queue is removed.

#### T17 — Scheduler
**Deps:** T16b
**Files:** `src/scheduler.ts`, `src/__tests__/scheduler.test.ts`
**Do:** `start/stop`, interval (`null` = manual), sync-on-visibility-regain, `markDirty(projectId)` + debounce, single-flight per project (overlapping calls return the in-flight promise), cross-tab leader election over BroadcastChannel so only the leader runs interval syncs.
**Test cases:**
- happy: `start()` with interval → syncs on schedule (fake timers)
- happy: `markDirty` → one sync after debounce, not one per call
- edge: two overlapping `syncNow()` → single underlying run, both callers resolve
- edge: `stop()` mid-flight → no further syncs scheduled; in-flight settles
- edge: disconnect → interval stops firing (no zombie timer)
- edge: two simulated tabs → exactly one runs the interval sync; leader death promotes the other
- error: a sync throws → interval survives and retries next tick
**Acceptance:** tests green with fake timers; no unhandled rejections.

#### T18 — Status observable, reauth poll, error taxonomy
**Deps:** T17
**Files:** `src/status.ts`, `src/errors.ts`, `src/__tests__/status.test.ts`
**Do:** `subscribe(cb)` emitting `{ phase, lastSyncedAt, error, needsReauth, conflicts }` with immutable snapshots (safe for `useSyncExternalStore`). `needsReauth` polled locally every 60s (no network). Re-export drive-sync's error types plus any package-specific ones.
**Test cases:**
- happy: subscriber sees `idle → syncing → idle` with `lastSyncedAt` advanced
- happy: unsubscribe → no further calls, no leak
- edge: snapshot is referentially stable when nothing changed (prevents render loops)
- edge: scope revoked → `needsReauth` flips within one poll, zero network calls
- error: failed sync → `phase: 'error'` carrying the typed error, cleared on next success
**Acceptance:** tests green; no `parseSyncError`-style string sniffing anywhere.

#### T19 — `./react` hooks
**Deps:** T18
**Files:** `src/react/index.tsx`, `src/react/__tests__/hooks.test.tsx`
**Do:** `ProjectSyncProvider` (passes the instance), `useProjects()`, `useActiveProject()`, `useSyncStatus()` — all `useSyncExternalStore`, all read-only. No components, no CSS.
**Test cases:**
- happy: status change re-renders once
- happy: project created → `useProjects()` updates
- edge: unmount → subscription torn down
- edge: no re-render when an unrelated field changes
- error: hook used without provider → clear thrown message
**Acceptance:** RTL tests green; zero exported components.

#### T20 — `./testing` fakes
**Deps:** T16
**Files:** `src/testing/{index.ts,registryFake.ts,driveFolderFake.ts}`
**Do:** In-memory fakes so app tests need no network. Compose with drive-sync's existing `driveFake`/`gisFake`.
**Test cases:** a test that runs a full two-project, three-document sync entirely on fakes.
**Acceptance:** importable from `@open-webapp/project-sync/testing`; no `fetch` reachable.

#### T21 — Exported contract suites
**Deps:** T20
**Files:** `src/testing/contracts.ts`, `src/testing/__tests__/contracts.test.ts`
**Do:** `describeMergeContract(merge, fixtures)` asserting: idempotence (`merge(x, merge(x,y))` stable), no-data-loss (every record id present in either input survives unless the app declares deletion semantics), `null` remote → local passthrough, `null` local → remote adopted, conflicts surfaced not swallowed. `describeDocumentContract(doc)` asserting `readLocal`/`writeLocal` round-trip byte-identical.
**Test cases:** a deliberately-broken merge that drops remote-only records **fails** the suite; a correct one passes.
**Acceptance:** suites run inside a host app's vitest; the negative case is itself a test.

#### T22 — `SPEC.md` + `README.md`
**Deps:** T21
**Files:** `packages/project-sync/{SPEC.md,README.md}`
**Do:** SPEC in drive-sync's style: overview, public API, **all 36 resolved decisions from this plan verbatim**, storage layout (registry db, derived per-project db names, Drive layout), known limitations (single connection, IDB-only, no default merge). Add a **Rejected designs** section — at minimum: auto-deleting Drive files for vanished documents (decision 32, with the cold-start `[]` failure mode spelled out), a default merge strategy (decision 11), a `trashDriveFolder` flag (decision 31), and per-sync folder re-verification (decision 34). Rejected designs are the part of a SPEC that stops the same idea being re-proposed every six months. README = usage for each app shape.
**Acceptance:** every decision in this plan traceable to a SPEC entry.

#### T23 — Publish 0.1.0, commit, teardown
**Deps:** T22
**Do:** Commit; tag `project-sync-v0.1.0`; push; verify workflow; `git worktree remove`.
**Acceptance:** `@open-webapp/project-sync@0.1.0` on npm with provenance.

---

### Phase 3 — notesdiary adopts (repo: `notesdiary`) — hardest app first

#### T24 — Create worktree (notesdiary)
**Deps:** T23
**Do:** `git worktree add ../worktree-notesdiary-project-sync -b notesdiary/project-sync`.

#### T25 — Delete legacy migration
**Deps:** T24
**Files:** `src/lib/projectRegistry.ts`, `src/__tests__/projectRegistryMigration.test.ts`, callers in `App.tsx`
**Do:** Remove `migrateLegacyDbIfNeeded()`, its test file, its call site, and the `isLegacyProject` parameter threading.
**Test cases:** app boots with an existing registry and does not re-seed or touch the old `notes-diary` db.
**Acceptance:** no `notes-diary` literal remains outside a derived db name.

#### T26 — Swap registry + db for the package
**Deps:** T25
**Files:** `package.json`, `src/lib/drive.ts`, delete `src/lib/projectRegistry.ts` + `src/lib/db.ts`, delete their tests
**Do:** Install `@open-webapp/project-sync` + `drive-sync ^0.5`. Build the `createProjectSync` singleton: `appName: 'Notes Diary'`, `registryDbName: 'notes-diary-registry'`, `data: {version: 2, upgrade}` creating `entries` (keyPath `id`, `by-date` index) and `meta`. Delete `ensureProjectFolderId` and the throwaway-instance hack.
**Test cases:**
- happy: existing registry's projects list unchanged after swap
- happy: `entries`/`meta` stores present in a newly created project's db
- edge: `folderPath` is `['OpenWebApp','Notes Diary']` — assertion now lives in the package
- error: no active project → repo calls throw clearly instead of writing to a stale db
**Acceptance:** `projectRegistry.ts` and `db.ts` gone; app builds.

#### T26b — Migration: per-project IDB → package-derived db names
**Deps:** T26
**Files:** `notesdiary/src/lib/migrations/dbNames.ts` (new), `src/__tests__/migrations.dbNames.test.ts`
**Do:** Registered under `runOnce('db-names-v1')`, at boot before any sync. Existing registry records still carry the old `dbName` field (`'notes-diary'` for the legacy project, generated names for the rest); the package derives `dbName` from `id` instead (decision 27). For each project: open old db, copy **both** `entries` and `meta` stores into the package-derived db, verify counts + a sampled record match, `deleteDatabase(old)` only then, and drop the stale `dbName` field from the registry record. Must read the raw registry records **before** the package's registry version upgrade can strip unknown fields.
**Test cases:**
- happy: 3 projects with old names → 3 derived dbs, all entries and meta keys intact, old dbs gone
- happy: legacy project (`dbName: 'notes-diary'`) migrates like any other — no special case
- edge: re-entrant — crash after copy but before delete, then re-run → converges, no duplicated entries
- edge: already-migrated install (marker set) → no-op, no db opened
- edge: project with zero entries → migrates cleanly, empty db created
- edge: `meta` keys preserved exactly, including `filterRules` and drive-connection metadata
- error: copy verification mismatch → throws, old db **left intact**, marker NOT set, app still usable on old data
**Acceptance:** test asserts old db names no longer exist and entry counts match pre-migration exactly; a deliberately corrupted copy fails the verification test.

#### T26c — Migration: Drive layout move
**Deps:** T26b, T1b
**Files:** `notesdiary/src/lib/migrations/driveLayout.ts` (new), `src/__tests__/migrations.driveLayout.test.ts`
**Do:** Registered under `runOnce('drive-layout-v1')`, on first connected sync (needs a live connection, so not at boot). Two moves, using `files.update()` from T1b: (1) the old root folder `Notes Diary` becomes `OpenWebApp/Notes Diary` — create `OpenWebApp` if absent, then re-parent; (2) the legacy project's backup files, which sit **directly in the root folder**, move into a `<Project Name>/` subfolder. Verify each file is readable at its new location before considering the step done. Never delete a file; only re-parent.
**Test cases:**
- happy: root folder re-parented under `OpenWebApp`; folder id unchanged (so cached ids stay valid)
- happy: legacy project's files land in its named subfolder and remain readable
- happy: non-legacy projects' subfolders already correct → untouched
- edge: `OpenWebApp` folder already exists (shared with portfolio/planning) → reused, not duplicated
- edge: re-entrant after partial move → completes without duplicating folders or files
- edge: user already moved things manually → name lookup finds them, migration is a no-op
- edge: baseline preserved — a `write({fileId})` immediately after the move still pure-pushes (no `RemoteChangedError`), pinning T1b's metadata-only guarantee
- error: no connection → migration deferred, marker not set, retried on next connect
- error: `files.update` fails mid-way → error surfaced, marker not set, no data lost
**Acceptance:** tests green on fakes; **manual verification against real Drive is mandatory** for this one (see Test strategy) — it is the only task that mutates a user's existing Drive files.

#### T27 — Repos onto `getActiveDb()`
**Deps:** T26b
**Files:** `src/lib/entriesRepo.ts`, `src/lib/metaRepo.ts`, their tests
**Do:** Replace `setActiveProjectDb`/local handle access with `getActiveDb()`. Keep behavior (incl. empty-text delete in `updateEntryText`).
**Test cases:**
- happy: entry CRUD unchanged
- happy: meta keys (drive connection metadata, filter rules, per-rule state) unchanged
- edge: whitespace-only `updateEntryText` still deletes
- edge: switching projects mid-session writes to the right db (the footgun test — assert by reading raw db contents, not app state)
**Acceptance:** existing repo tests pass with only the handle-acquisition lines changed.

#### T28 — Filter rules → dynamic document set
**Deps:** T27
**Files:** `src/lib/drive.ts`, `src/lib/filterSync.ts` (new or extracted)
**Do:** Implement `documents(project)` mapping each `FilterRule` → a `SyncDocument` (`name` = `ensureJsonExtension(rule.filename)`, `mimeType: 'application/json'`, `merge` = union entries by `id`, local wins). Include the auto-seeded remainder rule. Then **delete the machinery the package now owns** — all of it recently shipped by `drive-sync-version-direction`, so delete deliberately and verify parity, don't leave a second copy running:
- `syncFilterRule`/`syncAllFilters`/`syncAllNow` orchestration
- the `MAX_WRITE_ATTEMPTS` try-write-first loop and the `RemoteChangedError` import in `App.tsx` (now T16)
- `updateFilterSyncState` / `persistFilterSyncState` / `filterSyncStateRef` / `filterSyncPersistQueue` (now T16b)
- the 5-minute interval and 60s reauth poll (now T17/T18)
**Preserve:** `removeFilterRule(id, alsoDeleteFromDrive)` (`App.tsx:281`) keeps working unchanged — read `driveFileId` via the package's `getDocumentState`, call `files.remove()` from the app as today, then `forgetDocument` (decision 32). Behavior and UI identical; only the source of `driveFileId` changes.
**Parity check:** port the assertions from the shipped `driveSyncFilterRuleVersioning.test.tsx` (7 cases) and `driveSyncConcurrentFilterState.test.tsx` (2 cases) as a temporary app-level test against the package. All 9 must pass before deleting the originals. If any fails, the package is wrong — fix T16/T16b, do not weaken the assertion.
**Test cases:**
- happy: 3 rules → 3 documents → 3 Drive files
- happy: union merge — remote-only entries persisted locally and merged into state
- happy: collision → local wins
- edge: rule added at runtime → next sync includes it, no restart
- edge: rule renamed → new file created, old left in Drive (decision 7 applied to files)
- happy: `removeFilterRule(id, true)` → exactly one `files.remove` with the right id, state forgotten
- edge: `removeFilterRule(id, false)` → zero Drive calls, Drive file left intact
- edge: rule removed while its document set is transiently empty → zero Drive deletions
- edge: remainder rule catches entries no other rule matched
- error: malformed remote JSON → that document errors, other documents still sync
**Acceptance:** run `describeMergeContract` against the union merge — green.

#### T28b — Migration: `filterSyncState` meta → package sync state
**Deps:** T28
**Files:** `notesdiary/src/lib/migrations/filterSyncState.ts` (new), `src/__tests__/migrations.filterSyncState.test.ts`
**Do:** Registered under `runOnce('filter-sync-state-v1')`, per project after T26b. Read the `filterSyncState` `meta` key (`Record<ruleId, {status, driveFileId, lastSynced}>`) and write it into the package's per-document sync state, keyed by document key (rule id). Preserving `driveFileId` is the point: lose it and every rule's next sync does a redundant `files.list` self-heal, and every "last synced" timestamp disappears from Settings — the exact user-visible symptom the concurrency fix just removed. Delete the old meta key only after the package state reads back correctly.
**Test cases:**
- happy: 3 rules with `driveFileId` + `lastSynced` → all present in package state, old meta key gone
- happy: first sync after migration issues **no** `files.list` for any rule (the whole point)
- edge: transient `'syncing'` status in the old map → normalized to `'pending'`, not carried over
- edge: rule present in `filterSyncState` but deleted from `filterRules` → dropped, not resurrected
- edge: rule with no `driveFileId` → migrates as unresolved, self-heals on next sync
- edge: absent/empty old key → no-op, marker still set
- error: package state write fails → old meta key retained, marker not set
**Acceptance:** post-migration first sync makes zero `files.list` calls; Settings shows every rule's original timestamp.

#### T29 — `App.tsx` onto `subscribe()` + hooks
**Deps:** T28b
**Files:** `src/App.tsx`, `src/components/ProjectPicker.tsx`
**Do:** Delete the 5-minute interval and the 60s `needsReauth` poll; consume `useSyncStatus()`/`useProjects()`/`useActiveProject()`. Call `markDirty()` on entry mutations. `ProjectPicker` reads hooks.
**Test cases:**
- happy: editing an entry triggers exactly one debounced sync
- happy: status indicator reflects `syncing`/`synced`/`error`
- edge: reauth needed → prompt appears without a forced reconnect on load
- edge: two tabs open → only one syncs
**Acceptance:** no `setInterval` remains in `App.tsx`.

#### T29b — Audit remaining `App.tsx` closure-capture slices (audit only, no fixes)
**Deps:** T29
**Files:** none changed — output goes into this plan's Follow-ups section
**Do:** Implement decision 36. For every `App.tsx` state slice, record: (a) is it mutated from an async handler? (b) does the mutation read prior state from a closure rather than a functional updater or ref? (c) can two such handlers overlap in practice? Start with `entries` — T28's merge path calls `setEntries` from inside per-document sync, which the package now runs **concurrently across documents**, so the overlap condition is newly satisfiable where it previously was not. Then the drive-meta slices. **Fix nothing**; a fix needs its own concurrency test and must not ride along with a phase that swaps the sync engine and runs three migrations.
**Test cases:** n/a (analysis) — but if a slice is found exposed, write a **failing** test reproducing it and mark it `.skip` with a pointer to the follow-up, so the next person inherits a reproduction instead of a suspicion.
**Acceptance:** a written per-slice checklist in Follow-ups, each marked safe / exposed / needs-investigation, with `entries` explicitly adjudicated.

#### T30 — Commit + teardown (notesdiary)
**Deps:** T29b, T26c
**Do:** Full test run; commit; `git worktree remove`.
**Acceptance:** suite green; `drive.ts` under ~120 lines; all three migrations (T26b, T26c, T28b) verified idempotent by re-running the app twice; **release note states no user action is required** — data and Drive files are migrated in place.

---

### Phase 4 — portfolio adopts (repo: `portfolio`)

#### T31 — Create worktree (portfolio)
**Deps:** T30
**Do:** `git worktree add ../worktree-portfolio-project-sync -b portfolio/project-sync`.

#### T32 — Introduce projects
**Deps:** T31
**Files:** `src/lib/persist.ts`, `src/App.tsx`
**Do:** Adopt the registry; state access via `getActiveDb()`. Wire the project switcher. Adoption of the pre-existing `portfolio_app_state_v1` db is **not** done here — T32b owns it as a verified migration.
**Test cases:**
- happy: fresh install → one project auto-created, app works
- happy: second project → fully isolated state, own Drive folder
- edge: existing local db adopted rather than orphaned
- error: no active project → clear throw, not a blank portfolio
**Acceptance:** multi-project works with no UI beyond a project switcher.

#### T32b — Migration: `portfolio_app_state_v1` → first project
**Deps:** T32
**Files:** `portfolio/src/lib/migrations/adoptExistingState.ts` (new), `src/lib/migrations/adoptExistingState.test.ts`
**Do:** Registered under `runOnce('adopt-existing-state-v1')`, at boot. If the registry is empty **and** `portfolio_app_state_v1` exists, create a project (name: `"My Portfolio"`), copy the `app_state` store's `current` record into the project's derived db, verify it reads back and decrypts (or, for an unencrypted install, parses), then `deleteDatabase('portfolio_app_state_v1')`. If the registry is already non-empty, no-op — never re-seed.
**Test cases:**
- happy: existing encrypted state → project created, state readable, old db gone
- happy: existing unencrypted state → same (both envelope shapes handled via `detectEnvelopeShape`)
- happy: fresh install, no old db → one empty project created, no migration marker confusion
- edge: registry already non-empty → no-op even if the old db somehow still exists
- edge: re-entrant after copy, before delete → converges, exactly one project
- edge: old db present but empty/no `current` record → project created empty, old db removed
- error: copied state fails to decrypt with the user's key → old db **retained**, marker unset, clear error (never silently strand an encrypted portfolio)
**Acceptance:** an existing portfolio install opens post-upgrade showing the same positions, with no re-import and no re-entry of the encryption key.

#### T33 — One encrypted document
**Deps:** T32b
**Files:** `src/lib/drive.ts`
**Do:** Single `SyncDocument`: `name: 'portfolio-state.json'`, `readLocal` = load + `encryptState` envelope → `Uint8Array`, `merge` = decrypt both, remote-replace-or-local-wins per existing semantics, `writeLocal` = decrypt + persist. `crypto.ts` untouched. Delete the remaining bespoke `syncBackup`/`restoreBackup`/`getBackupFileId`/`restoreBackupFromFileId`.
**Test cases:**
- happy: sync → encrypted bytes uploaded; restore → state recovered
- happy: bytes round-trip identical (no UTF-8 mangling)
- edge: wrong key → `DriveDecryptError` surfaces as a typed sync error, local state untouched
- edge: remote absent → local uploaded
- error: truncated envelope → error, no partial overwrite
**Acceptance:** `describeDocumentContract` + `describeMergeContract` green; `drive.ts` under ~100 lines.

#### T34 — Commit + teardown (portfolio)
**Deps:** T33
**Do:** Full test run; commit; teardown.
**Acceptance:** suite green; net deletion of ≥700 lines across Phases 1+4.

---

### Phase 5 — planning adopts (repo: `planning`) — the breaking one

#### T35 — Create worktree (planning)
**Deps:** T34
**Do:** `git worktree add ../worktree-planning-project-sync -b planning/project-sync`.

#### T36 — localStorage → package registry + IDB
**Deps:** T35
**Files:** `src/lib/state.ts`, `src/lib/persist.test.ts`, `src/lib/reducer.ts`
**Do:** Delete `savedProjects`, `authByProject`, and the localStorage persistence path. Projects come from the registry; per-project task/milestone data lives in IDB via `getActiveDb()`. Non-project UI prefs may stay in localStorage. **Migration is T36b — do not ship this task without it**, or every planning user loses their projects on upgrade.
**Test cases:**
- happy: create project → tasks/milestones persist across reload
- happy: switch projects → correct data, no bleed
- edge: delete project → its IDB removed
- error: reducer action with no active project → clear error
**Acceptance:** no `savedProjects` in the codebase; `persist.test.ts`'s localStorage suite replaced by T36b's migration tests (not merely deleted).

#### T36b — Migration: localStorage → registry + per-project IDB
**Deps:** T36
**Files:** `planning/src/lib/migrations/localStorageToIdb.ts` (new), `src/lib/migrations/localStorageToIdb.test.ts`
**Do:** Registered under `runOnce('localstorage-to-idb-v1')`, at boot before first render of project data. Read the persisted localStorage app blob: `projects[]` (id, name, `driveFileId`) plus `savedProjects[projectId]` snapshots plus the **active** project's live task/milestone arrays — note the active project's data lives at the top level of the blob, *not* in `savedProjects`, so a naive `savedProjects`-only read silently drops the project the user was last working in. For each project: register it (preserving name and `createdAt` where available), write its tasks/milestones into its derived IDB, and carry `driveFileId` into the package's document sync state so the first sync doesn't re-`list`. Verify every project reads back with matching task/milestone counts, then remove the old localStorage key.
**Test cases:**
- happy: 3 projects (1 active + 2 in `savedProjects`) → all 3 registered, counts match per project
- **edge: the active project's top-level data is migrated, not just `savedProjects`** (the drop-the-current-project trap)
- happy: `driveFileId` per project carried into sync state → first sync issues no `files.list`
- edge: duplicate project names in old data → deduped per decision 8 (suffix the later one), nothing dropped
- edge: single-project install with empty `savedProjects` → migrates the active project
- edge: re-entrant after partial write → converges, no duplicate projects
- edge: no localStorage key at all (fresh install) → no-op, marker set, one empty project created
- edge: malformed JSON in localStorage → migration fails loudly, key retained, marker unset
- error: verification count mismatch → localStorage key **retained**, clear error
**Acceptance:** an existing planning install opens post-upgrade with every project, every task, and every milestone intact; the only thing the user must redo is connecting Drive once (per-project auth → app-wide, T37).

#### T37 — Connection: per-project → app-wide
**Deps:** T36b
**Files:** `src/lib/drive.ts`, `src/App.tsx`, settings UI
**Do:** One connect/disconnect for the whole app (decision 12). Remove per-project auth state and UI. Users reconnect once.
**Test cases:**
- happy: connect once → all projects syncable
- happy: disconnect → all projects stop syncing
- edge: `needsReauth` shown app-wide, once
**Acceptance:** exactly one connection surface in the UI.

#### T38 — CSV document + conflicts-as-data
**Deps:** T37
**Files:** `src/lib/drive.ts`, delete `src/lib/sync.ts` + `src/lib/syncErrors.ts`
**Do:** `SyncDocument` with `mimeType: 'text/csv'`, `name` from `getCSVFilename(project.name)`, `merge` = existing task/milestone merge returning real `conflicts[]`. Conflict dialog + `syncPendingMerge` consume `status.conflicts`. Delete `parseSyncError` in favour of the shared taxonomy.
**Test cases:**
- happy: sync writes CSV; remote CSV merges in
- happy: conflicting edits → conflicts surfaced, dialog opens, resolution applied
- edge: no conflicts → empty array, no dialog
- edge: CSV with quoted commas/newlines round-trips
- error: unparseable CSV → typed error, local data untouched
**Acceptance:** `describeMergeContract` green including the conflict cases; `syncErrors.ts` gone.

#### T38b — Delete the Sheets tombstone
**Deps:** T38
**Files:** delete `planning/src/lib/googleSheets.ts`; edit `src/lib/state.ts:819`, `src/__tests__/syncDropdowns.test.ts:40`
**Do:** Decision 30. `googleSheets.ts` is a 4-line tombstone pointing at `src/lib/googleAuth.ts`, which no longer exists — a dead pointer to a dead file. Delete it and fix the two stale "spreadsheet sync" mentions (a comment and a test name) to say CSV/Drive sync.
**Test cases:**
- happy: full suite green after deletion (confirms nothing imported it)
- edge: `grep -ri 'sheet' src` returns no misleading hits
**Acceptance:** file gone, no stale Sheets language anywhere in planning.

#### T39 — Commit + teardown (planning)
**Deps:** T38b
**Do:** Full test run; commit; teardown.
**Acceptance:** suite green; T36b verified idempotent across two boots; release notes state the one real break plainly — **projects and tasks are migrated**, but Drive must be reconnected once and per-project Google accounts are gone.

---

### Phase 6 — docs

#### T40 — Update all four repos' docs
**Deps:** T39
**Files:** `owa/packages/project-sync/SPEC.md`, and `CLAUDE.md`/`schema-spec.md`/`product-behavior.md` in each app
**Do:** Rewrite the architecture sections that this work invalidates. Specifically: notesdiary's "Multi-project model" and "Data layer (per project)" sections, its `folderPath`-is-load-bearing warning (now the package's invariant), and the `drive.test.ts` pin note; planning's persistence + per-project-auth description; portfolio's single-state description. Each app's Drive section becomes a pointer to `project-sync`'s SPEC plus only its own merge/codec specifics.
**Test cases:** n/a
**Acceptance:** no doc still describes app-owned registry, app-owned db handles, per-project auth, or the legacy folder special-case.

---

## Test strategy
- **Package:** unit tests per module under `fake-indexeddb` + drive-sync's fakes. The scheduler uses fake timers. Cross-tab behavior tested by driving two instances against one shared fake BroadcastChannel.
- **Adapters:** every app runs the exported `describeMergeContract` / `describeDocumentContract` against its own merge and document. This is the real regression net — merge is the only place a bug loses user data silently.
- **Apps:** existing suites are the baseline and must stay green, with one intentional exception: notesdiary's `folderPath` pin test, whose assertion relocates to the package. Any *other* failing test is a regression, not a rename.
- **Migrations:** every one is tested for (a) correctness against realistic old-shape fixtures, (b) **idempotence** — run twice, converge, and (c) **failure safety** — a forced verification mismatch must leave the old data intact with the marker unset. Item (c) is the one people skip and the one that matters; a migration that half-runs is worse than one that doesn't run.
- **Pure-push parity:** the package's zero-read assertion (T16) plus notesdiary's 9 ported assertions (T28) are the gate that adoption doesn't regress the shipped `drive-sync-version-direction` work. Treat a failure there as a package bug, never as a test to relax.
- **Manual, once, against real Drive** (fakes can't cover it): connect; sync two projects; rename a project and confirm the Drive folder follows; rename a folder in Drive and confirm a fresh one is created with no data loss; trash a folder and confirm recreation; open two tabs and confirm one syncer.
- **Manual, mandatory, on a copy of a real notesdiary account for T26c** — the Drive-layout migration is the only step that mutates files a user already has. Verify: files readable at their new path, folder ids unchanged, and the immediately-following sync is a pure push (no `RemoteChangedError` storm).

## Risks
- **Silent Drive misresolution** — the historical failure mode: wrong folder = empty folder, no error. *Mitigation:* names-are-truth with verified cache (T15) has explicit tests for rename/trash/duplicate; the resolved `folderPath` is asserted in the package, not in three apps.
- **Duplicate `drive-sync` in the tree** → two token refreshers racing one IDB record. *Mitigation:* peer dep (T10) makes it an install error; the package never constructs its own instance.
- **A wrong app merge silently drops records.** *Mitigation:* no default merge ships; the contract suite's no-data-loss assertion is mandatory per app.
- **Abstraction doesn't fit the hardest app** — discovered too late. *Mitigation:* notesdiary adopts first (T24–T30), before portfolio/planning are touched; `0.1.0` is explicitly churnable.
- **Cross-tab leader election is subtle** (leader dies holding the lease). *Mitigation:* lease with expiry + promotion test in T17; worst case degrades to every tab syncing, which single-flight and local-wins already tolerate.
- **Adoption silently regresses the just-shipped version-directed write** by reintroducing a read per sync. *Mitigation:* T16's pure-push test asserts **zero** `files.read`/`files.list` calls, and T28 ports all 9 shipped assertions as a gate before deleting the app-side originals.
- **The concurrency bug notesdiary just fixed reappears inside the package**, now affecting all three apps at once. *Mitigation:* T16b reproduces it (N documents settling in reverse order) and requires stability across `--repeat 4`.
- **A migration half-runs and strands a user between two schemas.** *Mitigation:* decision 28 — verify before delete, mark only on success, re-entrant by construction; every migration task carries an explicit failure-safety test case.
- **T26c mutates real Drive files** — the single highest-blast-radius step in the plan. *Mitigation:* re-parent only (never delete), verify readability per file, idempotent, and gated on manual verification against a real account.
- **planning's migration drops the active project** by reading only `savedProjects` (the live project's data sits at the blob's top level). *Mitigation:* called out explicitly in T36b with a dedicated test case.
- **planning users lose per-project Google accounts.** *Mitigation:* stated in release notes at T39; deliberate per decision 12 — this is the one break migration cannot paper over.

## Open questions

**None.** All eight are resolved as decisions 29–36 above. Two were answered by reading the code rather than deciding (the picker gaps; planning's Sheets integration, which does not exist). Do not re-open without a new fact.

## Follow-ups (not this plan)

- **Fix** whatever T29b's audit finds exposed in `App.tsx` (decision 36). T29b produces the checklist and, where it finds a real hole, a `.skip`ped reproduction test.
- **Retire migrations at 12 months** (decision 35): swap each migration body for a detector + raw JSON export, same file path, same `runOnce` key. Earliest trigger is 12 months after T30/T34/T39 ship.
- Per-project Google accounts, if planning users miss them — additive, since `drive-sync` already keys storage by `projectId`; costs one reconnect.
- `lastOpenedAt` on the registry if any app wants recency-sorted projects (decision 33 deliberately left it out).

## Post-change doc updates
Covered by T40. Convention: `owa` documents packages in `README.md` + `SPEC.md` (SPEC carries the numbered resolved decisions); each app documents architecture in `CLAUDE.md` with `schema-spec.md` / `product-behavior.md` alongside. `owa/CLAUDE.md`'s auto-tag rule is extended in T11 to cover both packages.
