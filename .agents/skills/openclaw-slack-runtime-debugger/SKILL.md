---
name: openclaw-slack-runtime-debugger
description: Debug OpenClaw Slack runtime behavior, including threaded delivery, typing indicators, message re-rendering, A2A approval prompts, /status and /why-silent flows, turn visibility, delivery attribution, Socket Mode/HTTP setup, and Slack responsiveness regressions.
---

# OpenClaw Slack Runtime Debugger

Use this skill when Slack behavior is the visible failure surface.

## Read First

- `docs/channels/slack.md`
- `docs/concepts/streaming.md`
- `docs/dev/local-features/slack-a2a.md` for A2A and approval behavior
- `docs/dev/local-features/slack-agent-responsiveness.md` for turn visibility and steering
- `docs/dev/local-feature-index.md`
- `docs/dev/policies/validation-and-handoff.md`

## Triage Order

1. Classify the Slack symptom:
   - no reply
   - delayed final reply
   - duplicate or re-rendering threaded message
   - top-level vs thread typing indicator mismatch
   - A2A approval prompt missing or wrong
   - `/status`, `/why-silent`, `/turn-status`, `/turns`, `/turn-steer` mismatch
2. Capture surface details:
   - channel vs DM
   - top-level vs thread
   - Socket Mode vs HTTP
   - agent id and session key when available
   - relevant Slack timestamp/thread timestamp
3. Check gateway/channel health before editing code:
   - `openclaw gateway status --deep --require-rpc`
   - `openclaw doctor`
   - bounded gateway logs
4. Decide whether the bug belongs to Slack plugin rendering, core session/routing, or turn lifecycle attribution.

## Source Hotspots

- `extensions/slack/src/monitor/events/interactions.test.ts`
- `extensions/slack/src/interactive-replies.ts`
- `src/auto-reply/reply/dispatch-stream-delivery.test.ts`
- `src/auto-reply/reply/commands-turn-status.test.ts`
- `src/auto-reply/reply/commands-automation-status.test.ts`
- `src/auto-reply/turn-tracker.test.ts`
- `src/agents/a2a/permission-approval-action.test.ts`
- `src/gateway/server.sessions.gateway-server-sessions-a.test.ts`

## Boundary Rules

- Slack-specific button/block rendering belongs in the Slack plugin.
- Core A2A payloads should stay channel-neutral and expose metadata for plugins to render.
- External messaging surfaces should not emit raw token deltas; follow `docs/concepts/streaming.md`.
- Treat Slack UI re-render behavior cautiously: distinguish Slack client behavior from OpenClaw repeated edits.

## Validation

For A2A approval or relay changes:

```bash
scripts/ec-main-rebase-gate.sh --family slack-a2a
```

For turn visibility, silence, or steering changes:

```bash
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
```

If both are touched, run both or use:

```bash
scripts/ec-main-rebase-gate.sh --family all --list
```

then select the relevant focused commands.

## Closeout Evidence

Report:

- Slack surface and symptom
- likely ownership: Slack plugin, core session/A2A, or turn lifecycle
- validation commands and results
- any residual Slack/client-side caveat
- best next step
