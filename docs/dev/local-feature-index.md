# Local Feature Index

This index tracks **repo-local deltas on `ec-main`** that matter for rebases, live upgrades, and future agent work.

Read this before doing branch surgery, release integration, or automation changes that touch `ec-main`.

Related compatibility plan:

- `docs/dev/upstream-compat-refactor-plan.md`
- `docs/dev/upstream-compat-feature-preservation-plan.md`
- `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md`

## Why this exists

OpenClaw upstream moves quickly. Local changes become expensive when they are only preserved in branch names, chat history, or human memory.

This file is the durable map for:

- what local features exist
- why they exist
- where they are documented
- how to validate them after rebase/upgrade
- where they tend to conflict with upstream

## Rules of use

- Treat `ec-main` as the **only deployable integration branch**.
- Do not assume a long-lived feature branch is still the source of truth once a deployable slice has landed in `ec-main`.
- When a rebase repeatedly hurts, update the relevant feature doc with conflict hotspots and recovery notes.
- Before unattended upgrade work, confirm automation targets `ec-main` only.

## Gate Wrapper

Use `scripts/ec-main-rebase-gate.sh` for repeatable focused validation after rebases or local feature repairs:

```bash
scripts/ec-main-rebase-gate.sh --family profiles
scripts/ec-main-rebase-gate.sh --family slack-a2a
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
scripts/ec-main-rebase-gate.sh --family automation
scripts/ec-main-rebase-gate.sh --family voice
scripts/ec-main-rebase-gate.sh --family all --check --build
```

Use `--list` to print the command bundle without running it. Use `--live-patch` only after the tree is clean, committed, pushed, and the normal validation gates have passed.

## Local feature map

### 1. Profiles

- Doc: `docs/dev/local-features/profiles.md`
- Design docs:
  - `docs/dev/codex-status-profile-quota-plan.md`
  - `docs/dev/profile-usage-alerts-auto-switch-plan.md`
- Scope:
  - auth profiles
  - profile-aware routing / selection
  - auth profile normalization and usage reporting
  - profile-aware usage alerts / stop gates / auto-switch policy
  - profile-oriented UI and CLI behaviors
- Common validation:
  - `pnpm test -- src/commands/models/auth.test.ts`
  - `pnpm test -- src/commands/models/auth.login-profiles.test.ts`
  - `pnpm test -- src/cli/models-cli.test.ts`

### 2. Slack / A2A

- Doc: `docs/dev/local-features/slack-a2a.md`
- Plan: `docs/dev/a2a-slack-interactive-approval-plan.md`
- Scope:
  - `sessions_send` A2A behavior
  - ingress echo
  - nested relay guard
  - selector targeting / thread-aware targeting
  - relay delivery contract / dual-channel relay behavior
  - Slack interactive approval flow for A2A permission misses
- Current status:
  - structured permission-request and pending-approval slices landed on `ec-main`
  - Slack thread approve/deny flow now patches config narrowly and requires an explicit retry
- Common validation:
  - `pnpm test -- src/agents/openclaw-tools.sessions.test.ts`
  - `pnpm test -- src/agents/a2a/permission-approval-action.test.ts`
  - `pnpm test -- src/agents/pi-embedded-subscribe.handlers.tools.test.ts`
  - `pnpm test -- src/auto-reply/reply/dispatch-stream-delivery.test.ts`
  - `pnpm test -- extensions/slack/src/monitor/events/interactions.test.ts`
  - `pnpm test -- src/gateway/server.sessions-send.test.ts`

### 3. Slack / agent responsiveness

- Doc: `docs/dev/local-features/slack-agent-responsiveness.md`
- Design doc: `docs/dev/slack-turn-visibility-and-steering.md`
- Stale-socket reconciliation plan: `docs/dev/plans/0007-2026-05-18-slack-stale-socket-watchdog.md`
- Slack connector overhaul plan: `docs/dev/plans/0008-2026-05-30-slack-connector-overhaul.md`
- Slack health diagnostics remediation plan: `docs/dev/plans/0009-2026-05-30-slack-health-diagnostics-remediation.md`
- Slack active reconciliation plan: `docs/dev/plans/0010-2026-05-30-slack-history-reconciliation-receiver.md`
- Slack Socket Mode hardening plan: `docs/dev/plans/0011-2026-05-30-slack-socket-mode-hardening.md`
- Scope:
  - long-turn visibility
  - progress signaling
  - deterministic turn watchers
  - steering/status tooling
  - delivery attribution
  - stale-socket admission-gap detection and guarded recovery planning
  - Socket Mode receiver hardening
  - active Slack history reconciliation
- Current status:
  - Slice 1 landed on `ec-main` (`498f59a1c`)
  - Slice 2 landed on `ec-main` as a commit series (`05571e149`, `987865f7c`, `5f9754034`, `f8523c896`, `1f104770f`)
  - Slice 3 is in progress on `ec-main` (`3d925d0cc`, `8de818625`, `cdf6f5aee`, `d81df866f`)
  - Slice 3 plan documented in `docs/dev/slack-turn-slice-3-steering-and-watchers-plan.md`
  - Pre-live-test polish checklist documented in `docs/dev/slack-turn-live-testing-polish-plan.md`
  - Stale-socket watchdog roadmap documented in `docs/dev/plans/0007-2026-05-18-slack-stale-socket-watchdog.md`
  - Slack Socket Mode hardening is tracked as roadmap milestone P04 in `ROADMAP.md`
  - Slack active reconciliation is tracked as roadmap milestone P05 in `ROADMAP.md`
