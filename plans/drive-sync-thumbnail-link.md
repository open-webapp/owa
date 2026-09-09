# Plan: drive-sync `thumbnailLink` + image dimensions on `files.list()`

## Goal
Calling apps want to show small preview pics for image files without downloading them. Google Drive already hands back a `thumbnailLink` URL and image pixel size, but `@open-webapp/drive-sync`'s `files.list()` does not ask for those fields, so callers never see them. This plan makes `list()` always request `thumbnailLink` and `imageMediaMetadata(width,height,rotation)`, adds three optional fields to `FileRef` (`mimeType`, `thumbnailLink`, `imageMediaMetadata` with `width`/`height`/`rotation`), teaches the in-memory `driveFake` to echo them, tests the pass-through, records the decision in `SPEC.md` (and fixes the stale decision-count header), bumps the package `0.6.0` → `0.7.0`, and ships it via the repo's `drive-sync-v<version>` tag release flow. Raw pass-through only: no blob fetch, no URL munging, no new helper, no mime filter.

## Scope

**In scope:**
- `packages/drive-sync/src/files.ts` — `list()` `fields` query param only.
- `packages/drive-sync/src/types.ts` — three new optional `FileRef` fields.
- `packages/drive-sync/src/testing/driveFake.ts` — `DriveFakeFile` + `fileToMetadata()` echo the new keys when seeded.
- `packages/drive-sync/src/__tests__/files.test.ts` — new `list()` cases.
- `packages/drive-sync/SPEC.md` — new resolved-decision entry.
- `packages/drive-sync/package.json` — version bump.
- `plans/drive-connect-p1-package.md` — one non-blocking courtesy line near decision 2.
- Git worktree bookends + commit + merge to `main` + `drive-sync-v0.7.0` tag push.

**Out of scope:**
- `write()`, `status()`, `read()`, `fetchRemoteVersion()` — no changes.
- No `files.thumbnail()` / fetch-to-blob / URL-rewrite / `=s220` size-suffix helper.
- No `image/` mime-type filtering anywhere; no new opt-in flag on `ListOptions` or the public `list()` signature.
- No `README.md` change.
- No code changes to `packages/drive-connect` or `packages/project-sync` (only the one-line note in the drive-connect PLAN file).
- Not renumbering existing SPEC decision entries (the duplicate `7.` / merged `25–27.` stay as-is); T5 only corrects the header *number* to the true entry count and appends one new entry.

## Resolved decisions
1. Scope is `files.list()` ONLY.
2. `list()` `fields` changes from `files(id,name,mimeType,version,modifiedTime)` to `files(id,name,mimeType,version,modifiedTime,thumbnailLink,imageMediaMetadata(width,height,rotation))`.
3. `FileRef` (`types.ts`) gains three optional fields, terse JSDoc consistent with existing `version?`/`modifiedTime?` (fields-gated / may be absent):
   - `mimeType?: string` — already fetched by `list()` today, just missing from the type.
   - `thumbnailLink?: string`
   - `imageMediaMetadata?: { width?: number; height?: number; rotation?: number }` — nested object mirroring Drive's real response shape (`rotation` lets a caller orient the thumbnail).
