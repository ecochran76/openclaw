# Slack Pre-Rebase Preservation Baseline

State: OPEN
Created: 2026-05-06

## Context

Before rebasing `ec-main` onto current `origin/main`, preserve the local Slack
stability and A2A work that has accumulated on the downstream branch. Upstream
now has substantial overlapping Slack/plugin work, including bundled Slack
plugin changes, channel message lifecycle work, exact Slack reads, rich progress
drafts, startup allowlist gating, and socket diagnostics.

The rebase should not mechanically drop local behavior just because upstream
has newer code in the same files.

## Branch Baseline

- Current branch: `ec-main`
- Backup branch: `backup/ec-main-pre-rebase-2026-05-06-025d7eb`
- Backup commit: `025d7eb70b`
- Current upstream head inspected: `origin/main` at `1f822d7c22`

## Cleanup Before Rebase

Removed stray untracked files created by an accidental OpenClaw agent run:

- `.openclaw/`
- `HEARTBEAT.md`
- `SOUL.md`
- `TOOLS.md`

Updated the local A2A gate because it referenced a stale gateway test path:

- old: `src/gateway/server.sessions.gateway-server-sessions-a.test.ts`
- current: `src/gateway/server.sessions-send.test.ts`

## Preservation Baseline

Slack responsiveness gate passed before rebase:

```bash
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
```

Result:

- 2 Vitest shards passed
- 3 test files passed
- 113 tests passed

Slack A2A gate passed after replacing the stale gateway test path:

```bash
scripts/ec-main-rebase-gate.sh --family slack-a2a
```

Result:

- 6 Vitest shards passed
- 8 test files passed
- 155 tests passed

## Behaviors To Preserve

Treat these as preservation requirements during the rebase unless upstream has
clearly equivalent or better behavior on the new plugin/message-lifecycle seams:

- early Slack ack/hourglass behavior
- progress timeline and startup phase visibility
- typing/reaction cleanup timing
- hot-path Slack metadata avoidance
- stale Slack socket ingress diagnostics
- Slack runtime mirror hardening
- visible text command replies
- `/turn-status`
- `/turns`
- `/nudge`
- `/turn-steer`
- `/why-silent`
- delivery attribution and stranded reply detection
- stalled-turn watcher notices
- A2A ingress echo and relay delivery behavior
- A2A Slack approval rendering and explicit retry flow
- `openclaw channels inspect-link`

## Rebase Guidance

- Prefer upstream's newer Slack plugin/message-lifecycle architecture where it
  provides the same behavior.
- Do not reintroduce older inline Slack behavior when upstream now has a plugin
  seam or generic channel lifecycle seam that can carry the local behavior.
- Keep Slack-specific rendering and interaction logic in `extensions/slack`.
- Keep generic turn/session/delivery invariants in core.
- Re-run both Slack gates after conflict resolution.
- Run a live Slack smoke before live patching.

## Best Next Step

Start the controlled rebase using this note as the preservation checklist.
