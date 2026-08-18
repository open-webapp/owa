# Fix Phase 2 Blockers & Publish project-sync@0.1.0

**Caveman version:** Fix 15 TypeScript errors + 5 React act() warnings blocking v0.1.0 release. 
Publish as git tag → GitHub workflow auto-publishes to npm.

---

## Task Breakdown

### T0: Create Git Worktree
**Deps:** None  
**Time:** 5 min  

Create isolated branch for all fixes, keep main clean.

- Create: `project-sync-0.1.0-fixes` branch from main  
- Command: `git worktree add ../owa-fixes project-sync-0.1.0-fixes`
- Verify: `git branch -a` shows new branch, `pwd` points to worktree

---

### T1: Export Logger Type from drive-sync
**Deps:** T0  
**Time:** 5 min  

**Issue:** `documents.ts:20` and `folders.ts:21` import `Logger` from `@open-webapp/drive-sync`, but it's not exported (only imported as type).

**Affected files:**
- `/packages/drive-sync/src/index.ts` — add `Logger` to export
- `/packages/project-sync/src/documents.ts:20` — already imports Logger (unblock)
- `/packages/project-sync/src/folders.ts:21` — already imports Logger (unblock)

**Fix:**  
In `drive-sync/src/index.ts` line 15, add `Logger` to type exports:
```ts
export type { ..., Logger } from './types.js';
```

**Test:**
- `npm run build` in drive-sync succeeds
- `npm run build` in project-sync proceeds past Logger errors

**Accept:** No TS errors on `Logger` imports in project-sync

---

### T2: Fix .js Extension in React Test Imports
**Deps:** T0  
**Time:** 5 min  

**Issue:** `src/react/__tests__/hooks.test.tsx:20` imports `../index` without `.js` extension.  
TypeScript with `moduleResolution: node16` requires explicit extensions.

**Affected files:**
- `src/react/__tests__/hooks.test.tsx:20`

**Fix:**  
Change:
```ts
import { ... } from '../index';
```
To:
```ts
import { ... } from '../index.js';
```

**Test:**
- `npm run build` passes import resolution

**Accept:** TS2835 error resolved

---

### T3: Fix Null Safety in dataStore.ts & documents.ts
**Deps:** T0  
**Time:** 10 min  

**Issue:** Three distinct null-safety violations:
1. `dataStore.ts:97` — `number | null` passed where `number` required
2. `documents.ts:320` — `string | null` passed where `string` required  
3. `documents.ts:325, 330` — Type mismatches with `string | Blob` handling

**Affected files:**
- `src/dataStore.ts:97`
- `src/documents.ts:320, 325, 330`

**Fix 3a (dataStore.ts:97):**  
OpenDB's `upgrade` callback receives `oldVersion` and `newVersion` which are guaranteed `number` at that point (before the upgrade handler is called). Add non-null assertion or verify types are correctly passed from idb library.

Current:
```ts
await config.upgrade(db, oldVersion, newVersion, tx);
```
Verify: `idb` types guarantee oldVersion/newVersion are `number` here. If not, add non-null: `oldVersion ?? 0`.

**Fix 3b (documents.ts:320):**  
Line 320 passes `fileId` (string | null) to a function expecting string. Guard with null check:
```ts
if (!fileId) throw new Error('fileId is required');
// now use fileId as string
```

**Fix 3c (documents.ts:325, 330):**  
Handle both string and Blob cases explicitly:
```ts
// Type narrowing for .length access
if (typeof content === 'string') {
  // Use content.length safely
} else if (content instanceof Blob) {
  // Use content.size, not .length
}
```

**Test:**
- `npm run build` in project-sync passes null-safety checks
- `npm test` in project-sync passes

**Accept:** TS2345 (null safety) errors resolved

---

### T4: Fix Blob/Uint8Array Type Mismatch in documents.ts
**Deps:** T0, T1, T3  
**Time:** 90 min (core issue, 2–3 hrs in estimate)

**Issue:** `documents.ts:220, 250` have fundamental type mismatch.  
- `filesImpl.read()` returns `string | Blob | null` (from drive-sync)
- `documents.ts` Payload type is `string | Uint8Array`
- Assignments fail because `Blob` and `Uint8Array` are incompatible

Type error example:
```
Type 'Payload' is not assignable to type 'string | Blob'.
Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'Blob'.
```

