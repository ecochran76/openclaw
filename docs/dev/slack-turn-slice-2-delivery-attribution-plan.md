# Slack Turn Visibility — Slice 2 Plan

## Status

This slice is now implemented on `ec-main` as a series of commits:

- `05571e149` — delivery attribution surfaced in runtime state and `/status`
- `987865f7c` — machine-generated reply-delivery failure notices
- `5f9754034` — suppressed replies distinguished from delivery failures
- `f8523c896` — `/why-silent`
- `1f104770f` — explicit `reply_stranded` finalization

This document remains useful as the design/acceptance record for what Slice 2 set out to do.

## Goal

Make it obvious when a Slack turn is not merely silent, but is instead:

- finished but not yet delivered
- unable to deliver a reply
- stranded after substantive work
- failed in routing/transport rather than model execution

Slice 1 gave us turn-state tracking, `/turn-status`, and the first silent-turn watcher.

Slice 2 should make **delivery attribution** a first-class part of that model so the runtime can explain the difference between:

- "still working"
- "worked, but reply not delivered"
- "delivery attempt failed"
- "nothing user-visible was emitted yet"

## User-facing outcomes

After Slice 2, a human in Slack should be able to tell:

- whether the model has already produced a meaningful reply
- whether the system attempted block/final delivery
- whether delivery succeeded, failed, or is still pending
- whether the turn ended without a visible reply and why

## Scope

### 1. Delivery state model

Extend the tracked turn state from a coarse `deliveryState` into explicit delivery attribution.

Suggested additions:

- `deliveryState`
  - `pending`
  - `block_sent`
  - `final_sent`
  - `reply_stranded`
  - `delivery_failed`
  - `suppressed`
  - `none`
- `deliveryTarget`
  - `dispatcher`
  - `routeReply`
  - `originating_channel`
  - `same_channel`
- `lastDeliveryAttemptAt`
- `lastDeliverySuccessAt`
- `lastDeliveryError`
- `replyProduced`
  - boolean: whether substantive assistant output existed

This should remain cheap and in-memory.

### 2. Reply-stranded watcher

Add a runtime watcher for turns where:

- substantive work completed
- a reply existed or should have existed
- no user-visible delivery succeeded

Behavior:

- mark turn `deliveryState=reply_stranded`
- preserve best-known attribution
- emit one concise Slack-visible failure/status message when safe

Target examples:

- `status: reply ready but not delivered`
- `status: work completed, but Slack delivery failed`

### 3. Clearer Slack-facing failure text

Replace ambiguous silence with short operational messages.

Examples:

- `status: reply prepared, attempting delivery`
- `status: reply delivery failed`
- `status: turn finished but no visible reply was sent`

These should be machine-generated, not dependent on the model remembering to narrate.

### 4. `/turn-status` enrichment

Add delivery attribution to `/turn-status` output:

- reply produced: yes/no
- delivery state
- delivery target
- last delivery attempt
- last delivery success
- last delivery error

If the turn is recent-but-complete, `/turn-status` should still expose the last known delivery outcome.

### 5. `/status` summary enrichment

The broader `/status` output should include a compact turn-visibility summary when an active turn exists, for example:

- `Turn: tool wait · medium · reply pending`
- `Turn: done · delivery failed`

Keep it short; `/turn-status` remains the detailed inspection surface.

## Non-goals for Slice 2

Do **not** add these yet:

- full steering commands
- multi-turn history browser
- stalled-turn auto-recovery
- persistent turn ledger on disk
- provider-specific retry orchestration beyond clear attribution

Those belong to later slices.

## Likely code touch points

Primary:

- `src/auto-reply/turn-tracker.ts`
- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/auto-reply/reply/commands-info.ts`
- `src/auto-reply/status.ts`

Likely related tests:

- `src/auto-reply/turn-tracker.test.ts`
- `src/auto-reply/reply/commands-turn-status.test.ts`
- `src/auto-reply/reply/dispatch-from-config.test.ts`
- `src/auto-reply/status.test.ts`

Potential follow-on if ACP delivery should align later:

- `src/auto-reply/reply/dispatch-acp-delivery.ts`
- `src/auto-reply/reply/dispatch-acp.test.ts`

## State-transition sketch

### Active successful block-first turn

- `pending`
- `block_sent`
- `final_sent` or remain block-only if intentionally no final text

### Finished but stranded

- `pending`
- `replyProduced=true`
- no successful visible delivery
- `reply_stranded`

### Explicit transport/routing failure

- `pending`
- delivery attempt recorded
- `delivery_failed`
- `lastDeliveryError` populated

## Acceptance criteria

Slice 2 is done when:

1. `/turn-status` exposes delivery attribution in active and recent completed turns.
2. `/status` shows a concise active-turn delivery summary.
3. A turn that produced meaningful output but failed visible delivery no longer looks like generic silence.
4. The runtime marks stranded replies distinctly from still-running turns.
5. The implementation is covered by focused tests for success, stranded, and failure paths.

## Validation plan

Minimum targeted coverage:

- `pnpm test -- src/auto-reply/turn-tracker.test.ts`
- `pnpm test -- src/auto-reply/reply/commands-turn-status.test.ts`
- `pnpm test -- src/auto-reply/reply/dispatch-from-config.test.ts`
- `pnpm test -- src/auto-reply/status.test.ts`
- `pnpm tsgo`

If the change touches ACP delivery behavior, add:

- `pnpm test -- src/auto-reply/reply/dispatch-acp.test.ts`
- `pnpm test -- src/auto-reply/reply/dispatch-acp-delivery.test.ts`

## Proposed implementation order

1. Extend `turn-tracker.ts` delivery fields + formatters.
2. Record delivery attempts/success/failure in `dispatch-from-config.ts`.
3. Enrich `/turn-status` with delivery attribution.
4. Add compact active-turn summary to `/status`.
5. Add reply-stranded watcher + Slack-visible failure/status text.
6. Backfill targeted tests.

## Why this slice matters

Slice 1 solved "why is it quiet?" for long-running work.

Slice 2 solves the more frustrating case:

> "Did it finish and fail to tell me?"

That is the trust-breaking gap we should close next.
