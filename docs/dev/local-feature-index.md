# Local Feature Index

This index tracks **repo-local deltas on `ec-main`** that matter for rebases, live upgrades, and future agent work.

Read this before doing branch surgery, release integration, or automation changes that touch `ec-main`.

Related compatibility plan:

- `docs/dev/upstream-compat-refactor-plan.md`
- `docs/dev/upstream-compat-feature-preservation-plan.md`
- `docs/dev/plugin-survivability-roadmap.md`

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
  - `pnpm test -- src/gateway/server.sessions.gateway-server-sessions-a.test.ts`

### 3. Slack / agent responsiveness

- Doc: `docs/dev/local-features/slack-agent-responsiveness.md`
- Design doc: `docs/dev/slack-turn-visibility-and-steering.md`
- Scope:
  - long-turn visibility
  - progress signaling
  - deterministic turn watchers
  - steering/status tooling
  - delivery attribution
- Current status:
  - Slice 1 landed on `ec-main` (`498f59a1c`)
  - Slice 2 landed on `ec-main` as a commit series (`05571e149`, `987865f7c`, `5f9754034`, `f8523c896`, `1f104770f`)
  - Slice 3 is in progress on `ec-main` (`3d925d0cc`, `8de818625`, `cdf6f5aee`, `d81df866f`)
  - Slice 3 plan documented in `docs/dev/slack-turn-slice-3-steering-and-watchers-plan.md`
  - Pre-live-test polish checklist documented in `docs/dev/slack-turn-live-testing-polish-plan.md`
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
  - depends on the newer runtime-loaded command registration shape
  - should be replayed after Slack responsiveness work during large rebases
- Common validation:
  - `pnpm test -- src/agents/openclaw-tools.automation.test.ts`
  - `pnpm test -- src/auto-reply/reply/commands-automation.test.ts`
  - `pnpm test -- src/auto-reply/reply/commands-automation-status.test.ts`
  - `pnpm test -- src/config/config.automation-defaults.test.ts`
  - `pnpm build`
- Rebase note:
  - keep automation commits grouped after Slack responsiveness commits when finishing a large `ec-main` rebase so tracked-turn changes settle before automation command/status wiring lands.

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
  - `pnpm test -- extensions/voice-call/src/media-stream.test.ts`
  - `pnpm test -- extensions/voice-call/src/webhook.test.ts`
  - `pnpm test -- extensions/voice-call/src/providers/stt-openai-realtime.test.ts`
  - `pnpm test -- extensions/voice-call/src/providers/stt-buffered-media.test.ts`
  - `pnpm test -- extensions/voice-call/src/providers/stt-factory.test.ts`
  - `pnpm test -- src/media-understanding/apply.test.ts`
  - `pnpm build`

## Current repair plan (2026-03-21)

Active rebase completion order:

1. finish the current conflict and any remaining **Slack responsiveness** commits as one coherent tracked-turn series,
2. finish the remaining **automation** commits,
3. run focused validation by local feature area,
4. only then update/trim feature branches or promotion targets.

This order is intentional. The remaining queue is not random churn; it is mostly a Slack responsiveness series followed by automation. Treating it as a coherent plan avoids semantic drift while resolving conflicts.

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

## When to update this file

Update this index when:

- a new local feature lands on `ec-main`
- a feature doc is created or renamed
- a validation entry point changes
- an upgrade/rebase lesson becomes durable enough to document
