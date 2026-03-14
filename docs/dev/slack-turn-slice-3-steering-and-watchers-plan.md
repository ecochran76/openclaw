# Slack Turn Visibility — Slice 3 Plan

## Status

Slice 3 is now in progress on `ec-main`:

- `3d925d0cc` — `/turns`, `/nudge`, and recent-turn list support
- `8de818625` — stalled state surfaced in inspection commands
- `cdf6f5aee` — stalled-turn watcher notices
- `d81df866f` — `/turn-steer` without colliding with upstream `/steer`

This document remains the main planning record for the remaining Slice 3 work.

## Goal

Move from **inspection + attribution** to **active control + stalled-turn handling**.

Slices 1 and 2 established the foundations:

- turn-state timeline
- silent-turn progress nudges
- `/turn-status`
- `/why-silent`
- delivery attribution
- explicit `reply_stranded` and `delivery_failed` states

Slice 3 should make the runtime not only explain turn state, but also let a human in Slack **act on it** when a turn is slow, stalled, noisy, or pointed in the wrong direction.

## User-facing outcomes

After Slice 3, a Slack user should be able to:

- inspect more than one turn state, not just the current one
- explicitly nudge or steer an active turn
- distinguish **slow** from **stalled** turns
- get machine-generated stalled-turn notices without relying on the model to narrate
- recover or redirect a problematic long-running turn without guessing

## Scope

### 1. Steering hooks

Add explicit steering surfaces for active turns.

Candidate commands:

- `/turn-steer <text>`
  - send a short steering instruction into the active turn context
- `/nudge`
  - request a machine-generated progress/status update immediately
- `/stop`
  - reuse or tighten existing abort semantics when a tracked turn is active

Key rule:

- steering should only apply to **steerable active turns**
- if no steerable turn exists, the runtime should say so clearly

### 2. Richer turn inspection

Add a broader inspection surface for sessions with more than one meaningful turn state.

Candidate command:

- `/turns`
  - list active turn + recent completed/error turns
  - compact summary with phase, duration, delivery state, and whether the turn is steerable

This should remain lightweight and in-memory; it is not a full historical event store.

### 3. Stalled-turn watcher

Add a runtime-driven stalled-turn detector.

The watcher should look for turns where:

- the turn is still marked active
- no phase/progress transition has happened for too long
- there is no successful visible delivery yet
- the turn is not intentionally suppressed

Target states:

- `stalled`
- or `blocked` if the runtime has a known wait/dependency reason later

Minimum initial behavior:

- emit one Slack-visible message such as:
  - `status: turn appears stalled`
  - `status: still waiting on tool/process`
- update tracked state so `/turn-status` and `/why-silent` report the stall coherently

### 4. Better runtime progress vocabulary

Slices 1 and 2 mostly use broad phases like `reasoning`, `tool_wait`, and `delivery_prepare`.

Slice 3 should decide whether to refine or group the phase model, for example:

- `tool_dispatch`
- `tool_wait`
- `apply_changes`
- `test_validate`
- `delivery_attempt`
- `blocked`
- `stalled`

This does **not** need full granular instrumentation everywhere in one pass, but the model should leave room for it.

### 5. Distinguish watcher classes clearly

By the end of Slice 3, the runtime should clearly separate:

- **silent but healthy**
- **delivery failed**
- **reply stranded**
- **suppressed intentionally**
- **stalled**
- **actively being steered**

These should not collapse into one ambiguous “still working” bucket.

## Candidate command behavior

### `/nudge`

Purpose:

- ask the runtime for an immediate status update on the active turn

Behavior:

- if active turn exists: emit concise current status
- if none exists: say there is no active turn to nudge

### `/turn-steer <text>`

Purpose:

- inject a short steering directive into an active turn

Behavior:

- only allowed for authorized senders
- only for active steerable turns
- should record that steering occurred so diagnostics/status can mention it later

Examples:

- `/turn-steer focus on the failing delivery path only`
- `/turn-steer stop coding and summarize current findings`
- `/turn-steer skip polish and run tests first`

### `/turns`

Purpose:

- show active turn + recent completed/error turns for the session

Output shape:

- one line per turn
- duration class
- phase/state
- delivery state
- steerable yes/no

## Non-goals for Slice 3

Do **not** do these unless a later slice explicitly asks for them:

- persistent turn history on disk
- full conversational branch management
- multi-user steering arbitration
- automatic replay/retry of failed tool executions
- full ACP parity unless the Slack path is already stable

## Likely code touch points

Primary:

- `src/auto-reply/turn-tracker.ts`
- `src/auto-reply/reply/commands-info.ts`
- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/auto-reply/status.ts`

Potential new surfaces:

- `src/auto-reply/reply/commands-turns.ts`
- `src/auto-reply/reply/commands-steer.ts`
- `src/auto-reply/reply/commands-nudge.ts`

Likely tests:

- `src/auto-reply/turn-tracker.test.ts`
- `src/auto-reply/reply/commands-turn-status.test.ts`
- `src/auto-reply/reply/commands-why-silent.test.ts`
- `src/auto-reply/reply/dispatch-from-config.test.ts`
- new command tests for `/turns`, `/steer`, `/nudge`

## Proposed implementation order

### Slice 3A — inspection and nudge

- add `/turns`
- add `/nudge`
- add tracked “stalled candidate” / no-progress thresholds
- expose stalled state in `/turn-status` and `/why-silent`

### Slice 3B — steering

Status: mostly landed.

- added `/turn-steer <text>`
- kept upstream `/steer <id|#> <message>` for subagent steering
- defined active-turn targeting semantics
- recorded steering events in tracked state
- surfaced steering metadata in turn inspection output

Remaining questions:

- should `/why-silent` or `/turns` mention recent steering more explicitly?
- do we want a dedicated “cannot steer this turn” reason taxonomy beyond the current message?

### Slice 3C — stalled-turn watcher polish

Status: partially landed.

- machine-generated stalled-turn notices landed
- stalled state is surfaced in inspection output
- still open:
  - separate `blocked` vs `stalled` where possible
  - tune thresholds and avoid duplicate/spammy patterns in real Slack threads
  - handle maintenance-only suppressed turns (for example pre-compaction memory flush) as a distinct UX case instead of generic suppression

Related follow-on plan:

- `docs/dev/slack-turn-maintenance-suppression-plan.md`

## Acceptance criteria

Slice 3 is done when:

1. A user can list and inspect active/recent turns beyond a single `/turn-status` snapshot.
2. A user can trigger an immediate runtime status update with `/nudge`.
3. A steerable active turn can accept a focused steering instruction.
4. The runtime marks stalled turns distinctly from slow healthy turns.
5. Stalled-turn notices are machine-generated and non-spammy.
6. The inspection commands, steering behavior, and stalled watcher all have focused tests.

## Validation plan

Minimum targeted coverage:

- `pnpm test -- src/auto-reply/turn-tracker.test.ts`
- `pnpm test -- src/auto-reply/reply/dispatch-from-config.test.ts`
- `pnpm test -- src/auto-reply/reply/commands-turn-status.test.ts`
- `pnpm test -- src/auto-reply/reply/commands-why-silent.test.ts`
- command tests for `/turns`, `/nudge`, `/turn-steer`
- `pnpm tsgo`

## Why Slice 3 matters

Slices 1 and 2 answer:

- `what is happening?`
- `did delivery fail?`
- `was silence intentional?`

Slice 3 answers the next operational question:

> `What can I do about this turn right now?`

That is the step from visibility into real control.
