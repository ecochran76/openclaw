# Slack Stale Socket Missed Mention

State: OPEN
Created: 2026-05-18

## Summary

A SoyLei `#website` thread had a direct mention of the `soylei-website` agent
that was mirrored by Slack Mirror but never appeared in OpenClaw's Slack
auto-reply pipeline, session store, delivery queue, or wake-trigger state.

This looks like a Slack Socket Mode admission gap after a stale-socket restart:
OpenClaw was connected and healthy by status after the restart, but one
subsequent directly-mentioned message was missed entirely by the OpenClaw
runtime.

## Incident

- Slack workspace/account: `soylei`
- Channel: `#website` / `C06L8DVBWQP`
- Thread timestamp: `1779054888.591249`
- Missed message timestamp: `1779124819.383009`
- Missed message local time: `2026-05-18 12:20:19 CDT`
- Slack client message id: `e17091ee-b547-42a9-8048-9335f34e6bc1`
- Mentioned Slack user id: `U0B0BS18D70`
- Intended agent: `soylei-website`

The missed message text in Slack Mirror was:

```text
<@U0B0BS18D70> can you please make sure that Apex is capitalized consistently and also includes the trademark symbol after the 1132? I noticed that is not the case in the title
```

## Evidence

Slack Mirror had the message and raw Slack payload:

```bash
slack-mirror-user messages permalink-resolve 'https://soyleiinnovations.slack.com/archives/C06L8DVBWQP/p1779124819383009?thread_ts=1779054888.591249&cid=C06L8DVBWQP' --json
slack-mirror-user messages thread --workspace soylei --channel C06L8DVBWQP --thread-ts 1779054888.591249 --selected-ts 1779124819.383009 --include-derived-text --include-ocr --json
```

The raw Slack Mirror row showed:

```json
{
  "ts": "1779124819.383009",
  "user": "U0127BGJ3U5",
  "text": "<@U0B0BS18D70> can you please make sure that Apex is capitalized consistently and also includes the trademark symbol after the 1132? I noticed that is not the case in the title",
  "thread_ts": "1779054888.591249",
  "client_msg_id": "e17091ee-b547-42a9-8048-9335f34e6bc1"
}
```

OpenClaw had no corresponding runtime record:

```bash
rg -n '1779124819|e17091ee-b547-42a9-8048-9335f34e6bc1|capitalized consistently|includes the trademark symbol' /tmp/openclaw ~/.openclaw --glob '!**/node_modules/**' --glob '!**/cache/**' --glob '!**/browser/**'
rg -n '1779124819|e17091ee|capitalized consistently|trademark symbol' ~/.openclaw/delivery-queue ~/.openclaw/wake-triggers ~/.openclaw/agents/soylei-website
```

Both searches returned no OpenClaw-owned hit for the missed message. The
`soylei-website` thread session also did not contain the missed message:

```bash
python3 - <<'PY'
from pathlib import Path
sess=Path('/home/ecochran76/.openclaw/agents/soylei-website/sessions/d6b599ec-1429-4c90-9b59-624dca569bca-topic-1779054888.591249.jsonl')
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

That matters because `1779124481.833079` was an immediately earlier direct
mention in the same thread. It did dispatch to `soylei-website`, completed a
model turn, and posted a reply. The later `1779124819.383009` message was not
admitted at all.

OpenClaw logs around the same window show a stale-socket restart before the
missed message:

```text
2026-05-18T17:16:29.392Z [slack:soylei] health-monitor: restarting (reason: stale-socket)
2026-05-18T17:16:29.480Z [soylei] starting provider
2026-05-18T17:16:29.932Z slack socket mode connected
2026-05-18T17:16:29.949Z slack channels resolved: ... C06L8DVBWQP->website ...
2026-05-18T17:16:29.950Z slack users resolved: U0127BGJ3U5, U012M8NDV3K, U012ETLV6NQ
```

Current health after the incident was green:

```text
Slack soylei (SoyLei Slack): enabled, configured, running, connected, in:14m ago, bot:config, app:config, health:healthy
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

- `docs/dev/notes/0017-2026-05-04-soylei-slack-socket-stale-ingress.md`
- `docs/dev/notes/0025-2026-05-09-slack-visible-reply-fallback-miss.md`
