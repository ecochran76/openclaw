# Slack Turn Visibility — Maintenance / Suppressed-Turn UX Plan

## Goal

Close the user-experience gap where a real Slack thread goes silent because the runtime performed a **maintenance-only turn** that intentionally ends with `NO_REPLY`.

This is different from:

- `delivery_failed`
- `reply_stranded`
- `stalled`
- ordinary user-authored intentional silence

The motivating case is the **pre-compaction memory flush** path, where the system asks the agent to persist memory and explicitly enforces a silent `NO_REPLY` response if there is nothing else to say.

## Why this matters

From the runtime's point of view, the turn is successful:

- maintenance work completed
- no user-visible reply was intended
- nothing crashed

From the human's point of view, it still looks like:

> I said something, then Slack went quiet.

That makes maintenance suppression feel like a bug even when it is technically working as designed.

## Existing evidence / constraints

Relevant config surface already exists:

- `AgentCompactionMemoryFlushConfig`
- pre-compaction memory flush is enabled/configurable
- the memory flush prompt explicitly enforces `NO_REPLY` when missing

Relevant code/config reference:

- `src/config/types.agent-defaults.ts`

## Problem statement

Today, the suppression taxonomy is too coarse.

We distinguish:

- empty
- silent (`NO_REPLY`)
- heartbeat suppression

But we do **not** distinguish:

- deliberate user-facing silence because the agent had nothing to say
- system maintenance suppression because a maintenance turn consumed the visible turn

Those are operationally different and should not be merged into one generic `suppressed` bucket.

## Desired user-visible behavior

When a maintenance-only turn finishes in a live Slack thread, the runtime should avoid confusing dead air.

Minimum desired outcome:

- maintenance suppression is recognized as its **own reason class**
- inspection surfaces can explain it explicitly
- optionally, a lightweight machine-generated status message can make the maintenance turn visible

Target user-facing wording examples:

- `status: context maintenance completed`
- `status: maintenance turn completed; resuming`
- `/why-silent` → `Answer: the last turn was a maintenance-only turn that intentionally produced no visible reply.`

## Scope

### 1. Separate suppression reason for maintenance

Extend suppression classification so we can tell apart:

- ordinary `NO_REPLY`
- heartbeat suppression
- maintenance suppression

Candidate tracked-turn shape additions:

- `suppressionReason?: "silent" | "heartbeat" | "maintenance"`
- or a broader user-visible classification field if cleaner

### 2. Maintenance-aware inspection output

Update inspection surfaces so they can say more than just `suppressed`.

Minimum surfaces:

- `/why-silent`
- `/turn-status`

Nice to have:

- `/turns`

Desired output should explicitly say **maintenance** rather than only `suppressed`.

### 3. Optional machine-generated maintenance notice

For live-thread clarity, consider a lightweight status notice when a maintenance-only turn completes.

Guardrails:

- only when the turn would otherwise disappear into silent maintenance
- do not spam repeated maintenance notices
- do not break the underlying maintenance-turn contract
- keep it Slack-first / thread-safe in the first pass

This should be treated as a visibility shim, not as “the assistant replying normally.”

### 4. Preserve ordinary suppression semantics

Do **not** regress the existing distinction between:

- intentional ordinary `NO_REPLY`
- heartbeat suppression
- delivery failure
- reply stranded
- stalled

The maintenance case is additive, not a rewrite of the whole taxonomy.

## Non-goals

Do **not** do these in the first pass:

- rewrite the memory flush system prompt design entirely
- add persistent maintenance event history on disk
- generalize every silent system event into a visible Slack notice
- ACP parity or non-Slack transport parity before Slack behavior is sound

## Likely code touch points

Primary:

- `src/auto-reply/reply/normalize-reply.ts`
- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/auto-reply/turn-tracker.ts`
- `src/auto-reply/reply/commands-info.ts`
- memory-flush / compaction-related runner path(s)

Relevant config/modeling context:

- `src/config/types.agent-defaults.ts`
- `src/auto-reply/reply/memory-flush.ts`

Likely tests:

- reply normalization tests
- dispatch-from-config tests
- turn-tracker tests
- `/why-silent` / `/turn-status` command tests

## Proposed implementation order

### Phase A — classification only

- add a maintenance-specific suppression reason/classification
- surface it in `/why-silent` and `/turn-status`
- add focused tests

### Phase B — optional user-visible maintenance notice

- decide whether a one-line machine-generated Slack notice should ship
- if yes, emit it only for maintenance-only turns that would otherwise vanish
- add non-spam tests

### Phase C — live-thread wording polish

- tune the maintenance wording from real Slack-thread feedback
- decide whether `/turns` should expose maintenance suppression explicitly or keep it concise

## Acceptance criteria

This maintenance UX work is done when:

1. A maintenance-only suppressed turn is distinguishable from ordinary `NO_REPLY` and heartbeat suppression.
2. `/why-silent` explicitly explains maintenance suppression.
3. `/turn-status` exposes maintenance suppression clearly enough for debugging.
4. Existing suppression / delivery / stalled behavior does not regress.
5. If a visible maintenance notice is added, it is one-shot and non-spammy.

## Recommendation

Treat this as the next **last-mile polish patch** before or during live testing, not a new large slice.

The smallest safe first step is:

1. classify maintenance suppression separately
2. expose it in inspection commands
3. only then decide whether to add a visible Slack maintenance notice

That gets most of the diagnostic value without prematurely forcing a visible-notice policy.
