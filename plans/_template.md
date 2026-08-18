# Plan: {feature name}

## Goal
What we building. Why. One paragraph, caveman-speak.

## Scope
**In scope:**
- ...

**Out of scope:**
- ...

## Resolved decisions
Numbered list of locked-in decisions this plan builds on. No re-litigating these.

1. ...

## Affected files
Exact paths, one line each, what changes in each.

- `path/to/file.ts` — what changes

## Tasks

Each task: id, deps, files touched, what to do, test cases (happy + edge + error), acceptance criteria. Task must take ≤30 min.

### T0 — Create git worktree
**Deps:** none
**Files:** none (git only)
**Do:** `git worktree add ../worktree-{feature} -b {feature}/{branch-name}`, cd into it. All following tasks happen inside this worktree.
**Test cases:** n/a
**Acceptance:** worktree exists, branch checked out, cwd is the worktree.

### T1 — {task name}
**Deps:** T0
**Files:** `path/to/file.ts`
**Do:** caveman-speak steps.
**Test cases:**
- happy: ...
- edge: ...
- error: ...
**Acceptance:** ...

...

### T{last} — Commit
**Deps:** all prior tasks
**Files:** none (git only)
**Do:** stage changed files, commit with descriptive message.
**Test cases:** n/a
**Acceptance:** commit exists, `git status` clean.

### T{last+1} — Cleanup git worktree
**Deps:** T{last}
**Files:** none (git only)
**Do:** cd back to original directory, `git worktree remove ../worktree-{feature}`.
**Test cases:** n/a
**Acceptance:** worktree removed, original directory active, branch still exists with the commit.

## Test strategy
How the whole feature gets verified end to end (unit + any integration).

## Risks
Bullet list, each with a mitigation.

## Open questions
Bullet list of anything not resolved by this plan.

## Post-change doc updates
What docs (README, SPEC, AGENTS.md, etc.) need updating and how, per repo convention.
