# Slack Visible Reply Fallback Miss

Date: 2026-05-09

## Summary

An Odollo SoyLei Slack thread run showed a successful agent turn with final
assistant text in the session transcript, but no final visible Slack reply.
The configured OpenClaw policy had `messages.groupChat.visibleReplies` set to
`automatic`, so the final assistant text should have been delivered even though
the model did not call the message tool.

## Incident

- Agent: `odollo-soylei`
- Slack account/channel: `soylei` / `C09RASAADDE`
- Thread timestamp: `1778365852.532279`
- Session key:
  `agent:odollo-soylei:slack:channel:c09rasaadde:thread:1778365852.532279`
- Session id: `93cf6ea8-1c4b-4d8b-90d1-1feb1d4cd0d4`
- First run id: `72c71bef-0ef6-4c56-b962-2a25ba47e30f`
- Follow-up run id: `e3fb7694-a9ca-4f26-95b2-01c901417070`

Both runs reached `finalStatus: success`. The trace artifacts contained
non-empty `assistantTexts`, but also:

```text
didSendViaMessagingTool: false
messagingToolSentTexts: []
messagingToolSentTargets: []
```

Slack received progress/status messages such as `working: reasoning` and
`status: turn appears stalled`, but the final assistant result was not posted
to the thread.

## Expected Behavior

OpenClaw docs say group/channel rooms default to message-tool-only visible
replies, but setting `messages.groupChat.visibleReplies: "automatic"` restores
legacy visible final replies. The runtime config at the time of the incident
had:

```json
{
  "messages": {
    "groupChat": {
      "visibleReplies": "automatic"
    }
  }
}
```

With that policy, a successful agent run with final assistant text should have
posted that text to the Slack thread, even if the model did not use the message
tool.

## Related Noise

During the same investigation, the Odollo tenant runtime workspace contained an
oversized `HEARTBEAT.md`. OpenClaw warned that the workspace bootstrap file was
over the injection limit and truncated. That file was stale operational state
from an older heartbeat-based design; the current SoyLei Odollo scheduled work
is driven by systemd user timers. The file was archived out of the runtime
workspace root as:

```text
~/.odollo/openclaw/agents/soylei-prod-odollo-agent/archive/HEARTBEAT-archived-2026-05-09.not-injected
```

This context-warning was not the final-delivery failure, but it made the run
noisier and increased prompt risk.

The same run also showed advisory memory bootstrap failures from provider
quota. That affected memory recall only; the model still completed and wrote
final assistant text.

## Follow-Up

- Implemented in `src/auto-reply/reply/dispatch-from-config.ts` by inferring
  channel/group context from channel-shaped source metadata when `ChatType` is
  missing.
- Added regression coverage in
  `src/auto-reply/reply/dispatch-from-config.test.ts` for Slack channel-shaped
  turns without `ChatType`, both with `groupChat.visibleReplies: "automatic"`
  and with the default private group policy.
- Consider surfacing an explicit delivery diagnostic when a run completes
  successfully but no visible final reply is delivered to the source thread.
