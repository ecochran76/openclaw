# SoyLei Ask-Lei Baker Follow-Up Miss

State: OPEN
Created: 2026-05-20

## Summary

SoyLei `#ask-lei` had two top-level Baker messages that Slack Mirror captured,
but OpenClaw did not admit into the Slack auto-reply path. The channel
configuration allowed Baker and did not require a mention. No OpenClaw
gateway/node dispatch log, session prompt, task, or delivery artifact was found
for the missed messages.

This is another instance of the stale-socket / missing-admission family tracked
in `docs/dev/notes/0030-2026-05-18-slack-stale-socket-missed-mention.md`, but
this case matters because it was a non-mention message in a channel configured
with `requireMention=false`.

## Incident

- Slack workspace/account: `soylei`
- Channel: `#ask-lei` / `C0B0AK14B7X`
- Intended agent: `soylei-primary`
- Requester: Baker / `U012ETLV6NQ`
- Root missed message timestamp: `1779318546.276599`
- Second missed top-level message timestamp: `1779318635.139349`
- Local time: `2026-05-20 18:09 CDT`

Root message text:

```text
Lei... why am I the one that jacks off the companies ambitious erections?
```

Second message text:

```text
Also lei if you can fight Michaels executive assistant that would be fun.
```

## Configuration Evidence

The SoyLei `#ask-lei` channel was configured to allow Baker without requiring a
mention:

```json
{
  "enabled": true,
  "requireMention": false,
  "users": ["U0127BGJ3U5", "U012M8NDV3K", "U012ETLV6NQ"]
}
```

The channel binding existed:

```json
{
  "agentId": "soylei-primary",
  "match": {
    "channel": "slack",
    "accountId": "soylei",
    "peer": {
      "kind": "channel",
      "id": "C0B0AK14B7X"
    }
  }
}
```

## Runtime Evidence

Slack Mirror saw both messages:

```bash
slack-mirror-user messages list \
  --workspace soylei \
  --channel C0B0AK14B7X \
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
2026-05-20T17:49:52.422-05:00 [health-monitor] [slack:soylei] health-monitor: restarting (reason: stale-socket)
2026-05-20T17:49:53.340-05:00 [slack] socket mode connected
2026-05-20T18:03:30.635-05:00 [health-monitor] [slack:soylei] health-monitor: restarting (reason: stale-socket)
2026-05-20T18:04:09.902-05:00 [slack] socket mode connected
2026-05-20T18:04:10.027-05:00 [slack] channels resolved: C0B0AK14B7X->ask-lei ...
2026-05-20T18:04:10.028-05:00 [slack] users resolved: U0127BGJ3U5, U012M8NDV3K, U012ETLV6NQ
```

No node-service entries were present for the incident window, and gateway logs
from `18:08:30` to `18:20:00` had only health/channel status responses, not a
Slack inbound dispatch for either Baker message.

## Recovery Performed

Manual recovery used `openclaw agent` to generate a Lei response with
`soylei-primary` on `xai/grok-4.3`, then posted the result as a thread reply to
the original Baker message using the SoyLei Slack bot token.

- Recovery session key:
  `agent:soylei-primary:manual-recovery:ask-lei:baker-1779318546`
- Recovery run id: `a33c2e76-6cf3-4880-8afe-e060a32cae11`
- Posted reply timestamp: `1779318785.746199`
- Posted reply thread: `1779318546.276599`

Thread verification:

```bash
slack-mirror-user messages thread \
  --workspace soylei \
  --channel C0B0AK14B7X \
  --thread 1779318546.276599 \
  --json
```

Result: the thread contains Baker's root message and Lei's bot reply at
`1779318785.746199`.

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
