# Slack Ack Reaction Invalid Name Broke Visible Acknowledgement

State: OPEN
Created: 2026-05-18

## Summary

The SoyLei `soylei-website` agent completed a requested dev-site edit, but the
Slack thread showed weak acknowledgement and missing or confusing status
feedback. The runtime admitted the messages and completed the relevant turns,
but the pre-pipeline Slack acknowledgement path failed because it attempted to
use the agent identity label `SW` as a Slack reaction name.

## Incident

- Slack workspace/account: `soylei`
- Channel: `#website` / `C06L8DVBWQP`
- Thread timestamp: `1779054888.591249`
- Explicit request timestamp: `1779127004.042119`
- Acknowledgement ping timestamp: `1779127062.841709`
- Agent: `soylei-website`

The user observed an hourglass and then quiet. OpenClaw later posted a final
reply after completing the dev-site cleanup, but it did not acknowledge early
enough to make the operator confident that it was working.

## Evidence

The relevant session trace shows the explicit request was admitted and completed
successfully:

```text
2026-05-18T17:56:57.284Z session.started
message_id: 1779127004.042119
mention_source: explicit_bot
2026-05-18T17:59:55.679Z model.completed
assistantTexts: Done, Eric. Dev post is cleaned up now...
```

The later "please acknowledge" message was also admitted, but completed quickly
without a visible reply:

```text
traceId: C06L8DVBWQP:1779127062.841709
dispatch:done elapsedMs=1674
agent turn completed (1.7s total)
```

The Slack runtime logs showed the key failure:

```text
slack pre-pipeline ack failed
error: An API error occurred: invalid_name
```

Config before the runtime fix had no explicit `messages.ackReaction`, no Slack
account `ackReaction`, and the `soylei-website` identity emoji was the plain
text label `SW`:

```json
{
  "messages": {
    "ackReactionScope": "group-mentions"
  },
  "agents": {
    "soylei-website": {
      "identity": {
        "emoji": "SW"
      }
    }
  }
}
```

`resolveAckReaction()` falls back to the agent identity emoji when no explicit
ack reaction is configured. Slack `reactions.add` expects a real Unicode emoji
or Slack shortcode-compatible reaction name. `SW` is not a valid Slack reaction
name, so the pre-pipeline ack fails.

## Runtime Mitigation Applied

On the local runtime, set:

```json
{
  "messages": {
    "ackReaction": "eyes"
  }
}
```

Then restarted the gateway and verified:

```text
openclaw config get messages.ackReaction -> eyes
openclaw config validate -> Config valid
openclaw gateway status --deep --require-rpc -> Read probe ok
openclaw channels status -> Slack soylei healthy
```

## Product Follow-Up

OpenClaw should not silently treat arbitrary identity labels as Slack reactions.
At least one of these should be implemented:

1. Validate `identity.emoji` for Slack reaction fallback use before attempting
   `reactions.add`.
2. If `identity.emoji` is not a valid Slack reaction, fall back to the default
   `eyes` reaction instead of passing the invalid label to Slack.
3. Warn in `openclaw doctor` when a Slack-bound agent has a text identity emoji
   such as `SW`, `SLM`, or `APEX` and no explicit `messages.ackReaction` or
   Slack account-level `ackReaction`.

Separately, status/progress UX should produce an early visible text/status
acknowledgement for long-running website tasks before starting edits. The model
completed the task correctly, but the operator-facing behavior was poor because
the user could not tell whether Lei was actively working or ignoring the thread.

## Related Notes

- `docs/dev/notes/0030-2026-05-18-slack-stale-socket-missed-mention.md`
- `docs/dev/notes/0025-2026-05-09-slack-visible-reply-fallback-miss.md`