**Affected files:**
- `src/documents.ts:220, 250` (write payload assignments)
- `src/documents.ts:325, 330` (read payload handling)

**Root cause:** Drive-sync returns `Blob` for binary data; project-sync expects `Uint8Array`.

**Fix:**  
Create conversion functions in a new utility file (`src/payloadConvert.ts`):

```ts
// Convert Blob to Uint8Array
export async function blobToUint8Array(blob: Blob): Promise<Uint8Array> {
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}

// Convert Uint8Array to Blob
export function uint8ArrayToBlob(data: Uint8Array, mimeType: string): Blob {
  return new Blob([data], { type: mimeType });
}

// Normalize drive-sync output to Payload
export async function normalizeFromDrive(
  content: string | Blob | null,
  mimeType: string
): Promise<Payload | null> {
  if (content === null) return null;
  if (typeof content === 'string') return content;
  // Blob case
  return await blobToUint8Array(content);
}

// Convert Payload to drive-sync input
export function normalizeToDrive(payload: Payload, mimeType: string): string | Blob {
  if (typeof payload === 'string') return payload;
  // Uint8Array case
  return uint8ArrayToBlob(payload, mimeType);
}
```

**Integration points:**
- Line 220: convert remote Blob → Uint8Array before merge
- Line 250: convert merged Uint8Array → Blob before write
- Line 325, 330: use normalization functions

**Test cases:**
- **Happy path:** String round-trips unchanged
- **Happy path:** Uint8Array round-trips byte-identical after Blob ↔ Uint8Array
- **Edge case:** Empty Uint8Array (0 bytes)
- **Edge case:** Large Uint8Array (100KB+)
- **Error case:** Blob.arrayBuffer() rejection

Acceptance criteria:
- No type errors on Blob/Uint8Array assignments
- Document sync succeeds for both string and binary payloads
- Round-trip tests pass in documents.test.ts

**Accept:** TS2322 (Blob/Uint8Array type) errors resolved

---

### T5: Fix Merger Signature (Payload | null → Payload)
**Deps:** T0, T4  
**Time:** 60 min

**Issue:** Multiple test fixtures (contracts.test.ts:186, 207, 360, 384) define mergers that return `{ merged: Payload | null }` but `describeMergeContract` expects `{ merged: Payload }` (non-nullable).

**Affected files:**
- `src/testing/__tests__/contracts.test.ts:186, 207, 360, 384` (test fixtures)
- `src/testing/contracts.ts:94` (type definition of mergeFn)

**Root cause:** App mergers can theoretically return null (e.g., "delete both"), but the contract assumes non-null merged result.

**Design decision:** Merger must always return a non-null merged value. Empty state should be represented as empty string (`""`) or empty array (JSON-stringified `[]`), never null.

**Fix:**

1. Update type definition in `contracts.ts:94`:
   - Already correct: `{ merged: Payload; conflicts: unknown[] }` (non-nullable)
   - No change needed; test fixtures are wrong

2. Fix test fixtures in `contracts.test.ts`:
   - Line 186: Change merge to ensure `merged: Payload` (not null)
   - Line 207: Ditto
   - Line 360: Ditto  
   - Line 384: Ditto

   Example fix:
   ```ts
   // Before
   return { merged: basePayload ?? null, conflicts: [] };
   
   // After
   return { merged: basePayload ?? "", conflicts: [] };
   ```

3. Update createBrokenMergeThatDropsRemote() to also return non-null:
   ```ts
   // Intentionally loses remote, but returns non-null merged
   return { merged: local ?? "", conflicts: [] };
   ```

**Test cases:**
- **Happy path:** merge(base, disjoint) returns non-null merged
- **Happy path:** merge(null, remote) returns remote (not null)
- **Happy path:** merge(local, null) returns local (not null)
- **Edge case:** merge(null, null) returns "" (empty fallback)
- **Error case:** Contract suite rejects null merged

Acceptance criteria:
- describeMergeContract type signature is satisfied
- All merge test fixtures pass contract checks
- No TS2345 errors on merge assignment

**Accept:** TS2345 (merger signature) errors on contracts.test.ts resolved

---

### T6: Fix Type Annotation in React Test (Implicit Any)
**Deps:** T0, T2  
**Time:** 5 min  

**Issue:** `src/react/__tests__/hooks.test.tsx:132` has implicit `any` on map callback parameter.

```ts
{projects.map((p) => (  // <-- p is implicitly any
```

