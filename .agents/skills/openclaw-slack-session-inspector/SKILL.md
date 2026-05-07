---
name: openclaw-slack-session-inspector
description: Given a Slack permalink, inspect associated OpenClaw channel history, why-silent state, session store entries, transcript files, and trajectory sidecars for post-mortem analysis or context ingestion.
---

# OpenClaw Slack Session Inspector

Use this skill when the user provides a Slack link and wants to understand what
OpenClaw session, transcript, task, or runtime logs are associated with that
message or thread.

## Inputs

Ask for missing pieces only when they cannot be inferred:

- Slack permalink, for example `https://workspace.slack.com/archives/C123/p1778009972917279`
- Slack account id when the tenant is ambiguous, for example `default` or `soylei`
- Whether raw transcript snippets are allowed. Default: do not print raw message
  bodies; report metadata, file paths, and short redacted previews only.

## Fast Path

Prefer the first-class OpenClaw CLI command when it is available:

```bash
openclaw channels inspect-link "SLACK_PERMALINK" \
  --account soylei \
  --agent soylei-website \
  --json
```

Useful options:

```bash
--agent <id>   # limit session-store scan to one agent
--limit <n>    # Slack messages to read around the permalink
--json         # machine-readable report for post-mortem notes
```

If the installed OpenClaw build does not have `channels inspect-link` yet, run
the bundled read-only probe:

```bash
python3 .agents/skills/openclaw-slack-session-inspector/scripts/slack_session_probe.py \
  "SLACK_PERMALINK" \
  --account soylei \
  --json
```

Useful options:

```bash
--agent <id>          # limit session-store scan to one agent
--agents-root <path>  # default: ~/.openclaw/agents
--no-cli              # skip live OpenClaw CLI probes; only parse and scan disk
--snippets            # include short redacted matching transcript lines
```

The probe parses the Slack URL, derives the channel id and message timestamp,
checks Slack history through `openclaw message read`, runs
`openclaw channels why-silent`, scans `sessions.json` files, and looks for
matching transcript or trajectory sidecars. When the permalink points to an
OpenClaw bot progress/thread-root message, it also reports nearby human prompt
candidates so the root request is not missed.

## Manual Workflow

If the helper is unavailable or more detail is needed:

1. Parse the permalink:
   - channel id: `/archives/<CHANNEL>/`
   - message ts: `p1778009972917279` -> `1778009972.917279`
   - thread ts: `thread_ts=` query param when present, otherwise use message ts
     for thread-root investigations.
2. Confirm channel visibility:

```bash
openclaw message read --channel slack --account <account> \
  --target channel:<CHANNEL> --around <MESSAGE_TS> --limit 10 --json
```

3. Check whether OpenClaw ingested or intentionally ignored it:

```bash
openclaw channels why-silent --channel slack --account <account> \
  --target channel:<CHANNEL> --limit 10 --json
```

4. Correlate session store entries:

```bash
openclaw sessions --all-agents --json
```

Look for entries where `deliveryContext.channel == "slack"`,
`deliveryContext.to == "channel:<CHANNEL>"`, `lastAccountId` matches the
account, or `lastThreadId` / session key matches the thread timestamp.

5. Inspect transcript/trajectory sidecars only after choosing the likely
   session:
   - transcript: `<agent>/sessions/<session-id>[-topic-<thread-ts>].jsonl`
   - trajectory: matching `.trajectory.jsonl`
   - pointer: matching `.trajectory-path.json`
6. Treat a trajectory with `session.started` but no `session.ended` as a strong
   stalled-turn signal even if Slack contains later progress or thread replies.

Prefer metadata and event types over raw prompt text unless the user explicitly
asks for content ingestion.

## Interpretation

- Slack history contains the message, but no transcript/session match: likely
  Socket Mode ingress loss, account routing issue, or startup/reconnect window.
- Transcript contains the user message, but no assistant/final event: inspect
  trajectory and gateway logs for model/auth/tool/runtime failure.
- Thread permalink maps to a top-level channel session only: check whether the
  message was treated as channel-root, thread-bound, or thread-participation
  suppressed.
- Bot progress/thread-root permalink has a nearby human prompt: inspect both
  the bot/thread session and the preceding prompt's top-level session.
- Trajectory missing `session.ended`: the run likely stalled or crashed before
  clean finalization; inspect tool/process middleware and provider errors.
- Multiple session matches: prefer exact `threadId`, exact transcript line
  match, then nearest `updatedAt` after the Slack timestamp.

## Log Checks

Use bounded logs, filtered by channel id, timestamp, account, and agent:

```bash
journalctl --user -u openclaw-gateway.service --since "30 minutes ago" --no-pager |
  rg -i "<CHANNEL>|<MESSAGE_TS>|slack inbound|why-silent|drop|agent|session"
```

For local file logs:

```bash
ls -t /tmp/openclaw/openclaw-*.log | head -3
```

Then inspect only the relevant time window.

## Closeout

Report:

- parsed channel id, message ts, thread ts, and account
- whether Slack history sees the message
- likely OpenClaw agent/session key/session file
- transcript and trajectory evidence, if found
- whether the failure is ingress, routing, model/tool execution, or delivery
- residual uncertainty and the best next step
