# Plan: drive-sync-modified-time

## Goal
Right now `p.files.list()` only asks Drive for `id,name,mimeType,version` — no timestamp. An app wiring filter-mode sync (e.g. notesdiary/app, in a companion plan) wants to show/compare "last modified" per remote file without an extra per-file round trip. `fetchRemoteVersion()` in `src/files.ts` already asks Drive for `modifiedTime` on a single-file GET and threads it through to `FileState.remoteModifiedTime` — we just extend the same field, same pattern, into `list()`'s bulk fetch. This is a query-string + type change only: no new fetch call, no signature change, purely additive. Minor version bump (repo convention for additive changes: 0.1.0->0.2.0->0.3.0).

## Scope
**In scope:**
- `modifiedTime?: string` added to `FileRef` in `src/types.ts`.
- `list()`'s Drive `fields` query param in `src/files.ts` extended to request `modifiedTime`.
- `src/testing/driveFake.ts` extended so its in-memory files can carry/return `modifiedTime` (needed to actually exercise the new field in a test — the fake currently drops it entirely, for every endpoint, even though `fetchRemoteVersion` already requests it).
- One unit test in `src/__tests__/files.test.ts` proving `modifiedTime` flows from a seeded fake file through `list()` into the returned `FileRef[]`.
- `package.json` version bump `0.3.0` -> `0.4.0`.
- `SPEC.md`: one new appended resolved decision (current heading is already "The 35 resolved design decisions" from the picker plan; this becomes #36, heading retitled).
- `README.md`: fix the decision-count reference (currently stuck at "the 34 resolved decisions", already stale even before this plan — sync it to the real total, 36).
- Worktree create/cleanup bookend tasks.
- Final flagged (not autonomous) `npm publish` task.

**Out of scope:**
- Any other `FilesHandle` method (`read()`, `write()`, `remove()`, `status()`) — `status()` already exposes `remoteModifiedTime` via `fetchRemoteVersion`, untouched here.
- The Picker/`pickFile()` feature (already shipped, `plans/drive-sync-picker.md`).
- Any change outside `packages/drive-sync`.
- Any change to `ListOptions`'s shape (no new filter/sort-by-modifiedTime option) — this plan only adds a field to what comes back, not a new query capability.

## Resolved decisions
1. `FileRef.modifiedTime` is `string | undefined`, matching Drive's RFC3339 timestamp string returned as JSON (same type `fetchRemoteVersion`'s local return type already uses for the identical field name).
2. `list()`'s fields string changes from `'files(id,name,mimeType,version)'` to `'files(id,name,mimeType,version,modifiedTime)'` — one line, `src/files.ts` line ~383-384. No change to `buildQuery()` or `ListOptions`.
3. The `json.files` cast in `list()` (`(await res.json()) as { files?: FileRef[] }`) already flows arbitrary response fields into `FileRef[]` — no new parsing/mapping code needed, purely a query-string + type change.
4. `driveFake.ts`'s `DriveFakeFile` gets an optional `modifiedTime?: string` field (tests seed it directly via `driveFake.files.set(id, {...})`, same pattern as seeding `version`); `fileToMetadata()` includes it in every response (list AND single-get) when present. This is a testing-utility change, not a library behavior change — it exists solely so the new field is actually testable end-to-end instead of asserting on the request URL alone.
5. Version bump `0.3.0` -> `0.4.0` (minor, additive-only, no existing exported signature changes) — matches repo's stated practice for additive changes.
6. SPEC.md's resolved-decisions section gets exactly ONE new appended item (#36, following on from the picker plan's #35), heading retitled to "The 36 resolved design decisions". README.md's decision-count reference (currently "the 34 resolved decisions" — already stale, predates this plan) is corrected to 36 in the same pass, since we're touching that line anyway.
7. `npm publish` is the final task but is NOT run automatically as part of the task chain — it is explicitly flagged in Risks and must only be run after the implementing agent pauses and gets explicit user go-ahead (publishing is irreversible/affects shared external package state).

## Affected files
- `packages/drive-sync/src/types.ts` — add `modifiedTime?: string` to `FileRef`.
- `packages/drive-sync/src/files.ts` — `list()`'s `fields` query string gains `,modifiedTime`.
- `packages/drive-sync/src/testing/driveFake.ts` — `DriveFakeFile` gains optional `modifiedTime`; `fileToMetadata()` includes it when present.
- `packages/drive-sync/src/__tests__/files.test.ts` — new test: seed a fake file with `modifiedTime`, call `list()`, assert it round-trips.
- `packages/drive-sync/package.json` — version `0.3.0` -> `0.4.0`.
- `packages/drive-sync/SPEC.md` — decision #36 appended, heading count corrected.
- `packages/drive-sync/README.md` — decision-count reference corrected to 36.