**Affected files:**
- `src/react/__tests__/hooks.test.tsx:132`

**Fix:**  
Add explicit type:
```ts
{projects.map((p: Project) => (
```

**Test:**
- `npm run build` passes

**Accept:** TS7006 (implicit any) error resolved

---

### T7: Fix describeDocumentContract Mock Signature
**Deps:** T0, T5  
**Time:** 10 min  

**Issue:** `contracts.test.ts:293` defines a mock `writeLocal: async () => {}` that takes no args, but the contract expects `writeLocal(merged: Payload)`.  
This violates the type at line 230 of contracts.ts which expects `writeLocal(merged: Payload): Promise<void>`.

**Affected files:**
- `src/testing/__tests__/contracts.test.ts:293` (mock function in negative test case)

**Fix:**  
Change mock to accept payload argument (even if unused):
```ts
// Before
writeLocal: async () => {
  // intentionally doesn't write
}

// After
writeLocal: async (payload: Payload) => {
  // intentionally doesn't write; payload dropped
}
```

**Test:**
- `npm run build` in project-sync
- `npm test` in project-sync contracts suite passes

**Accept:** TS2554 (expected 0 arguments) error resolved

---

### T8: Wrap React Hook Subscriptions in act()
**Deps:** T0, T6, T7  
**Time:** 120 min (test refactoring, 2–3 hrs estimate; warning flakiness risk)

**Issue:** Five React test warnings (stderr):
- `useSyncStatus renders once when status changes`
- `useSyncStatus error is displayed`
- `useSyncStatus needsReauth is tracked`
- `useProjects reflects new projects`
- `useProjects updates when project is renamed`
- `useProjects updates when project is removed`

Root cause: When test code changes subscription state (calls `markDirty()`, simulates async updates), React state changes happen outside an `act()` wrapper, causing warnings.

**Affected files:**
- `src/react/__tests__/hooks.test.tsx` — subscription trigger code + assertions

**Fix strategy:**

1. Identify each test that triggers subscription updates:
   - Status change: `ps.sync.markDirty()`, sync event
   - Project change: `ps.projects.create()`, listener callback

2. Wrap triggers + assertions in `act()`:
   ```ts
   import { act } from 'react';
   
   // Before
   ps.sync.markDirty(projectId);
   await waitFor(() => expect(status.phase).toBe('syncing'));
   
   // After
   await act(async () => {
     ps.sync.markDirty(projectId);
     // Trigger listeners manually if needed
   });
   await waitFor(() => expect(status.phase).toBe('syncing'));
   ```

3. For subscription callbacks:
   - Some tests manually call subscription callbacks (e.g., via mocks)
   - Wrap callback invocation in `act()` if it changes React state

**Test cases:**
- **Happy path:** Status change wrapped in act() → no warnings
- **Happy path:** Project CRUD wrapped in act() → no warnings
- **Edge case:** act() nesting (already-wrapped callbacks) — React handles
- **Error case:** Forgotten act() wrapper → catches in next test run

Integration checklist:
- [ ] Document with comments why act() is needed for each test
- [ ] Run `npm test` 3x to catch flakiness from race conditions

Acceptance criteria:
- Zero act() warnings in test stderr
- All hooks tests pass
- No new test flakiness introduced

**Accept:** React act() warnings cleared

---

### T9: Full Build + Test Verification
**Deps:** T1–T8  
**Time:** 10 min  

Run full suite to catch regressions before publishing.

**Commands:**
```bash
# In project-sync/
npm run build       # Must succeed, zero errors
npm test            # Must pass all tests
npm run lint        # If applicable, no style issues
```

**Verification checklist:**
- ✓ No TypeScript errors (all 15 resolved)
- ✓ No test failures
- ✓ All React warnings gone
- ✓ Package.json version is 0.1.0

**Accept:** Build green, tests passing

---

### T10: Commit, Tag, Push, Verify Workflow, Cleanup
**Deps:** T9  
**Time:** 15 min  

Publish to npm via git tag + GitHub workflow automation.

**Steps:**

1. **Commit all fixes:**
   ```bash
   git add -A
   git commit -m "fix: resolve Phase 2 TypeScript & React test blockers

   - Export Logger type from drive-sync
   - Add .js extension to React test import
   - Fix null safety in dataStore & documents
   - Convert Blob ↔ Uint8Array for payload handling
   - Fix merger signature in test fixtures
   - Add type annotation in hooks test
   - Fix describeDocumentContract mock signature
   - Wrap React subscriptions in act()

   Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"
   ```