4. Unfiltered: `list()` returns whatever Drive provides per file regardless of mime type. No `image/` prefix check. The fields are ALWAYS requested — no opt-in flag.
5. Raw pass-through: `thumbnailLink` returned verbatim. No fetch-to-blob, no URL rewriting, no `=s220` munging, no `files.thumbnail()` helper.
6. `driveFake.ts`: `DriveFakeFile` gains `thumbnailLink?: string` and `imageMediaMetadata?: { width?: number; height?: number; rotation?: number }`. `fileToMetadata()` includes each key ONLY when the seeded file has it set (mirror how `modifiedTime` is conditionally handled today). `handleFilesList()` needs no query-parsing change.
7. Tests live in `packages/drive-sync/src/__tests__/files.test.ts`, mirroring the existing `list() returns modifiedTime …` test harness (`makeProject` / `connect` / `queueToken` / `driveFake.files.set`).
8. `SPEC.md` records the three new optional `FileRef` fields on `list()` AND the caveat: `thumbnailLink` is a short-lived URL (~hours) that may need the browser to carry Google auth context for the file's account — a cross-origin bare `<img src>` can 403; the consuming app owns rendering and can fall back to `getAccessToken()` + fetch-to-blob itself. Same task also corrects the stale `## 2. The 36 resolved design decisions` header to the true entry count (see T5): count the numbered decision entries in the live file, add the new one, set the header number to the resulting count, and assert header number == entry count.
9. Version bump `packages/drive-sync/package.json` `0.6.0` → `0.7.0`.
10. `plans/drive-connect-p1-package.md` gets a one-line note near decision 2 (the `"@open-webapp/drive-sync": "^0.6.0"` peer pin) flagging drive-sync is now `0.7.0` and the peer range should become `^0.7.0` (or `>=0.6.0`) when that plan runs. Courtesy note only — non-blocking, no code change there.
11. Release flow matches repo `CLAUDE.md`: all work on an isolated git-worktree branch; commit the drive-sync changes; merge to `main`; then `git tag drive-sync-v0.7.0 && git push origin drive-sync-v0.7.0` (triggers `.github/workflows/publish.yml` → real npm publish). Final substantive task pushes the tag; then worktree teardown.
12. Order `types.ts` before `driveFake.ts` so the nested `imageMediaMetadata` shape is authored once and referenced.

## Affected files
- `packages/drive-sync/src/types.ts` — add `mimeType?`, `thumbnailLink?`, `imageMediaMetadata?: { width?; height?; rotation? }` to `FileRef` (after line 67).
- `packages/drive-sync/src/files.ts` — extend the `fields` string literal in `list()` (~line 399) with `thumbnailLink,imageMediaMetadata(width,height,rotation)`; update the adjacent comment (~lines 394-397) to mention the new fields.
- `packages/drive-sync/src/testing/driveFake.ts` — add two optional fields to `DriveFakeFile` (~line 38, `imageMediaMetadata` carrying `width`/`height`/`rotation`); conditionally include them in `fileToMetadata()` (~line 215).
- `packages/drive-sync/src/__tests__/files.test.ts` — add `list()` thumbnail/dimensions(+rotation)/mimeType cases near the existing `modifiedTime` test (~line 601).
- `packages/drive-sync/SPEC.md` — append a new numbered resolved-decision entry after the current last one (~line 108) about the three new `FileRef` fields + the 403 caveat, AND fix the `## 2. The 36 resolved design decisions` header (line 53) to the true post-append entry count.
- `packages/drive-sync/package.json` — `version` `0.6.0` → `0.7.0` (line 3).
- `plans/drive-connect-p1-package.md` — one courtesy line near decision 2 (~line 27).
- `packages/drive-sync/src/index.ts` — NO code change (already `export type { … FileRef … }`); verify only.

## Tasks

Each task: id, deps, files touched, what to do, test cases (happy + edge + error), acceptance. Each ≤30 min.

### T0 — Create git worktree
**Deps:** none
**Files:** none (git only)
**Do:** From `/home/mohan/owa/owa` run `git worktree add ../worktree-drive-sync-thumb -b feature/drive-sync-thumbnail-link`, then `cd ../worktree-drive-sync-thumb`. All later tasks happen inside this worktree.
**Test cases:** n/a
**Acceptance:** `git worktree list` shows `../worktree-drive-sync-thumb` on branch `feature/drive-sync-thumbnail-link`; cwd is the worktree; `git status` clean.

