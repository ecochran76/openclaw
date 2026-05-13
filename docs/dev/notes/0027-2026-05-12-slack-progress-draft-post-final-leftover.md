# Slack Progress Draft Post-Final Leftover

State: OPEN
Created: 2026-05-12

## Summary

SoyLei Slack `progress` streaming left standalone progress messages in a CRM
thread after a visible final reply had already been delivered. This made the
thread look stalled even though the task had completed.

## Evidence

- Workspace/account: SoyLei Slack account `soylei`.
- Channel: `C09RASAADDE` (`#crm`).
- Thread root: `1778625500.603729`.
- Final status reply: `1778634012.375509`, edited at `1778634035.000000`.
- Post-final leftover: `1778634034.836429`, text `working: reasoning`.
- Earlier same-thread leftovers after an applied CRM cleanup:
  - `1778625580.439459`, text `working: reasoning`.
  - `1778625679.499969`, text `status: turn appears stalled`.
- Gateway log around the second incident recorded final Slack delivery at
  `2026-05-12T20:00:36.100-05:00` and a 24s successful Slack auto-reply turn
  for inbound `1778634011.133499`.

## Observed Behavior

The user asked for status in the thread. OpenClaw posted/edited the visible
final answer, then a separate progress preview line remained visible. The
leftover message was not a model response and not useful user-facing state.

## Temporary Mitigation Applied In User Runtime

The SoyLei Slack account config was narrowed to suppress progress-only drafts:

```json
{
  "channels": {
    "slack": {
      "accounts": {
        "soylei": {
          "streaming": {
            "mode": "progress",
            "nativeTransport": true,
            "progress": {
              "label": false,
              "toolProgress": false
            }
          }
        }
      }
    }
  }
}
```

The three stale Slack messages listed above were deleted with Slack
`chat.delete` using the SoyLei bot token.

## Product Follow-Up

- Reproduce with Slack `progress` mode in a thread where final delivery edits a
  visible reply near the same time a progress/status draft is emitted.
- Ensure progress draft timers are cancelled once final delivery starts or
  succeeds.
- Ensure stalled-turn watcher notices are suppressed or cleaned up when a final
  answer lands.
- Add regression coverage near
  `extensions/slack/src/monitor/message-handler/dispatch.preview-fallback.test.ts`
  and the Slack turn-responsiveness watcher tests.

## Acceptance Criteria

- A successful final Slack reply leaves no later `working:*` or
  `status: turn appears stalled` progress-only messages in the thread.
- If final delivery fails, any progress/status message clearly says delivery
  failed and is not left as an ambiguous active-state marker.
- The SoyLei mitigation can be removed without reintroducing stale progress
  messages.
