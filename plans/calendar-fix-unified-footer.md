# Plan: Calendar unified footer

## Status
T0–T5 complete: grouped footer, reference docs and breaking 0.4.0 metadata verified. User expressly authorized gated commit/PR delivery; T6 in progress, T7 follows successful merge and tag push.

## Goal
One footer dropdown opens calendars grouped under all account headings. Preserve independent selections and account-local actions.

## Scope
- `packages/calendar/src/react/__tests__/CalendarPane.sources.test.tsx`: user-facing regression and controller-boundary isolation checks.
- Minimal grouped selector integration in `CalendarPane.tsx` and `CalendarSelector.tsx`; reuse existing styles. Follow-up scope includes canonical reference docs and calendar-only release version metadata.

## No Scope
- Refactors, unrelated fixes, or changes to the exported standalone CalendarSelector API/behavior.

## Decisions (resolved)
1. One footer combobox; one click exposes both account headings and all calendar options.
2. Selection identity includes account and calendar ID. Clear resets only its account to primary; filtered Select all affects only its account and retains existing selections.
3. Each account retains its last selection, including non-primary selections.
4. Future release follows PR/check-gated merge, then merge-commit tag/push and cleanup; no direct main merge/push.

## Findings
- Approved RCA: CalendarPane.tsx footer maps calendarSources to individual CalendarSelector triggers. The previous test opened every combobox, hiding the defect.
- Reported baseline: `npm -w packages/drive-sync run build` then `npm run test`: 846 tests pass in 65 files; focused two selector/grouping tests pass.
- Previous environment RCA: absent dependencies repaired with local `npm ci`; missing drive-sync dist repaired with its declared build. No tracked edits from those repairs. Worktree started clean.
- README CalendarSelector contract, SPEC React contract, product-behavior selector description and standalone tests require search, filtered Select all, primary-preserving Clear and last-selected protection.
- Existing fake controller supports stateful account selections but rejects empty arrays itself; last-selection tests must also assert no controller write.

## Dependency Graph
```text
T0 setup -> T1 baseline -> T2 regression RED -> T3 minimal grouped fix -> T4 docs/release -> T5 verification -> T6 PR/checks/merge/tag -> T7 cleanup
```

