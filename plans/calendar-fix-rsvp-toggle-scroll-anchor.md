# Plan: Calendar RSVP toggle scroll anchor

## Status
Plan only. Ref docs: `packages/calendar/product-behavior.md` (line 14 scroll/recenter bullet), `design.md`, `SPEC.md`. No prereq gaps. calendar at 0.9.0 -> bump 0.9.1. No `typecheck`/`lint` script in calendar; use `npm run build` (tsc) as typecheck.

## Goal
Toggle RSVP chip -> date visible in `.calendar-pane-scroll` stays put. No jump when days above viewport appear/vanish.

## Scope
- `packages/calendar/src/react/CalendarPane.tsx` (`handleToggle` ~233, `dayHeaderRefs` ~194/481, `scrollRef` ~199): add anchor ref + capture + `useLayoutEffect` restore.
- `packages/calendar/src/react/__tests__/CalendarPane.test.tsx`: regression tests.
- `packages/calendar/package.json`: patch bump 0.9.1.
- `packages/calendar/product-behavior.md` / `design.md`: one line each.

## No Scope
- Recenter (first events + 30s idle) unchanged.
- Public API/props/return/popups unchanged. No refactor.
- No other-package changes.

## Decisions (resolved)
1. Anchor = first day header whose bottom > scroll top (first visible). Store `{dateKey, offset}` where offset = header.top - scrollEl.top (getBoundingClientRect).
2. Capture in ref `anchorRef`, updated on scroll listener (passive) on scrollEl, and re-captured at top of `handleToggle` (fresh). Controlled prop: external changes use scroll-updated ref (last scroll state valid, since layout unchanged until commit).
3. Restore in `useLayoutEffect` deps `[selectedRsvpStatuses]`: skip on first mount. Find header by dateKey; if missing pick nearest following dateKey (ISO string compare, `>`) that has header; else nearest previous. Set `scrollTop += (header.top - scrollEl.top) - offset`.
4. No anchor (no scroll yet / no headers / no events) -> no-op. No scrollTo behavior smooth; direct scrollTop write.
5. Date keys are ISO strings; compare lexically. No `toISOString().slice`; no new date derivation.
6. After restore, refresh anchorRef so next toggle starts correct.

## Findings
- `filteredEvents` = `filterByRsvp(events, selectedRsvpStatuses)`; `dayGroups = groupByDay(filteredEvents, todayIso)` -> headers keyed by `group.dateKey` in `dayHeaderRefs` (set/delete via ref callback ~483).
- Recenter uses `hasScrolledForEventsRef` + idle timer; separate effect, untouched.
- Existing effect ~344 already attaches scroll listener on scrollEl (ribbon); add own separate effect, do not touch.
- Tests use fake timers, `helpers.ts` `makeEvent`/`baseProps`; jsdom has no layout -> stub `getBoundingClientRect` + `scrollTop`.

## Dependency Graph
```text
T0 -> T1(baseline) -> T2 -> T3 -> T4 -> T5
```

## Tasks (each <=30 min)

### T0 - Make worktree (<=15m, deps: none)
- model: haiku
- `git worktree add ../worktree-calendar-fix-rsvp-toggle-scroll-anchor -b fix/calendar-rsvp-toggle-scroll-anchor`; cd there; work only there. Branch off `main`. `npm ci` if needed.
- Accept: worktree listed.

### T1 - Baseline gate (<=30m, deps: T0)
- model: haiku
- Run full `npm run test` in worktree before any feature task.
- If green: skip rest.
- If red: fix root causes; commit separately (`fix: repair failing baseline tests`); IMMEDIATELY merge that commit into `main` and push; sync worktree with `main`. Only T1 merges early.
- Accept: baseline green in worktree; every feature task depends on T1.

