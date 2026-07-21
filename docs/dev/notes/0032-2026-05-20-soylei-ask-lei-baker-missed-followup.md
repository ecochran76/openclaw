# Example Tenant Always-Listen Follow-Up Miss

State: OPEN
Created: 2026-05-20

## Summary

example tenant `#always-listen` had two top-level requester messages that Slack Mirror captured,
but OpenClaw did not admit into the Slack auto-reply path. The channel
configuration allowed requester and did not require a mention. No OpenClaw
gateway/node dispatch log, session prompt, task, or delivery artifact was found
for the missed messages.

This is another instance of the stale-socket / missing-admission family tracked
in `docs/dev/notes/0030-2026-05-18-slack-stale-socket-missed-mention.md`, but
this case matters because it was a non-mention message in a channel configured
with `requireMention=false`.

## Incident

- Slack workspace/account: `example`
- Channel: `#always-listen` / `channel-id-redacted`
- Intended agent: `example-primary`
- Requester: requester / `user-id-redacted`
- Root missed message timestamp: `timestamp-redacted`
- Second missed top-level message timestamp: `timestamp-redacted`
- Local time: `2026-05-20 18:09 CDT`

The private message bodies are intentionally omitted. Both were ordinary
non-mention requests covered by the channel's always-listen policy.

## Configuration Evidence

The example tenant `#always-listen` channel was configured to allow requester without requiring a
mention:

```json
{
  "enabled": true,
  "requireMention": false,
  "users": ["user-id-redacted", "user-id-redacted", "user-id-redacted"]
}
```

The channel binding existed:

```json
{
  "agentId": "example-primary",
  "match": {
    "channel": "slack",
    "accountId": "example",
    "peer": {
      "kind": "channel",
      "id": "channel-id-redacted"
    }
  }
}
```

## Runtime Evidence

Slack Mirror saw both messages:

```bash
slack-mirror-user messages list \
  --workspace example \
  --channel channel-id-redacted \
  --after 1779318500 \
  --before 1779319800 \
  --limit 80 \
  --json
```

OpenClaw status was healthy after the incident:

```text
Gateway service: enabled and running
Node service: enabled and running
Slack: OK, accounts 2/2
Tasks: 0 active, 0 queued, 0 running
```

Relevant gateway log sequence:

```text
2026-05-20T17:49:52.422-05:00 [health-monitor] [slack:example] health-monitor: restarting (reason: stale-socket)
2026-05-20T17:49:53.340-05:00 [slack] socket mode connected
2026-05-20T18:03:30.635-05:00 [health-monitor] [slack:example] health-monitor: restarting (reason: stale-socket)
2026-05-20T18:04:09.902-05:00 [slack] socket mode connected
2026-05-20T18:04:10.027-05:00 [slack] channels resolved: channel-id-redacted->always-listen ...
2026-05-20T18:04:10.028-05:00 [slack] users resolved: user-id-redacted, user-id-redacted, user-id-redacted
```

No node-service entries were present for the incident window, and gateway logs
from `18:08:30` to `18:20:00` had only health/channel status responses, not a
Slack inbound dispatch for either requester message.

## Recovery Performed

Manual recovery used `openclaw agent` to generate a agent response with
`example-primary` on `xai/grok-4.3`, then posted the result as a thread reply to
the original requester message using the example tenant Slack bot token.

- Recovery session key:
  `agent:example-primary:manual-recovery:always-listen:baker-1779318546`
- Recovery run id: `RUN_ID_REDACTED`
- Posted reply timestamp: `timestamp-redacted`
- Posted reply thread: `timestamp-redacted`

Thread verification:

```bash
slack-mirror-user messages thread \
  --workspace example \
  --channel channel-id-redacted \
  --thread timestamp-redacted \
  --json
```

Result: the thread contains requester's root message and agent's bot reply at
`timestamp-redacted`.

## Product Follow-Up

The active Slack stale-socket watchdog/admission-ledger work should account for
this case:

1. Watchdog scans must include configured always-listen channels where
   `requireMention=false`, not only direct mentions.
2. The admission ledger should record either admitted, ignored-with-reason, or
   missing for every eligible Slack Mirror message in a bound channel window.
3. `openclaw channels why-silent` or a sibling diagnostic should answer:
   Slack Mirror saw the message, channel policy says it was eligible, but no
   OpenClaw admission record exists.
4. Recovery should be guarded and idempotent: do not blindly replay all missed
   messages, but make operator-approved replay possible into the correct
   agent/session/thread.
