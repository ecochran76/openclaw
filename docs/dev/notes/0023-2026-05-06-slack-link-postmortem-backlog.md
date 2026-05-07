# Slack Link Postmortem Backlog

State: OPEN
Created: 2026-05-06

## Context

While testing the new Slack link session inspector against this SoyLei `#website`
thread:

```text
https://soyleiinnovations.slack.com/archives/C06L8DVBWQP/p1778010362706599?thread_ts=1778010362.706599&cid=C06L8DVBWQP
```

we found several distinct Slack/OpenClaw failure signatures that should be
investigated after the link inspector skill is polished.

## Findings To Preserve

### Bot progress link vs original prompt

The linked message `1778010362.706599` was the OpenClaw bot's `Working...`
thread-root/progress message. The original human prompt was the immediately
preceding Slack message `1778010360.683399`.

The inspector must avoid treating the linked bot message as the only root cause
anchor. It should report both:

- the linked bot/thread message.
- nearby human prompt candidates.

### Top-level original run stalled

The original prompt was ingested into the top-level `soylei-website` Slack
channel session:

```text
agent:soylei-website:slack:channel:c06l8dvbwqp
```

The trajectory sidecar for that run had only:

- `session.started`
- `trace.metadata`
- `context.compiled`
- `prompt.submitted`

It did not have:

- `model.completed`
- `trace.artifacts`
- `session.ended`

That should be reported as a stalled/incomplete trajectory, not as successful
execution.

### Thread session became recovery/context session

The thread session:

```text
agent:soylei-website:slack:channel:c06l8dvbwqp:thread:1778010362.706599
```

started later after follow-up messages and recorded multiple successful model
runs. It should not be conflated with the original stalled top-level prompt.

### Slack pre-pipeline ack failures

Gateway logs repeatedly showed:

```text
slack pre-pipeline ack failed
error="An API error occurred: invalid_name"
```

for the affected SoyLei `#website` messages, including the original prompt and
later thread messages. This did not always block ingestion, but it is a Slack
progress/ack reliability issue that should be explained or fixed.

### Transcript repair churn

The thread session repeatedly logged:

```text
session file repaired: trimmed 1 trailing assistant message(s)
```

and once:

```text
session file repaired: rewrote 1 assistant message(s), trimmed 1 trailing assistant message(s)
```

This suggests incomplete or invalid assistant tail entries during Slack/thread
runs and should be investigated as a session-store hygiene problem.

### Tool/process post-processing errors

The affected sessions contained repeated tool results like:

```text
Tool output unavailable due to post-processing error.
```

with `details.status="error"` and `middlewareError=true`, especially around
`exec` and `process` results. Some long-running process polls were involved.
The inspector should surface this as a runtime/tool-output failure signature
without requiring manual transcript spelunking.

### Provider/runtime errors in same thread family

Later messages in the same thread family showed runtime errors including:

- `LLM request failed: network connection error.`
- `507 Insufficient Storage: exceeded request buffer limit while retrying upstream`

These may be separate from the original stalled run, but they are part of the
same operator-visible “OpenClaw on Slack is flaky” experience.

## Follow-Up After Inspector Polish

1. Done: promote the skill helper behavior into first-class
   `openclaw channels inspect-link <slack-permalink>`.
2. Partially done: report trajectories with `session.started` but no
   `session.ended` when a matching trajectory sidecar is found.
3. Add explicit diagnosis for Slack pre-pipeline ack `invalid_name`.
4. Add explicit diagnosis for repeated transcript repair on the same session.
5. Add explicit diagnosis for `middlewareError=true` tool/process output loss.
6. Decide whether `/why-silent`, `/turn-status`, or a new postmortem command
   should connect these layers automatically for Slack operators.
