# Slack Link Session Inspection Skill

State: CLOSED
Created: 2026-05-06

## Context

OpenClaw operators often start post-mortem analysis from a Slack permalink. The
existing CLI surfaces can inspect Slack channel history, why-silent state,
session stores, and trajectory sidecars, but agents had to rediscover the
correlation steps each time.

The missing operator workflow was:

1. Parse a Slack permalink into channel id, message timestamp, and optional
   thread timestamp.
2. Confirm Slack history can still see the message.
3. Determine whether OpenClaw ingested, ignored, or missed the event.
4. Find the associated session store entry and transcript/trajectory sidecars.
5. Report post-mortem evidence without dumping private transcript text by
   default.

## Action

Added `.agents/skills/openclaw-slack-session-inspector/` as a repo-local skill.
The skill includes a read-only fallback helper script:

```bash
python3 .agents/skills/openclaw-slack-session-inspector/scripts/slack_session_probe.py \
  "SLACK_PERMALINK" \
  --account soylei \
  --json
```

The helper parses the permalink, optionally runs `openclaw message read` and
`openclaw channels why-silent`, scans `~/.openclaw/agents/*/sessions`, and
reports matching session metadata and matching JSONL sidecars.

The workflow has now been promoted into the product CLI:

```bash
openclaw channels inspect-link <slack-permalink> --account <id> --agent <id> --json
```

The command uses the gateway channel read/status paths, including the upstream
Slack plugin `messageId`/`threadId` read contract rather than the older local
`around` helper path. It finds nearby human prompt candidates when the permalink
points at a bot progress message, scans session stores, and reports matching
transcript or trajectory sidecars without dumping raw transcript bodies.

After testing on a SoyLei `#website` thread where the permalink pointed to an
OpenClaw bot progress message rather than the human prompt, the helper was
expanded to report nearby human prompt candidates and to summarize trajectory
sidecars. A transcript match whose trajectory has `session.started` but no
`session.ended` is now visible as an incomplete run candidate.

## Privacy Default

The helper does not print raw transcript snippets unless `--snippets` is
explicitly supplied. Normal output reports parsed identifiers, likely session
metadata, and file paths for follow-up inspection.

## Follow-Up

The first-class command is intentionally read-only and metadata-first. Future
work should add deeper failure-signature extraction for Slack ack failures,
trajectory stalls, transcript repair churn, and tool-output post-processing
errors.