- Common validation:
  - `pnpm test -- src/auto-reply/reply/dispatch-from-config.test.ts`
  - `pnpm test -- src/auto-reply/reply/commands-turn-status.test.ts`
  - `pnpm test -- src/auto-reply/turn-tracker.test.ts`

### 4. Automation

- Doc: `docs/dev/local-features/automation.md`
- Scope:
  - bounded automation tool execution
  - automation chat/status surface
  - automation command wiring in auto-reply flows
- Current status:
  - landed on `ec-main` as a coherent series during the `2026.3.23` forward-port
  - Phase 3 plugin-survivability seams landed across Turns 8-10 on `2026-04-21`
  - command parsing/help/status text, progress reporting, worker result mapping, and worker job construction now live in automation-owned helpers
  - bounds, turn accounting, and session lifecycle remain core invariants
- Common validation:
  - `pnpm test -- src/automation/command-surface.test.ts`
  - `pnpm test -- src/automation/worker-job.test.ts`
  - `pnpm test -- src/automation/worker-result.test.ts`
  - `pnpm test -- src/automation/progress-reporting.test.ts`
  - `pnpm test -- src/automation/runner.test.ts`
  - `pnpm test -- src/automation/status.test.ts`
  - `pnpm test -- src/agents/tools/automation-tool.test.ts`
  - `pnpm test -- src/auto-reply/reply/commands-automation.test.ts`
  - `pnpm test -- src/auto-reply/reply/commands-automation-status.test.ts`
  - `pnpm test -- src/automation/config.test.ts`
  - `pnpm build`
- Rebase note:
  - keep automation command/status UX changes in automation-owned helpers when possible; avoid reintroducing command parsing or worker protocol text into upstream-hot auto-reply/tool orchestration files.

### 5. Upgrade / branch discipline

- Doc: `docs/dev/local-features/upgrade-branch-discipline.md`
- Related playbook: `docs/dev/rebase-friendly-branching-playbook.md`
- Scope:
  - `ec-main` branch discipline
  - unattended upgrades target `ec-main` only
  - feature-branch sync must not block live deploys
  - cherry-pick deployable slices early; keep branches narrow

### 6. Voice / telephony

- Doc: `docs/dev/local-features/voice-telephony.md`
- Design doc: `docs/dev/slack-huddle-telephony-plan.md`
- Scope:
  - `voice-call` streaming STT seams
  - telephony TTS / media-stream integration
  - shared `tools.media.audio` autodetect that voice-call inherits
  - local GPU transcription readiness that affects telephony backend choice
- Common validation:
  - `pnpm test -- extensions/voice-call/index.test.ts`
  - `pnpm test -- extensions/voice-call/src/config.test.ts`
  - `pnpm test -- extensions/voice-call/src/config-compat.test.ts`
  - `pnpm test -- extensions/voice-call/src/media-stream.test.ts`
  - `pnpm test -- extensions/voice-call/src/webhook.test.ts`
  - `pnpm test -- extensions/voice-call/src/providers/stt-provider-config.test.ts`
  - `pnpm test -- extensions/voice-call/src/providers/stt-openai-realtime.test.ts`
  - `pnpm test -- extensions/voice-call/src/providers/stt-buffered-media-transcriber.test.ts`
  - `pnpm test -- extensions/voice-call/src/providers/stt-buffered-media.test.ts`
  - `pnpm test -- extensions/voice-call/src/providers/stt-factory.test.ts`
  - `pnpm test -- src/media-understanding/apply.test.ts`
  - `pnpm build`

## Current repair plan (2026-04-21)

Active roadmap completion order:

1. keep the focused validation lists current after seam moves in profiles, Slack/A2A, Slack responsiveness, automation, and voice/telephony,
2. use `scripts/ec-main-rebase-gate.sh` for local feature-family validation during rebase repair,
3. consolidate the rebase/live-patch gate around feature-family validation plus `pnpm check` / `pnpm build` when touched surfaces require it,
4. only then run broad landing gates or live-patch flows.

This order is intentional. The goal is to avoid rediscovering local feature preservation requirements during every upstream rebase while still keeping the normal local loop narrower than a full release gate.

## Recent lessons worth remembering

### Rebase lesson

A branch can look “repaired” while still not actually sitting on the intended upstream tag lineage. Verify with ancestry math, not vibes.

Useful check:

```bash
git rev-list --left-right --count v2026.3.13...ec-main
```

Desired shape after a clean rebase onto the tag:

- left side: `0`
- right side: local ahead count

### Upgrade lesson

If unattended upgrade automation reaches `patch-live-openclaw.sh`, the remaining blockers are likely real build/test/install problems rather than branch plumbing.

### External plugin live-patch lesson

When upstream moves a runtime into an external plugin, live patching only the core OpenClaw package can produce a mixed-generation install. After the 2026-05-16 Codex plugin rebase, core was current but the installed Slack plugin was stale, so progress indicators stayed broken until `extensions/slack` was built, packed, installed, the plugin registry refreshed, and the gateway restarted.

Useful checks:

```bash
openclaw plugins inspect slack --runtime --json
rg -n "slack turn live trace|starting agent turn|agent turn completed" ~/.openclaw/extensions/slack -g '*.js'
```

For live patching after an external plugin boundary changes, include the plugin-aware patch step:

```bash
scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch --patch-external-plugins
```

## When to update this file

Update this index when:

- a new local feature lands on `ec-main`
- a feature doc is created or renamed
- a validation entry point changes
- an upgrade/rebase lesson becomes durable enough to document