### T2 - Failing regression tests (<=30m, deps: T1)
- model: sonnet
- Edit `packages/calendar/src/react/__tests__/CalendarPane.test.tsx`. New `describe('RSVP toggle scroll anchor')`. Stub: per-header `getBoundingClientRect` computed from fake layout (top = base + index*H - scrollTop), scroll el `getBoundingClientRect` top=0, writable `scrollTop`. Use stateful wrapper (like existing `useState` tests) so toggle really filters.
- Happy: events on days A,B,C,D; scrollTop set so C top offset=40; fire `scroll`; toggle chip hiding A,B events -> after, C header offset still 40 (scrollTop adjusted).
- Edge: anchor day C itself hidden by toggle -> anchor becomes nearest following day D, offset preserved.
- Edge: C and all later hidden -> nearest previous (B) offset preserved.
- Edge: toggle that re-adds earlier days -> offset preserved.
- Edge: no scroll event / no events yet -> scrollTop untouched (no-op).
- Edge: external prop change (rerender with new `selectedRsvpStatuses`, no click) -> anchored too.
- Accept: tests red for right reason (scrollTop unchanged/offset drifts); others (no-op) may pass.

### T3 - Minimal fix (<=30m, deps: T2)
- model: sonnet
- Edit `CalendarPane.tsx`: add `anchorRef`, scroll-listener effect updating it (first header with bottom > scroll top), `useLayoutEffect([selectedRsvpStatuses])` restore per Decisions 3-6; first-mount skip via ref. Import `useLayoutEffect`. Leave recenter and existing effects as-is. Add one short comment.
- Test: T2 suite green; full calendar suite green (esp. recenter/idle tests).
- Accept: no public API change; no new exports.

### T4 - Reference docs + grep sweep (<=30m, deps: T3)
- model: haiku
- `product-behavior.md` line 14 area: add "RSVP chip toggles keep the visible date anchored (no scroll jump)".
- `design.md`: add note on anchor ref + layout-effect restore, fallback following->previous.
- `SPEC.md`: check for scroll claims; update only if stale.
- Read each touched doc in full. Mandatory grep over product-behavior.md, design.md, SPEC.md (and README.md) for `scroll`, `recenter`, `anchor`, `anchorRef`, `useLayoutEffect`; fix stale claims.
- Accept: docs consistent; sweep recorded before commit.

### T5 - Verify, bump, PR, merge, tag, teardown (<=30m, deps: T4)
- model: sonnet
- Bump `packages/calendar/package.json` to 0.9.1 (patch, non-breaking).
- Commit gate: in worktree run full `npm run test`, `npm run build -w packages/calendar` (tsc typecheck), `scripts/check-contracts.sh`. If any fail and unfixable: do NOT commit/push; STOP and report what failed/tried.
- Pass: commit source, tests, docs, bump. Message ends `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push branch; open PR vs `main` (body ends `🤖 Generated with [Claude Code](https://claude.com/claude-code)`). Do NOT push/merge main locally.
- Poll `gh pr checks <pr>` every 30-60s until none pending. All pass -> `gh pr merge <pr> --merge`; update local main; `git tag calendar-v0.9.1`; `git push origin calendar-v0.9.1`. Any fail/none report -> no merge, no tag; report failed check + `gh run view --log-failed`; stop.
- Teardown: from main worktree `git worktree remove ../worktree-calendar-fix-rsvp-toggle-scroll-anchor`; delete branch only after merge.
- Accept: PR merged, tag pushed, worktree gone (or stopped with report on failure).

## Test Strategy
- UI seam only: `CalendarPane.test.tsx` jsdom with stubbed geometry. Gate: full `npm run test` in worktree, PR CI, `scripts/check-contracts.sh`.

## Acceptance
- Toggle hiding/showing earlier days: anchor header offset from scroll top unchanged.
- Anchor day hidden -> nearest following kept, else previous.
- No scroll/events -> no scrollTop write.
- External prop change anchors too.
- Recenter + idle tests unchanged and green. No public API diff.

## Risks
- jsdom no layout -> fake geometry may mask real browser; mitigate with layout-effect (pre-paint) and optional manual check.
- Sticky day headers/chip row may offset "first visible" calc -> use header bottom > scroll top; consider chip-row height if wrong.
- Scroll-updated ref stale if content resized between scroll and external change -> accept; toggle path recaptures fresh.
- Fake timers in suite: layout effect sync, no timer reliance.

## Post-change docs
- `product-behavior.md` (scroll bullet ~14), `design.md` (scroll/anchor note); `SPEC.md`/`README.md` only if stale. Reference docs canonical over this plan.