## Tasks

### T0 — Create git worktree
**Deps:** none
**Files:** none (git only)
**Do:** From `/Users/mdoraiswamy/owa/owa`, run `git worktree add ../worktree-drive-sync-modified-time -b feature/drive-sync-modified-time`, then `cd ../worktree-drive-sync-modified-time`. All following tasks happen inside this worktree, at `packages/drive-sync/` under it.
**Test cases:** n/a
**Acceptance:** worktree exists at `../worktree-drive-sync-modified-time`, branch `feature/drive-sync-modified-time` checked out, cwd is the worktree.

### T1 — Add modifiedTime to FileRef
**Deps:** T0
**Files:** `packages/drive-sync/src/types.ts`
**Do:** Read the file. In the `FileRef` interface (currently `id`, `name?`, `version?`), add:
```ts
/** Drive's last-modified timestamp (RFC3339), when the call requested it. */
modifiedTime?: string;
```
Place it after `version?: string;`, matching the existing doc-comment style on that interface. Do not touch any other type.
**Test cases:**
- happy: a `FileRef` literal with `modifiedTime` set type-checks.
- edge: a `FileRef` literal omitting `modifiedTime` still type-checks (field is optional, no call site breaks).
- error: n/a (compile-time only, verified via `tsc --noEmit`).
**Acceptance:** `tsc --noEmit` passes in `packages/drive-sync`; `modifiedTime` field present and optional on `FileRef`.

