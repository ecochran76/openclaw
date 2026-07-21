State: CLOSED
Created: 2026-07-16

# Turn-Tracker Global Singleton State

## Problem State

Before this plan, `src/auto-reply/turn-tracker.ts` owned four module-local maps. Split runtime
chunks can load distinct module copies, fragmenting active/recent turn state and
run-to-turn identity.

Execution owner: dedicated subagent for Plan 0021.

## Scope

- Store all coupled turn-tracker registries in one process-global singleton.
- Use the repository's `resolveGlobalSingleton` and `Symbol.for` convention.
- Prove state identity across isolated module copies.

## Non-Goals

- Changing turn retention, ordering, lifecycle, or public status behavior.
- Moving turn state to persistent storage.

## Work Phases

1. Inspect sibling singleton implementations and the four-map invariants.
2. Replace module-local ownership with one typed singleton state object.
3. Add split-module regression coverage plus existing lifecycle tests.
4. Run focused turn-tracker tests and `git diff --check`.

## Acceptance Criteria

- All four registries share one process-global owner across module copies.
- Existing cleanup and retention invariants remain intact.
- Focused split-module and lifecycle tests pass.

## Definition Of Done

The plan is `CLOSED`, its subagent records exact proof, and no persistence or
behavioral expansion is introduced.

## Closeout | 2026-07-16

- Replaced the four module-local registries with one typed `TurnTrackerState`
  resolved through `resolveGlobalSingleton` and a `Symbol.for` process key.
- Kept lifecycle, retention, projection, and reset behavior unchanged; only the
  process-local ownership boundary moved.
- Added a split-module regression that starts and attaches a run through the
  first module instance, updates and finishes through a reloaded instance, and
  verifies active, reverse-index, recent-history, and reset behavior from both.

Proof:

- `node scripts/run-vitest.mjs src/auto-reply/turn-tracker.test.ts`
  - PASS: 1 file, 13 tests.
- `node_modules/.bin/oxfmt --check src/auto-reply/turn-tracker.ts src/auto-reply/turn-tracker.test.ts`
  - PASS: both files use the correct format.
- `git diff --check -- src/auto-reply/turn-tracker.ts src/auto-reply/turn-tracker.test.ts docs/dev/plans/0021-2026-07-16-turn-tracker-global-singleton.md`
  - PASS: no whitespace errors.