### T1 — Add three optional fields to `FileRef`
**Deps:** T0
**Files:** `packages/drive-sync/src/types.ts`
**Do:** In `interface FileRef` (lines 61-68), after `modifiedTime?`, add:
- `mimeType?: string` — JSDoc: Drive MIME type, when the call requested it.
- `thumbnailLink?: string` — JSDoc: short-lived Drive thumbnail URL, when the call requested it and Drive supplied one; may be absent.
- `imageMediaMetadata?: { width?: number; height?: number; rotation?: number }` — JSDoc: pixel dimensions (+ `rotation`, 0/90/180/270) for image files, when Drive supplied them.
Keep JSDoc one line each, matching the terseness of the existing `version?` / `modifiedTime?` comments (fields-gated / may be absent). Do NOT extract a named type for the nested object — inline it (referenced again in T3).
**Test cases:**
- happy: `npx tsc --noEmit -p packages/drive-sync` clean; a `FileRef` literal with all three new fields (incl. `imageMediaMetadata.rotation`) type-checks.
- edge: a `FileRef` with none of the three still type-checks (all optional); an `imageMediaMetadata` with only `width` type-checks.
- error: assigning `imageMediaMetadata: { width: "10" }` (string) fails `tsc`.
**Acceptance:** `tsc --noEmit` clean; `grep -n "thumbnailLink\|imageMediaMetadata\|mimeType" packages/drive-sync/src/types.ts` shows all three inside `FileRef`.

### T2 — Extend the `list()` `fields` query param
**Deps:** T1
**Files:** `packages/drive-sync/src/files.ts`
**Do:** In `list()` (~line 392) change the `fields` string from `'files(id,name,mimeType,version,modifiedTime)'` to `'files(id,name,mimeType,version,modifiedTime,thumbnailLink,imageMediaMetadata(width,height,rotation))'`. Update the preceding comment (~lines 394-397) to note `thumbnailLink` + `imageMediaMetadata(width,height,rotation)` are also requested so callers can render/orient low-res image thumbnails without an extra round trip. Do NOT touch `buildQuery()`, `ListOptions`, the public `list()` signature, or add any `image/` check. The response is still parsed as `{ files?: FileRef[] }` and returned as-is.
**Test cases:**
- happy: existing `files.test.ts` `list()` cases still pass (`npm -w packages/drive-sync run test`).
- edge: `grep` the built/queried URL literally contains `thumbnailLink` and `imageMediaMetadata(width,height,rotation)`.
- error: `grep -n "image/" packages/drive-sync/src/files.ts` shows no new mime-prefix filter was added.
**Acceptance:** `list()` URL string literally contains `thumbnailLink` and `imageMediaMetadata(width,height,rotation)`; no `image/` filter anywhere in `files.ts`; `tsc --noEmit` clean.