## Tasks (each <=30 min)
### T0 - Setup (done; deps: none)
- Work only in `/home/mohan/owa/worktree-calendar-unified-footer`; preserve original checkout.
### T1 - Baseline (done; deps: T0)
- Baseline and environment repair recorded above; no source repair needed.
### T2 - Regression RED (verified; deps: T1)
- Require exactly one footer combobox before clicking once; assert both headings, all options and grouping order.
- Preserve account-local Clear coverage; add shared-calendar-ID routing/isolation and per-account last-selection checks at existing UI/controller seam.
- Run focused source suite against unchanged production. Accept only expected two-comboboxes-versus-one failure; unexpected failure requires halt/RCA, no commit.
- Actual command: `npm -w packages/calendar run test -- src/react/__tests__/CalendarPane.sources.test.tsx`. Result: 13 passed, 1 expected failure in `one footer combobox opens all calendars grouped by account with one click`, line 94: expected length 1, got 2. Clear, shared-ID isolation and last-per-account protections pass; later grouping assertions are gated by the expected failure.
### T3 - Minimal grouped selector fix (done; deps: T2)
- Integrate one grouped dropdown, route writes by account, preserve standalone exported selector behavior. No refactors.
- Add/verify account-local filtered Select all coverage, retaining hidden existing selections; focused and standalone suites green.
- Implementation: standalone CalendarSelector retains its props and delegates to an internal grouped renderer (no barrel changes). CalendarPane supplies source-local reads/writes to one renderer. One popup/open/search state; account-local Clear and filtered Select all; composite encoded source/calendar option identity and flattened keyboard traversal.
- Added two targeted tests: filtered account-local Select all preserves hidden primary and other-account selection; keyboard wraps across account groups with shared calendar IDs, routes Enter to the correct source, and Escape restores trigger focus. Existing regression, Clear, shared-ID routing and last-selection tests pass.
- Focused command: `npm -w packages/calendar run test -- src/react/__tests__/CalendarPane.sources.test.tsx src/react/__tests__/CalendarSelector.test.tsx src/react/__tests__/calendarSelectorLongNames.test.tsx` — exit 0, 3 files / 31 tests passed (16 source, 11 standalone, 4 long-name).
- Full command: `npm run test` — exit 0, 65 files / 850 tests passed: calendar 292, drive-connect 35, drive-sync 292, project-sync 231. Previous baseline 846; prior task added 2 tests and this task added 2. Output includes npm `-ws` warning, React act warnings, and stderr from passing error-path tests; no failed tests.
- `npm -w packages/calendar run build` — exit 0; `bash scripts/check-contracts.sh` — exit 0, `contracts OK`; `git diff --check` — exit 0.
- Structural grep and CSS review: one combobox/searchbox/listbox declaration, one grouped renderer in the footer (accounts mapped to data rather than triggers), named account groups/headings, composite option keys/ARIA IDs, shared upward class, descendant option styles and existing listbox scrolling preserved. No CSS edits needed.
- No unexpected verification failure occurred. No original-main comparison needed. No commit, release metadata, PR, tag or cleanup performed under this task's explicit scope.
- Open verification risk: DOM/CSS checks only; no live-browser visual or assistive-technology validation. Existing full-suite stderr was not independently compared with main.
### T4 - Docs and release metadata (done; deps: T3)
- Update calendar README, SPEC, product-behavior/design references as needed; inspect peer ranges against latest published versions and bump appropriate release metadata.
- Updated README, SPEC UI/versioning contract, product-behavior and design for one shared grouped footer, account-local Clear/filtered Select all retaining existing selections, last-selected protection and standalone compatibility.
- Registry `npm view @open-webapp/calendar version` reports 0.3.0; versions list ends at 0.3.0. Local tags and remote `git ls-remote --tags origin 'calendar-v*'` end at calendar-v0.3.0. Selected available 0.4.0 BREAKING pre-1.0 minor for the explicitly requested observable UI change. Future commit message must mark BREAKING.
- Changed only calendar package version and matching `packages/calendar` lock entry, 0.3.0 -> 0.4.0; no dependency changes. Calendar peers are external React and optional Vitest, with no workspace peers. All workspace manifests checked: no calendar consumers/peer ranges require updates.
### T5 - Verification and reference grep (done; deps: T4)
- Full `npm run test`, affected build/typecheck and `scripts/check-contracts.sh`.
- Search reference docs for CalendarPane, CalendarSelector, footer, account grouping, Clear and Select all; reconcile stale claims and review final diff.
- Case-insensitive broad reference sweep via `functions.grep` across Markdown and JSON/YAML references; inspected full SPEC, including public surface, controller selection invariants, UI, styling and versioning. Four canonical calendar docs needed updates; remaining hits are valid API/style/history references or plan evidence. No additional stale per-account-trigger claim found.
- Environment RCAs resolved: prior missing dependencies repaired by local npm ci, missing drive-sync dist by its declared build; neither needed tracked edits. Missing rg is a diagnosed tooling availability issue, not a test failure: dedicated `functions.grep` successfully used, no install required.
- Final `npm run test`: exit 0, 65 files / 850 tests passed (calendar 292, drive-connect 35, drive-sync 292, project-sync 231). npm -ws deprecation, React act warnings and passing error-path stderr remain; no actual unexpected test failure.
- Final `npm -w packages/calendar run build`: exit 0, including tsc typecheck and CSS copy. `bash scripts/check-contracts.sh`: exit 0, contracts OK. `git diff --check`: exit 0. No lint/typecheck scripts or lint configuration are available; calendar build provides the applicable TypeScript gate. CI configuration also inspected.
- No source/test edits in this docs/release follow-up. No unexpected test/build/check failure; mandatory halt/RCA not triggered. No commit, PR, merge, tag or push performed.
### T6 - PR/check-gated merge and tag (pending; deps: T5)
- Delivery review: inspected full tracked diff, plan, status and last ten commits. Intended changes contain no secrets; standalone selector props/selection behavior preserved and no public barrel changes. Original main has unrelated untracked files to preserve. Fetched origin/main includes PR #10; its calendar lockfile peer metadata is independent of this version-only lock change. Remote PR checks must validate the combined merge result.
- Commit intended changes, push feature branch, open PR against main. Poll checks until complete; any failing/missing required checks stop merge/tag and report logs.
- Only after all required checks pass: merge PR, update local main, tag merge commit `calendar-v<version>` and push tag.
### T7 - Cleanup (pending; deps: T6)
- Remove worktree/branch only after successful merge and tag push; preserve unrelated work.

## Test Strategy
- CalendarPane UI and controller boundary: unified trigger/group visibility, Clear, shared-ID isolation, last-per-account protection and filtered Select all verified in T3 and final full suite.
- Standalone CalendarSelector suite preserves public API behavior. Full workspace tests/build/contracts gate release.

## Acceptance
- One footer trigger opens every account group; account-local actions cannot mutate another account or deselect its last calendar.
- Regression fails for the approved root cause before production changes; all verification green before release.

## Risks
- Duplicate calendar IDs across accounts can leak selection state: assert both controller writes and rendered selected state.
- Fake controller could mask empty-selection writes: assert no write at last-selection boundary.

## Post-change docs
- Calendar README React API, SPEC React contract, product-behavior selector and design component/data-flow references; canonical docs take precedence over this plan.
