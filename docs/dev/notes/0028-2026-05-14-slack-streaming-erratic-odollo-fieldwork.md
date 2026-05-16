# Slack Streaming Erratic Odollo Fieldwork

State: OPEN
Created: 2026-05-14

## Summary

SoyLei Odollo Amazon fulfillment fieldwork exposed another Slack streaming
noise pattern: a thread contained useful fulfillment automation output, but it
was surrounded by progress/status chatter and an unnecessary model-capability
fallback explanation. The deterministic Odollo timer was able to process the
order, but the OpenClaw-visible Slack behavior made the thread look erratic.

This note complements the earlier Slack progress notes:

- `0003-2026-04-23-slack-progress-mode-verbosity-and-duplicate-updates.md`
- `0025-2026-05-09-slack-visible-reply-fallback-miss.md`
- `0027-2026-05-12-slack-progress-draft-post-final-leftover.md`

## Incident

- Workspace/account: SoyLei Slack account `soylei`.
- Channel: `C0B1G5B697C` (`#amazon-apex-1132` in the operator UI).
- Thread root: `1778703304.978129`.
- Amazon order: `113-6112757-1628237`.
- User screenshot reply: `1778704840.078379`, Slack file
  `F0B3GM7C3JP`, filename `52885.jpeg`.

Observed thread sequence:

1. Odollo posted the canonical parent order thread at `1778703304.978129`.
2. Odollo posted an unnecessary same-state fulfillment status reply at
   `1778704313.838809`.
3. The user posted a seller-portal screenshot at `1778704840.078379`.
4. OpenClaw posted progress-only messages:
   - `1778704875.323049`: `working: reasoning`
   - `1778704972.270679`: `status: turn appears stalled`
5. OpenClaw posted an interim fallback notice at `1778705398.104939`:
   `The vision model is unavailable...`
6. OpenClaw posted a useful processing summary at `1778705398.310419` saying it
   extracted seller-portal fields and updated the sheet.
7. Odollo later posted a deterministic state-advance status at
   `1778706119.740369`, moving the thread to `tracking pending`.

## What Was Actually Broken

There were two separate sources of noise.

First, Odollo had a deterministic state-gating issue. The newly created thread
did not yet have `last_workflow_state` populated in the tenant Slack thread map,
so the next status pass posted a redundant same-state reply. Odollo has since
tightened its thread-map state gate and installed agent skill instructions.

Second, OpenClaw still emitted progress/status messages and an interim
capability-fallback message in the Slack thread. That behavior belongs here:

- `working: reasoning` and `status: turn appears stalled` were OpenClaw
  progress/runtime messages, not Odollo fulfillment-state messages.
- The "vision model unavailable" text was an agent-facing capability/fallback
  explanation. It should not have been posted as a separate user-facing message
  when the deterministic fallback was available and eventually succeeded.
- The screenshot did not need to become a user-facing failure. Odollo later
  consumed OCR-backed evidence for `52885.jpeg` and updated the fulfillment
  sheet.

## Expected Behavior

For this class of Slack-thread agent work:

- Progress-only messages should not remain as standalone thread replies once a
  final useful response lands.
- A stalled-turn watcher should not post `status: turn appears stalled` while a
  bounded tool/OCR fallback is still making progress.
- Capability fallback details such as missing vision support should be internal
  unless all allowed extraction paths fail and the operator must act.
- When a final answer or deterministic state-advance reply lands, any earlier
  progress preview should be edited away, deleted, or clearly folded into the
  final reply.
- OpenClaw should prefer one human-visible final answer for the turn over a
  sequence of progress, fallback, and final-result messages.

## Source Areas To Inspect

- Slack progress/draft delivery:
  `extensions/slack/src/monitor/message-handler/dispatch*.ts`
- Auto-reply dispatch and final delivery:
  `src/auto-reply/reply/dispatch-from-config.ts`
- Delivery observer and stalled-turn watcher:
  `src/auto-reply/reply/delivery-observer.ts`
  and `src/auto-reply/turn-tracker.ts`
- Tests already near this behavior:
  `src/auto-reply/reply/dispatch-from-config.test.ts`,
  `src/auto-reply/reply/delivery-observer.test.ts`, and
  Slack preview/fallback tests under `extensions/slack/src/monitor/`.

## Product Follow-Up

- Add a regression fixture for a Slack thread where an agent posts progress,
  executes a fallback extraction path, and then sends a final answer.
- Ensure final delivery cancels or cleans pending progress/stalled messages for
  that source thread.
- Consider suppressing progress-only Slack posts for configured automation
  agents or channels where deterministic systems already post explicit state
  transitions.
- Add an internal-only capability/fallback reporting channel for agent runtime
  diagnostics so user-facing Slack messages do not say "vision unavailable"
  unless the user must supply missing evidence.
- Verify whether `status: turn appears stalled` is keyed to active model output
  only or also accounts for long-running tool/process work.

## Acceptance Criteria

- A successful Slack-thread agent turn leaves at most one useful user-facing
  final response for the turn, plus intentional deterministic workflow-state
  posts.
- Progress-only messages such as `working: reasoning` and
  `status: turn appears stalled` do not remain after final delivery succeeds.
- Capability fallback messages are not emitted as separate Slack replies when a
  deterministic fallback succeeds.
- If all extraction paths fail, the final Slack reply explains the concrete
  operator action needed without also leaving stale progress/status messages.
