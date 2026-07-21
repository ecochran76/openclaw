State: CLOSED
Created: 2026-07-16

# Abort-Bound Failure-Notice Delivery

## Current State

A failure-notice delivery may continue after the source dispatch is aborted.
The notice is allowed to bypass source-reply suppression, but that metadata is
not authority to outlive cancellation.

Execution owner: dedicated subagent for Plan 0020.

## Scope

- Bind failure-notice delivery to the source dispatch abort lifecycle.
- Preserve intentional delivery despite ordinary source-reply suppression.
- Add deterministic regression coverage for abort before and during delivery.

## Non-Goals

- Redesigning general reply suppression, follow-up queues, or delivery retry.
- Changing unrelated cron failure notifications.

## Work Phases

1. Trace failure-notice construction through follow-up dispatch and abort
   primitives.
2. Carry or check the canonical abort signal at the delivery boundary.
3. Add focused cancellation and non-cancellation regressions.
4. Run the affected dispatch tests and `git diff --check`.

## Acceptance Criteria

- Aborted source dispatches cannot emit a late failure notice.
- Non-aborted suppressed source replies can still emit the intended notice.
- Existing terminal outcome precedence remains unchanged.

## Definition Of Done

The plan is `CLOSED`, its subagent records deterministic focused proof, and no
unrelated delivery policy changes.

## Closeout | 2026-07-16

Implemented the cancellation boundary without changing ordinary suppression
policy:

- `dispatch-from-config` retains the canonical dispatch abort signal while it
  waits for terminal delivery outcomes, rechecks cancellation before creating
  an undelivered-reply notice, and passes that signal through routed notice
  delivery.
- `followup-runner` binds every admitted run's delivery helpers to
  `resolveFollowupAbortSignal(effectiveQueued)`. It checks cancellation before
  delivery, after typing work, and after routed delivery, and passes the signal
  to `routeReply`.
- Marked failure notices still bypass `message_tool_only` source-reply
  suppression while the source remains active. That metadata does not bypass
  abort cancellation.

Deterministic regression coverage proves:

- an active marked failure notice is still delivered;
- abort before failure-notice delivery suppresses it;
- abort during routed failure-notice delivery reaches the transport signal and
  prevents dispatcher fallback;
- a routed Slack undelivered-reply notice receives the dispatch-derived abort
  signal and observes source abort during delivery.

Validation receipts:

- `node scripts/run-vitest.mjs src/auto-reply/reply/followup-runner.test.ts` —
  PASS, 153 tests.
- `node scripts/run-vitest.mjs src/auto-reply/reply/dispatch-from-config.test.ts -t 'binds routed undelivered-reply notices'` —
  PASS, 1 test with 271 skipped.
- The unfiltered dispatch aggregate was stopped after 30 seconds without a
  result to keep this recovery lane bounded; the changed dispatch behavior has
  the deterministic focused receipt above.
- `oxfmt --write` completed for the four touched source/test files.
- `git diff --check` completed cleanly for the Plan 0020 paths.
- Bounded autoreview used one isolated 30,040-byte pass containing only the
  four touched source/test files. It emitted healthy 60-second and 120-second
  heartbeats but no structured result by the three-minute recovery cap, so it
  was interrupted once without retry. No autoreview finding was returned or
  applied.

Residual unrelated diagnostic:

- Targeted `oxlint` still reports the inherited
  `dispatch-from-config.ts:953` `prefer-const` finding outside this plan's
  cancellation hunk. The Plan 0020 test-file lint finding was corrected before
  closeout.
