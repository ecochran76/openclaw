# Slack Turn Visibility — Pre-Live-Testing Polish Plan

## Goal

Do the smallest remaining polish work needed before real Slack-thread live testing, without reopening Slice 3 scope unnecessarily.

## Current shipped baseline

Landed on `ec-main`:

- `498f59a1c` — Slice 1 visibility foundation
- `05571e149`, `987865f7c`, `5f9754034`, `f8523c896`, `1f104770f` — Slice 2 attribution and silence inspection
- `3d925d0cc`, `8de818625`, `cdf6f5aee`, `d81df866f` — Slice 3A/3B inspection, stalled watcher, and `/turn-steer`

## What to polish before live testing

### 1. Command/help consistency

Confirm all user-facing command surfaces and help text are consistent:

- `/turn-status`
- `/why-silent`
- `/turns`
- `/nudge`
- `/turn-steer`
- upstream `/steer <id|#> <message>` remains subagent steering

Check for:

- help text drift
- registry/help mismatches
- test names referring to old `/tell` or old tracked-turn `/steer` semantics

### 2. Real-thread watcher behavior

Live testing should specifically verify:

- one early generic progress nudge for medium/long turns
- stalled notice appears once when appropriate
- stalled notice does not spam repeatedly
- a manual `/nudge` does not falsely clear stalled state
- intentional silence (`NO_REPLY`, heartbeat-style suppression) does not look like a delivery failure
- maintenance-only pre-compaction memory flush turns do not disappear into confusing silent dead air without a diagnosable reason

### 3. Turn steering ergonomics

Verify `/turn-steer` feels sane in real use:

- usage text when no message is supplied
- no-active-turn message
- cannot-steer-right-now message
- successful steer confirmation
- steering metadata appears in `/turn-status`

Potential minor polish if needed:

- make `/turns` mention recent steering more clearly
- improve wording for the cannot-steer case if it feels too generic in practice

### 4. Decide whether blocked-vs-stalled is required now

Current state distinguishes `stalled`, but not a richer `blocked` cause taxonomy.

Before live testing, decide whether to:

- defer `blocked` until after live feedback, or
- add a minimal first pass if the absence is already confusing during manual verification

Recommendation:

- defer unless live testing immediately shows that `stalled` is too coarse

### 5. Validate upstream `/steer` remains intact

Because Slice 3B intentionally avoided collision, live testing should include one explicit check that subagent steering still works with:

- `/steer <id|#> <message>`

That is a regression-sensitive surface and worth verifying once in a real environment.

## Suggested live-test matrix

### Thread visibility path

1. Start a turn that runs long enough to trigger a progress nudge.
2. Confirm `/turn-status` reflects active phase/tool.
3. Confirm `/turns` lists active + recent entries.
4. Confirm `/nudge` emits immediate status without falsely resetting stall/progress semantics.

### Stalled path

1. Start a turn that can sit without progress.
2. Confirm stalled state appears in `/turn-status` and `/why-silent`.
3. Confirm one machine-generated stalled notice appears.
4. Confirm it does not repeat excessively.

### Steering path

1. Start a steerable active turn.
2. Run `/turn-steer <text>`.
3. Confirm success reply.
4. Confirm steering metadata appears in `/turn-status`.
5. Confirm no collision with upstream subagent `/steer`.

### Delivery/suppression regression path

1. Exercise a `NO_REPLY` / intentionally silent case.
2. Exercise a delivery-failed case if feasible.
3. Exercise a maintenance-only pre-compaction memory flush case if feasible.
4. Confirm `/why-silent` distinguishes them correctly.

## Recommended last polish order

1. doc/help consistency sweep
2. one lightweight regression pass for command naming/help
3. live Slack-thread manual verification
4. only then decide whether blocked-vs-stalled or wording polish needs another code pass

## Definition of ready for live testing

Ready means:

- command/help/docs are consistent
- targeted tests are green
- no known command-name collision remains
- the remaining open items are observational/ergonomic rather than architectural