2. **Extract version from package.json:**
   ```bash
   VERSION=$(jq -r '.version' packages/project-sync/package.json)
   echo "Version: $VERSION"  # Expect: 0.1.0
   ```

3. **Create + push tag:**
   ```bash
   git tag "project-sync-v${VERSION}"
   git push origin project-sync-v${VERSION}
   ```

4. **Verify GitHub workflow triggered:**
   - Navigate to: `https://github.com/open-webapp/owa/actions`
   - Filter for: `project-sync-v0.1.0` tag
   - Wait for workflow to complete (publish job)
   - Verify npm package appears: `npm info @open-webapp/project-sync@0.1.0`

5. **Cleanup worktree:**
   ```bash
   cd /Users/mdoraiswamy/owa/owa
   git worktree remove ../owa-fixes
   git branch -d project-sync-0.1.0-fixes
   ```

6. **Verify release:**
   ```bash
   npm view @open-webapp/project-sync
   # Should show 0.1.0 in versions list
   ```

**Test:**
- Workflow runs without error
- Package published to npm within 2 min

**Accept:** v0.1.0 live on npm, worktree cleaned up

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Blob ↔ Uint8Array conversion edge cases** | Data corruption on large binary payloads | Comprehensive test: empty, small, 100KB+; verify round-trip byte-identity |
| **React act() wrapper race conditions** | Intermittent test flakiness post-fix | Run full test suite 3× locally; CI will catch remaining flakes |
| **Import path resolution (node16)** | Silent import failures if .js missed | TypeScript build blocks it; double-check all relative imports in react/ |
| **Workflow automation** | Tag pushed but publish fails silently | Monitor Actions tab; have manual npm publish fallback ready |
| **Null merger assumption** | Silent data loss if app returns null merge | Contract test suite enforces non-null; document in SPEC.md that mergers must not return null |

---

## Affected Files Summary

**drive-sync:**
- `packages/drive-sync/src/index.ts` (export Logger type)

**project-sync:**
- `packages/project-sync/src/dataStore.ts` (null safety)
- `packages/project-sync/src/documents.ts` (Blob/Uint8Array, null safety, imports)
- `packages/project-sync/src/folders.ts` (Logger import — unblocked by T1)
- `packages/project-sync/src/payloadConvert.ts` (NEW — Blob conversion utils)
- `packages/project-sync/src/react/__tests__/hooks.test.tsx` (imports, type annotation, act() wrappers)
- `packages/project-sync/src/testing/__tests__/contracts.test.ts` (merger signatures, mock fixes)
- `packages/project-sync/src/testing/contracts.ts` (type definitions — no changes; already correct)

**No documentation changes needed** — SPEC.md correctly describes Payload as opaque; Blob conversion is internal.

---

## Test Strategy

| Test Level | Command | Pass Criteria |
|------------|---------|---------------|
| **Type check** | `npm run build` in each pkg | Zero TS errors |
| **Unit tests** | `npm test` in project-sync | All test suites pass; zero act() warnings |
| **Integration** | Smoke test: import & use API | No runtime errors |
| **Publish** | `npm view @open-webapp/project-sync@0.1.0` | Package metadata appears on npm registry |

---

## Acceptance Criteria (Global)

- [x] All 15 TypeScript compile errors resolved
- [x] All 5 React act() warnings eliminated  
- [x] No new warnings or errors introduced
- [x] Full test suite passes
- [x] @open-webapp/project-sync@0.1.0 published to npm
- [x] Git tag project-sync-v0.1.0 exists and pushed
- [x] Worktree cleaned up; main branch unchanged

---

## Timeline

| Task | Est. Time | Cumulative |
|------|-----------|-----------|
| T0 | 5 min | 5 min |
| T1 | 5 min | 10 min |
| T2 | 5 min | 15 min |
| T3 | 10 min | 25 min |
| T4 | 90 min | 115 min |
| T5 | 60 min | 175 min |
| T6 | 5 min | 180 min |
| T7 | 10 min | 190 min |
| T8 | 120 min | 310 min |
| T9 | 10 min | 320 min |
| T10 | 15 min | 335 min |

**Total:** ~5.5 hours (aligns with "4–6 hours design fixes" + 30 min integration)

