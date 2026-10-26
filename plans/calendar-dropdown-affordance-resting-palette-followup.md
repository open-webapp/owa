# T3 followup: establish the resting-palette pointer precondition

Date: 2026-10-26. Worktree: `/home/mohan/owa/worktree-calendar-fix-dropdown-affordance`.
Parent plan: `/home/mohan/owa/owa/plans/calendar-fix-dropdown-affordance.md`, T3.

## RCA and approved scope

Reported full browser gate: 30 passed / 11 failed at the shared resting trigger surface assertion. Actual light `rgb(240, 248, 251)` and dark `rgb(42, 42, 42)` are the approved hover colors; expected resting values remain `rgb(255, 255, 255)` and `rgb(26, 26, 26)`. Real clicks leave the pointer hovered even when search gains focus. This is a test-state mismatch exposed by the new hover behavior.

## Completed followup

1. Read worktree instructions, browser harness, handoff and parent plan; preserve existing T3 edits.
2. Make the shared palette helper async and use the real pointer API `userEvent.hover()` to move to its scoped searchbox before asserting resting appearance; await every caller. Retain every exact palette contract and separate real hover assertions.
3. Run the full browser suite once, then full workspace tests only after browser green. Any unexpected failure requires halt/RCA without retries or other fixes.
4. Record evidence and results in `plans/calendar-dropdown-affordance-t1-handoff.md`. No commits.

## Gate result

- `npm run test:theme-browser --workspace @open-webapp/calendar -- --no-cache`: 1 file / 41 tests passed.
- `npm run test`: 67 files / 860 tests passed (calendar: 19 files / 302 tests).
- Both exited 0 on their first run; no failures or retries. T3 resting-palette followup complete.