### T3 — Teach `driveFake` the new fields
**Deps:** T2
**Files:** `packages/drive-sync/src/testing/driveFake.ts`
**Do:**
- In `interface DriveFakeFile` (~lines 20-39) add `thumbnailLink?: string` and `imageMediaMetadata?: { width?: number; height?: number; rotation?: number }`, each with a one-line comment matching the existing `modifiedTime?` comment style (optional so tests may seed without it; omitted from the fake's response in that case).
- In `fileToMetadata()` (~line 215) include `thumbnailLink` and `imageMediaMetadata` in the returned record ONLY when the seeded file has them set. Mirror how `modifiedTime` flows today (currently emitted unconditionally as `f.modifiedTime`, which is `undefined` when unseeded — do the same: `thumbnailLink: f.thumbnailLink` and `imageMediaMetadata: f.imageMediaMetadata`, so absent keys come back `undefined` and the returned `FileRef` has them `undefined`). Do NOT change `handleFilesList()` — no query-parsing change.
**Test cases:**
- happy: a `DriveFakeFile` seeded with `thumbnailLink` + `imageMediaMetadata` type-checks and `fileToMetadata()` returns both.
- edge: a `DriveFakeFile` seeded without them → `fileToMetadata()` result has those keys `undefined` (or absent), never `null` or `{}`.
- error: `npx tsc --noEmit -p packages/drive-sync` fails if `imageMediaMetadata.height` is seeded as a string.
**Acceptance:** `tsc --noEmit` clean; `grep -n "thumbnailLink\|imageMediaMetadata" packages/drive-sync/src/testing/driveFake.ts` shows both in `DriveFakeFile` and `fileToMetadata`; `handleFilesList` unchanged (`git diff` shows no edit to that function).

### T4 — Add `list()` thumbnail / dimensions / mimeType tests
**Deps:** T3
**Files:** `packages/drive-sync/src/__tests__/files.test.ts`
**Do:** Directly after the existing `it('list() returns modifiedTime …')` test (~line 634), add tests mirroring its harness (`makeProject()`, `await connect(project)`, `freshId('file')`, `driveFake.files.set(...)`, `queueToken()`, `await project.files.list({})`):
- happy: seed one fake file WITH `thumbnailLink: 'https://lh3.googleusercontent.com/drive-thumb/abc=s220'` and `imageMediaMetadata: { width: 1920, height: 1080, rotation: 90 }` → returned `FileRef` carries both verbatim, `rotation` included (`expect(f.thumbnailLink).toBe(<same>)`, `expect(f.imageMediaMetadata).toEqual({ width: 1920, height: 1080, rotation: 90 })`).
- edge: seed a fake file WITHOUT them → returned `FileRef` has `thumbnailLink` and `imageMediaMetadata` `undefined`.
- edge: mixed list — seed two files, one with thumbnail+metadata, one without → each returned `FileRef` reflects its own seeded state; the one without stays `undefined` on both keys (no cross-contamination).
- happy: `mimeType` now present on the returned `FileRef` at the type level and at runtime (`expect(f.mimeType).toBe('image/png')` for a seeded `mimeType: 'image/png'` file).
**Test cases (for this task's own work):**
- happy: `npx vitest run src/__tests__/files.test.ts` green including the 4 new assertions.
- edge: the mixed-list case asserts BOTH files independently in one `list()` call.
- error: temporarily reverting T2's `fields` change makes the new happy case fail (spot-check the test actually exercises the wiring), then restore.
**Acceptance:** `npx vitest run src/__tests__/files.test.ts` passes; new tests reference `thumbnailLink`, `imageMediaMetadata`, and `mimeType`; no `image/`-filter assumption in any assertion.

### T5 — Record the decision in `SPEC.md` + fix the stale header count
**Deps:** T4
**Files:** `packages/drive-sync/SPEC.md`
**Do:**
1. **Count first.** In section `## 2. …`, count the numbered decision entries between the header and `## 3. Storage layout`. Reference count at plan-authoring time: **40 entries** (labels run 1–41, but the file has a duplicate `7.` label and one merged `25–27.` entry, so item count is 40, not 41). Re-verify against the live file — do not blindly trust 40. Command hint: `awk '/^## 2\./{f=1;next} /^## 3\./{f=0} f && /^[0-9]+[.–-]/' packages/drive-sync/SPEC.md | wc -l` (tune the regex to the real bullet shape; the intent is "lines that open a numbered decision entry").
2. **Append the new entry** immediately after the current final entry (`41. …`, ~line 108), labelled with the next unused label number = **#42** (one past the highest existing label, 41). Content: `files.list()` now also requests `thumbnailLink` and `imageMediaMetadata(width,height,rotation)`; `FileRef` (`types.ts`) gains three optional fields — `mimeType?`, `thumbnailLink?`, `imageMediaMetadata?: { width?; height?; rotation? }` — all `fields`-gated / may be absent; `list()` is unfiltered (every file, any MIME type, no `image/` check, no opt-in flag) and the `thumbnailLink` is passed through verbatim (no blob fetch, no URL rewrite, no `files.thumbnail()` helper). Include the caveat in substance: `thumbnailLink` is a short-lived URL (~hours) that may require the browser to carry Google auth context for the file's account — a cross-origin bare `<img src>` can 403; the consuming app owns rendering and can fall back to `getAccessToken()` + fetch-to-blob itself. Cross-reference decision #36 (`list()` returns `modifiedTime`) since this extends the same `fields` string. Match the prose density of the surrounding entries.
3. **Fix the header.** Change `## 2. The 36 resolved design decisions` (line 53) so the number is the entry count AFTER the append — i.e. `40 + 1 = 41` (verify: `<re-counted current count> + 1`). Result: `## 2. The 41 resolved design decisions`. Note the historical off-by-one — the highest *label* is now 42 while the *count* is 41, because of the duplicate `7.` / merged `25–27.`; the header tracks the count, and the new entry keeps label #42. Change ONLY the number in the header text.
**Test cases:**
- happy: after the edit, `awk`/`grep` count of numbered decision entries in section 2 == the number written in the `## 2.` header (both 41).
- edge: the header regex still matches (`## 2. The 41 resolved design decisions`) and section 3 (`## 3. Storage layout`) is untouched.
- error: the new entry's label is `42.` (not `41.` — no collision with the existing final entry) and no existing entry's number/text changed.
**Acceptance:** new entry present after the old final one, labelled `#42`, mentioning all three new fields (incl. `rotation`), the "no `image/` filter / verbatim pass-through" stance, the 403 caveat, and a `#36` cross-ref; the `## 2.` header number equals the live count of numbered decision entries in that section (41); `git diff` shows the header line changed only in its number and no other existing decision text touched.

### T6 — Bump `drive-sync` package version
**Deps:** T5
**Files:** `packages/drive-sync/package.json`
**Do:** Change `"version": "0.6.0"` to `"version": "0.7.0"` (line 3). Nothing else in the file.
**Test cases:**
- happy: `node -e "console.log(require('./packages/drive-sync/package.json').version)"` prints `0.7.0`.
- edge: `git diff packages/drive-sync/package.json` shows exactly one changed line.
- error: `node -e "require('./packages/drive-sync/package.json')"` does not throw (valid JSON).
**Acceptance:** version is `0.7.0`; single-line diff; JSON parses.

### T7 — Courtesy note in the drive-connect plan
**Deps:** T6
**Files:** `plans/drive-connect-p1-package.md`
**Do:** Near decision 2 (~line 27, the `@open-webapp/drive-sync` peer pin `^0.6.0`), add ONE line noting: drive-sync is now `0.7.0` (adds `thumbnailLink` / image dims to `files.list()`); when this plan is executed, bump the peer range to `^0.7.0` (or `>=0.6.0`). Explicitly non-blocking — no other edit to that file, no code change to `packages/drive-connect`.
**Test cases:** n/a (docs)
**Acceptance:** exactly one added line near decision 2 referencing `0.7.0`; `git diff plans/drive-connect-p1-package.md` shows only that insertion.

### T8 — Build + typecheck + test gate
**Deps:** T7
**Files:** none (verification only)
**Do:** From the worktree root, run and make all green:
- `npm -w packages/drive-sync run build`
- `npx tsc --noEmit -p packages/drive-sync`
- `npm -w packages/drive-sync run test`
- `npm run build -ws`
- `npm run test -ws`
Fix any fallout here — do not defer.
**Test cases:**
- happy: all five commands exit 0.
- edge: run `npm -w packages/drive-sync run test` twice back-to-back — no order-dependent failures.
- error: any pre-existing unrelated failure is identified and called out, not silently absorbed into this change.
**Acceptance:** all five commands exit 0; the new `files.test.ts` cases are in the passing set; `git status` shows only the intended files changed.

### T9 — Commit
**Deps:** T8
**Files:** none (git only)
**Do:** From the worktree: `git add packages/drive-sync/src/types.ts packages/drive-sync/src/files.ts packages/drive-sync/src/testing/driveFake.ts packages/drive-sync/src/__tests__/files.test.ts packages/drive-sync/SPEC.md packages/drive-sync/package.json plans/drive-connect-p1-package.md` plus `package-lock.json` if `npm run …` touched it. Commit with a message describing: `list()` now requests `thumbnailLink` + `imageMediaMetadata(width,height)`; three new optional `FileRef` fields (`mimeType`, `thumbnailLink`, `imageMediaMetadata`); `driveFake` echo; tests; SPEC entry; version `0.7.0`. Do NOT commit `dist/`. End the message with the attribution lines from the session system-reminder.
**Test cases:** n/a
**Acceptance:** one commit on `feature/drive-sync-thumbnail-link`; `git status` clean; `git show --stat` lists no `dist/` paths and exactly the files above.

### T10 — Merge to `main`
**Deps:** T9
**Files:** none (git only)
**Do:** `cd /home/mohan/owa/owa` (main worktree), ensure `main` is current, then `git merge feature/drive-scanning-thumbnail-link` — use the actual branch name `feature/drive-sync-thumbnail-link`. No conflicts expected (all edits are additive). If `main` moved, rebase the feature branch first, re-run T8's gate, then merge.
**Test cases:**
- happy: `git log --oneline -1` on `main` is the feature commit (or a merge commit containing it).
- edge: `git show main:packages/drive-sync/package.json | grep '"version"'` shows `0.7.0`.
- error: any merge conflict is resolved and T8's gate re-run before proceeding.
**Acceptance:** `main` contains the change; `packages/drive-sync/package.json` on `main` is `0.7.0`; working tree clean.

### T11 — Tag and push `drive-sync-v0.7.0`
**Deps:** T10
**Files:** none (git only)
**Do:** From `/home/mohan/owa/owa`, confirm `packages/drive-sync/package.json` version is `0.7.0`, then per repo `CLAUDE.md`:
```
git tag drive-sync-v0.7.0
git push origin drive-sync-v0.7.0
```
Push the TAG only (main is already pushed via normal flow / separate step). This triggers `.github/workflows/publish.yml` → real npm publish of `@open-webapp/drive-sync@0.7.0`.
**Test cases:**
- happy: `git tag -l 'drive-sync-v*'` lists `drive-sync-v0.7.0`; the GitHub Actions publish job for drive-sync starts and succeeds.
- happy: `npm view @open-webapp/drive-sync version` eventually returns `0.7.0`.
- edge: `git log drive-sync-v0.7.0 -1` points at `main`'s HEAD (the merge/feature commit), not a worktree-only commit.
- error: if the publish job fails, fix forward as `0.7.1` — never move or delete the pushed tag.
**Acceptance:** tag `drive-sync-v0.7.0` pushed to origin; publish workflow run is green; `0.7.0` resolvable from the registry.

### T12 — Cleanup git worktree
**Deps:** T11
**Files:** none (git only)
**Do:** From `/home/mohan/owa/owa`: `git worktree remove ../worktree-drive-sync-thumb`. If git refuses due to leftover build artifacts, `git worktree remove --force ../worktree-drive-sync-thumb` after confirming nothing uncommitted matters.
**Test cases:** n/a
**Acceptance:** `git worktree list` shows only the main worktree; cwd is `/home/mohan/owa/owa`; branch `feature/drive-sync-thumbnail-link` still exists and its commit is reachable from `main`.

## Test strategy
All automated verification is the existing vitest suite in `packages/drive-sync`, driven by `createGisFake()` + `createDriveFake()` (no live Google credentials). The core new coverage lives in `src/__tests__/files.test.ts` alongside the current `list() returns modifiedTime …` test and reuses its exact harness: seed `driveFake.files` entries with and without `thumbnailLink` / `imageMediaMetadata` (the seeded metadata includes `rotation` alongside `width`/`height`), call `project.files.list({})`, and assert the returned `FileRef[]` carries each seeded value verbatim, leaves unseeded keys `undefined`, and never cross-contaminates entries in a mixed list. A `mimeType` assertion locks in that the field — already fetched by `list()` today — is now on the type and surfaced at runtime. Type-level guarantees (three optional fields, nested `imageMediaMetadata` shape `{ width?; height?; rotation? }`, all optional) are enforced by `npx tsc --noEmit -p packages/drive-sync`. T8 is the full gate: package build + typecheck + package tests, then `npm run build -ws` / `npm run test -ws` to confirm nothing else in the monorepo breaks, run twice to catch order dependence. Grep-based acceptance checks on T2 and T5 guard the easy-to-miss constraints: the `fields` string literally contains `imageMediaMetadata(width,height,rotation)`, no `image/` mime filter was introduced, and the `## 2.` SPEC header number equals the live count of numbered decision entries.

## Risks
- **`SPEC.md` numbering / stale header** — the "36 resolved design decisions" header is stale (real entry count is 40, highest label 41), and a duplicate `7.` label + a merged `25–27.` entry make label ≠ count. Mitigation: T5 appends the new entry as label **#42** (one past the highest label), then rewrites the header number to the true post-append *entry count* (41), with an acceptance test asserting header number == counted entries. The permanent label-vs-count off-by-one is documented in the new entry.
- **Real npm publish on tag push** — a bad `0.7.0` cannot be cleanly unpublished. Mitigation: T8's full gate (including `-ws` build/test) runs before commit/merge/tag; any breakage is fixed forward as `0.7.1`, never by moving the tag.
- **`main` moved between T8 and T10** — merge could pick up unrelated breakage. Mitigation: T10 rebases and re-runs T8's gate on conflict or drift before merging.
- **`fileToMetadata()` emitting `imageMediaMetadata: undefined` vs omitting the key** — a test that asserts key *absence* (`'imageMediaMetadata' in f === false`) would be brittle. Mitigation: T4 tests assert `=== undefined` / `toBeUndefined()`, matching how the existing `modifiedTime` test is written.
- **Drive's real `imageMediaMetadata` has many more sub-fields** (location, camera, exposure, time, etc.). Mitigation: intentionally scoped to `width`/`height`/`rotation` only, both in the `fields` request and the type; documented in SPEC #42. Widening later is non-breaking (all optional).
- **`thumbnailLink` 403 for consuming apps** — a bare cross-origin `<img src>` can fail. Mitigation: not this library's job to solve; SPEC #42 documents the caveat and the `getAccessToken()` + fetch-to-blob fallback the app owns.
- **`package-lock.json` churn from `npm run` invocations** — could bloat the commit. Mitigation: T9 only stages `package-lock.json` if it actually changed and the change is version-related.

## Open questions
- **SPEC.md label vs count**: T5 appends the new entry as label **#42** (one past the highest existing label) but sets the section header to the *entry count* (41), because the file has a duplicate `7.` and a merged `25–27.`. If the reviewer would rather renumber every entry so label == count, that is a larger, separate cleanup — not attempted here.
- **`imageMediaMetadata` sub-field set**: plan now requests `width,height,rotation`. Any further sub-field (location, camera, exposure, time) is a follow-up field + type addition — not included here.
- **drive-connect plan note placement**: plan adds the courtesy line near decision 2; if the drive-connect plan owner prefers it in that plan's "Open questions" or T1 instead, adjust in T7 (cosmetic).

## Post-change doc updates
- `packages/drive-sync/SPEC.md` — T5: new resolved-decision entry (label #42) covering the three new optional `FileRef` fields on `list()` (`mimeType`, `thumbnailLink`, `imageMediaMetadata{width,height,rotation}`), the unfiltered/verbatim-pass-through stance, and the `thumbnailLink` 403 / short-lived-URL caveat; cross-references #36. Same task fixes the stale `## 2. The 36 resolved design decisions` header to the true entry count (41 after the append) with an acceptance check that header number == counted entries. Re-read the entry after T8 to check it still matches the shipped `fields` string and `types.ts`.
- `plans/drive-connect-p1-package.md` — T7: one non-blocking line near decision 2 flagging the drive-sync `0.7.0` bump and the peer-range follow-up.
- No `README.md` change (drive-sync or otherwise).
- No `AGENTS.md` / root `CLAUDE.md` change — the existing drive-sync auto-tagging rule already covers T11.