### T2 — Extend list()'s fields query
**Deps:** T1
**Files:** `packages/drive-sync/src/files.ts`
**Do:** In `list()` (~line 378-384), change:
```ts
const url = `${DRIVE_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(
  'files(id,name,mimeType,version)'
)}`;
```
to request `modifiedTime` too:
```ts
const url = `${DRIVE_BASE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent(
  'files(id,name,mimeType,version,modifiedTime)'
)}`;
```
Update the comment two lines above (currently explaining why `version` comes back for `write()`'s staleness check) to also note `modifiedTime` is requested for callers that want a last-modified timestamp per file without an extra round trip — do not remove the existing `version` rationale, append to it. No other line in `list()`, `buildQuery()`, or `ListOptions` changes.
**Test cases:**
- happy: `list()` still returns files matching the existing query clauses (folderId/mimeType/nameEquals/trashed) — no regression to filtering.
- edge: a file with no `modifiedTime` in the raw JSON response (e.g. an old fake, or a Drive edge case) resolves to `modifiedTime: undefined` on the returned `FileRef`, not a thrown error.
- error: n/a (no new error path; existing `driveFetch` error handling is unchanged).
**Acceptance:** `tsc --noEmit` passes; the `fields` query string in the built URL contains `modifiedTime` (verify via T4's test or a quick manual log).

### T3 — Extend driveFake to carry modifiedTime
**Deps:** T0
**Files:** `packages/drive-sync/src/testing/driveFake.ts`
**Do:**
- In `DriveFakeFile` (~line 20-33), add `modifiedTime?: string` near `version?: number`, with a doc comment: "Drive's last-modified timestamp; optional so tests may seed files without it (omitted from the fake's response in that case, matching real Drive's `fields`-gated behavior)."
- In `fileToMetadata()` (~line 209-211), extend the returned object to include `modifiedTime: f.modifiedTime` only when the caller cares — simplest correct approach: always include the key in the returned object (`modifiedTime: f.modifiedTime`), letting it be `undefined` when unset, since `jsonResponse`/`JSON.stringify` will simply omit an `undefined`-valued key when serialized (confirm this is in fact how `jsonResponse` serializes before relying on it — if it uses `JSON.stringify` directly, `undefined` values ARE dropped, which is the desired behavior; if it does something else, explicitly delete the key when `f.modifiedTime === undefined` instead).
- Do not change `handleFilesList`'s filtering logic, `handleFileGet`, or any create/update path — files that never set `modifiedTime` behave exactly as before.
**Test cases:**
- happy: a `DriveFakeFile` seeded with `modifiedTime: '2026-01-01T00:00:00.000Z'` comes back from both `handleFilesList` and `handleFileGet` with that same value.
- edge: a `DriveFakeFile` seeded WITHOUT `modifiedTime` comes back with the key absent/undefined (no `"modifiedTime": null` or similar leaking into the JSON), preserving old test behavior for every existing test that doesn't set it.
- error: n/a (fake has no error path here).
**Acceptance:** `tsc --noEmit` passes; existing `files.test.ts` suite (pre-T4) still passes unmodified, proving this is backward compatible.

### T4 — Add unit test for modifiedTime through list()
**Deps:** T2, T3
**Files:** `packages/drive-sync/src/__tests__/files.test.ts`
**Do:** Read the file's existing `list()`-adjacent tests (`ensureFolderPath`/`write`-by-name tests already exercise `list()` indirectly) for setup conventions (`makeProject()`, `connect()`, `queueToken()`, `driveFake`). Add a new test, e.g.:
```ts
it('list() returns modifiedTime when the fake file has one', async () => {
  const project = makeProject()
  await connect(project)

  const fileId = freshId('file')
  driveFake.files.set(fileId, {
    id: fileId,
    name: 'has-timestamp.txt',
    mimeType: 'text/plain',
    parents: [],
    content: 'x',
    modifiedTime: '2026-01-01T00:00:00.000Z',
  })

  queueToken()
  const results = await project.files.list({ nameEquals: 'has-timestamp.txt' })
  expect(results).toHaveLength(1)
  expect(results[0].modifiedTime).toBe('2026-01-01T00:00:00.000Z')
})
```
Also add (or extend the same test with) an edge case: a second file seeded without `modifiedTime` set, listed by a query matching both, asserting that file's `modifiedTime` is `undefined` while the first file's is still the seeded value — proves the field is per-file, not accidentally shared/defaulted.
**Test cases:**
- happy: seeded `modifiedTime` round-trips through `list()` unchanged.
- edge: a file with no seeded `modifiedTime` returns `undefined` for that field, doesn't throw, doesn't affect other returned fields (`id`/`name`/`mimeType`/`version`).
- error: n/a (no error path introduced).
**Acceptance:** `npx vitest run src/__tests__/files.test.ts` passes, including the new test(s); no existing test in the file needed modification (T3's backward-compat requirement holds).

### T5 — Bump package.json version
**Deps:** T2, T3, T4
**Files:** `packages/drive-sync/package.json`
**Do:** Change `"version": "0.3.0"` to `"version": "0.4.0"`. No other field changes.
**Test cases:**
- happy: `npm pkg get version` (or manual read) shows `0.4.0`.
- edge: `exports`/`files`/`dependencies` maps unchanged.
- error: n/a.
**Acceptance:** version field is `0.4.0`; `node -e "require('./package.json')"` (or equivalent) doesn't throw.

### T6 — Update SPEC.md
**Deps:** T2, T3, T4
**Files:** `packages/drive-sync/SPEC.md`
**Do:**
- Section "## 2. The 35 resolved design decisions" (line ~53): append item **36**, terse and source-referencing, in the same style as the existing entries, e.g.: "36. **`list()` returns `modifiedTime`** — `files.ts`'s `list()` requests `modifiedTime` alongside `id,name,mimeType,version` (same field `fetchRemoteVersion` already fetches per-file for `status()`); `FileRef.modifiedTime` (`types.ts`) is optional since older/unfetched responses may omit it."
- Retitle the heading to "## 2. The 36 resolved design decisions".
- Line ~49 ("files implementing the surface..."): no new file was added (only existing files changed), so no edit needed there — confirm this by re-reading that line before skipping it.
**Test cases:** n/a (docs).
**Acceptance:** SPEC.md's decision list ends at #36; heading count matches the actual list length (count manually to verify); no other section altered.

### T7 — Update README.md
**Deps:** T6
**Files:** `packages/drive-sync/README.md`
**Do:** Update the "See `SPEC.md` for the full design: the 34 resolved decisions" line (~line 32) to read "36 resolved decisions", matching SPEC.md's corrected heading from T6. (This also fixes pre-existing drift: the line was already stale at "34" even before this plan, since the picker plan had bumped the real total to 35 without updating README.) No other line changes.
**Test cases:** n/a (docs).
**Acceptance:** README's decision count matches SPEC.md's heading exactly (36).

### T8 — Run full test suite and typecheck
**Deps:** T4, T5, T6, T7
**Files:** none (verification only)
**Do:** From `packages/drive-sync`, run `npx tsc --noEmit` and `npx vitest run`. Fix any fallout before proceeding.
**Test cases:**
- happy: all tests pass, 0 typecheck errors.
- edge: run `vitest run` twice in a row to rule out test-order-dependent flakiness from the `driveFake.files` Map being shared/mutated across tests in the same file.
- error: any failure is fixed here, not deferred to a later task.
**Acceptance:** `tsc --noEmit` exits 0; `vitest run` exits 0, all suites green including the new test(s) from T4.

### T9 — Commit
**Deps:** T8
**Files:** none (git only)
**Do:** From the worktree, `git add packages/drive-sync`, commit with a message describing the `modifiedTime` addition to `FileRef`/`list()`, the `driveFake` testing-utility extension, version bump, and doc updates.
**Test cases:** n/a
**Acceptance:** commit exists on `feature/drive-sync-modified-time`, `git status` clean.

### T10 — Cleanup git worktree
**Deps:** T9
**Files:** none (git only)
**Do:** `cd /Users/mdoraiswamy/owa/owa`, then `git worktree remove ../worktree-drive-sync-modified-time`.
**Test cases:** n/a
**Acceptance:** worktree removed, original directory `/Users/mdoraiswamy/owa/owa` active, branch `feature/drive-sync-modified-time` still exists with the commit (verify via `git branch -a` / `git log feature/drive-sync-modified-time -1`).

### T11 — Publish to npm (REQUIRES EXPLICIT USER CONFIRMATION — DO NOT RUN AUTONOMOUSLY)
**Deps:** T10
**Files:** none (publish only)
**Do:** **STOP before running this task.** Publishing affects real, shared, external state (a live npm registry, consumed by other apps/repos) and cannot be undone by a `git revert`. The implementing agent MUST pause here and get explicit user go-ahead before running anything in this task — do not chain it automatically after T10 just because dependencies are satisfied. Once confirmed: from `/Users/mdoraiswamy/owa/owa` (or the branch's merged/released location per repo's normal release process — confirm whether this repo publishes from a merged `main` or directly from the feature branch before running), run `npm publish` inside `packages/drive-sync` (respecting its `publishConfig.access: "public"`). Verify afterward that `npm view @open-webapp/drive-sync version` reports `0.4.0`.
**Test cases:**
- happy: `npm publish` succeeds, registry shows `0.4.0`.
- edge: if version `0.4.0` was already published (e.g. a retry), `npm publish` fails loudly with an existing-version error — do not force-republish; investigate why before retrying.
- error: publish fails (auth, network, lint/prepublish script) — do not retry blindly; surface the exact error to the user.
**Acceptance:** `npm view @open-webapp/drive-sync version` returns `0.4.0`; user explicitly confirmed before this task ran.

## Test strategy
Entirely unit-level, in-process, no live Google Cloud credentials needed — same as the rest of the package's test suite. The only new testing-surface change is `driveFake.ts` gaining an optional `modifiedTime` field on its in-memory file record and echoing it back in `fileToMetadata()`; this is exercised directly by T4's new test in `files.test.ts`, which seeds a fake file with and without `modifiedTime` and asserts both cases round-trip correctly through `list()`. Existing tests are the regression guard: because the new field is optional and defaults to absent, T3's requirement is that every pre-existing test in `files.test.ts` (and any other file touching `driveFake`) continues to pass unmodified. Final gate is T8: full `tsc --noEmit` + `vitest run` for the whole package, run twice to catch any order-dependent state leakage from the shared `driveFake.files` Map.

## Risks
- **`npm publish` (T11) affects shared external state and is irreversible** — mitigated by explicitly flagging it as requiring a pause for user go-ahead, not chaining it automatically after the worktree-cleanup task; the implementing agent must not run it as part of an autopilot task sequence.
- `driveFake.ts`'s `jsonResponse` helper's exact serialization behavior for `undefined`-valued keys is assumed (dropped by `JSON.stringify`) rather than confirmed at plan-write time — mitigated by T3's explicit instruction to verify this assumption against the actual helper before relying on it, and to fall back to explicit key deletion if it doesn't hold.
- Real Google Drive's `modifiedTime` format/timezone behavior can't be verified against the fake alone — mitigated by this being a pure passthrough of whatever Drive returns (same as the already-shipped `fetchRemoteVersion`/`FileState.remoteModifiedTime` path), so no new parsing logic exists to be wrong.
- SPEC.md/README.md decision-count drift has already happened once (README stuck at "34" after the picker plan bumped SPEC to 35) — mitigated by T7 explicitly re-deriving the count from SPEC.md's actual heading rather than incrementing README's stale number by one.

## Open questions
- Confirm before T11: does this repo publish from a merged `main`/release branch, or directly from a feature branch? Not resolved by this plan — ask the user or check for a CI publish workflow before running T11.

## Post-change doc updates
- `packages/drive-sync/SPEC.md`: decision #36 appended (T6), heading retitled to "36 resolved design decisions" (T6).
- `packages/drive-sync/README.md`: decision-count reference corrected to 36, also fixing pre-existing drift from the picker plan (T7).
- No `product-behavior.md`/`design.md`/`schema-spec.md` exist for this package (SPEC.md/README.md are its reference docs) — nothing else to update.
