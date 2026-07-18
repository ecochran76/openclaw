# Slack Stale Socket Missed Mention

State: OPEN
Created: 2026-05-18

## Summary

A example tenant `#website` thread had a direct mention of the `example-website` agent
that was mirrored by Slack Mirror but never appeared in OpenClaw's Slack
auto-reply pipeline, session store, delivery queue, or wake-trigger state.

This looks like a Slack Socket Mode admission gap after a stale-socket restart:
OpenClaw was connected and healthy by status after the restart, but one
subsequent directly-mentioned message was missed entirely by the OpenClaw
runtime.

## Incident

- Slack workspace/account: `example`
- Channel: `#website` / `channel-id-redacted`
- Thread timestamp: `timestamp-redacted`
- Missed message timestamp: `timestamp-redacted`
- Missed message local time: `2026-05-18 12:20:19 CDT`
- Slack client message id: `RUN_ID_REDACTED`
- Mentioned Slack user id: `user-id-redacted`
- Intended agent: `example-website`

The private message body is intentionally omitted. It was a direct mention from
an allowlisted user in a bound channel.

## Evidence

Slack Mirror had the message and raw Slack payload:

```bash
slack-mirror-user messages permalink-resolve 'https://example.slack.com/archives/channel-id-redacted/p1700000000000001' --json
slack-mirror-user messages thread --workspace example --channel channel-id-redacted --thread-ts timestamp-redacted --selected-ts timestamp-redacted --include-derived-text --include-ocr --json
```

The raw Slack Mirror row showed:

```json
{
  "ts": "timestamp-redacted",
  "user": "user-id-redacted",
  "text": "[private message omitted]",
  "thread_ts": "timestamp-redacted",
  "client_msg_id": "RUN_ID_REDACTED"
}
```

OpenClaw had no corresponding runtime record:

```bash
rg -n 'timestamp-redacted|RUN_ID_REDACTED' /tmp/openclaw ~/.openclaw --glob '!**/node_modules/**' --glob '!**/cache/**' --glob '!**/browser/**'
```

Both searches returned no OpenClaw-owned hit for the missed message. The
`example-website` thread session also did not contain the missed message:

```bash
python3 - <<'PY'
from pathlib import Path
sess=Path('/home/user/.openclaw/agents/example-website/sessions/RUN_ID_REDACTED-topic-timestamp-redacted.jsonl')
for needle in ['1779124481','1779124819','capitalized consistently','small typo']:
    found=False
    with sess.open(errors='ignore') as f:
        for n,line in enumerate(f,1):
            if needle in line:
                print(f'{needle}: found line {n}')
                found=True
                break
    if not found:
        print(f'{needle}: not found')
PY
```

Observed result:

```text
1779124481: found line 45
1779124819: not found
capitalized consistently: not found
small typo: found line 44
```

That matters because `timestamp-redacted` was an immediately earlier direct
mention in the same thread. It did dispatch to `example-website`, completed a
model turn, and posted a reply. The later `timestamp-redacted` message was not
admitted at all.

OpenClaw logs around the same window show a stale-socket restart before the
missed message:

```text
2026-05-18T17:16:29.392Z [slack:example] health-monitor: restarting (reason: stale-socket)
2026-05-18T17:16:29.480Z [example] starting provider
2026-05-18T17:16:29.932Z slack socket mode connected
2026-05-18T17:16:29.949Z slack channels resolved: ... channel-id-redacted->website ...
2026-05-18T17:16:29.950Z slack users resolved: user-id-redacted, user-id-redacted, user-id-redacted
```

Current health after the incident was green:

```text
Slack example (example tenant Slack): enabled, configured, running, connected, in:14m ago, bot:config, app:config, health:healthy
```

## Hypothesis

The stale-socket recovery path can leave a gap where Slack Mirror receives and
stores a message, but OpenClaw Socket Mode does not admit the event into the
auto-reply dispatch path. Because no OpenClaw turn is created, downstream
diagnostics such as final-delivery checks, `NO_REPLY` behavior, session
inspection, and delivery queue inspection all show nothing useful.

This is different from the 2026-05-09 visible-reply fallback miss. In this
case, there was no OpenClaw session for the missed message at all.

## Desired Product Follow-Up

Add a reconciliation diagnostic and, eventually, an optional recovery loop for
bound Slack agents:

1. For each Slack channel binding, periodically or on demand compare recent
   Slack Mirror messages that directly mention the bound bot/user id against
   OpenClaw session admission records.
2. Flag any direct mention that is mirrored but has no matching OpenClaw
   session prompt, trace, dispatch, or explicit ignore record.
3. Include enough evidence in `openclaw channels why-silent` or a sibling
   command to answer "Slack saw this; did OpenClaw admit it?"
4. Consider a guarded recovery action that can queue or replay the missed
   mention into the correct agent/session after operator approval.

The minimum useful diagnostic is a command that accepts a Slack permalink and
returns:

- Slack Mirror resolution status.
- Whether the raw message directly mentions a configured/bound bot user id.
- Matching OpenClaw session key and prompt/turn id, if admitted.
- Explicit "no OpenClaw admission record found" when missing.
- Nearby channel-account health events, especially stale-socket restarts.

## Related Notes

- `docs/dev/notes/0017-2026-05-04-example-slack-socket-stale-ingress.md`
- `docs/dev/notes/0025-2026-05-09-slack-visible-reply-fallback-miss.md`
