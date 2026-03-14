# Local Feature Index

This index tracks **repo-local deltas on `ec-main`** that matter for rebases, live upgrades, and future agent work.

Read this before doing branch surgery, release integration, or automation changes that touch `ec-main`.

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
- Scope:
  - auth profiles
  - profile-aware routing / selection
  - auth profile normalization and usage reporting
  - profile-oriented UI and CLI behaviors
- Common validation:
  - `pnpm test -- src/commands/models/auth.test.ts`
  - `pnpm test -- src/commands/models/auth.login-profiles.test.ts`
  - `pnpm test -- src/cli/models-cli.test.ts`

### 2. Slack / A2A

- Doc: `docs/dev/local-features/slack-a2a.md`
- Scope:
  - `sessions_send` A2A behavior
  - ingress echo
  - nested relay guard
  - selector targeting / thread-aware targeting
  - relay delivery contract / dual-channel relay behavior
- Common validation:
  - `pnpm test -- src/agents/openclaw-tools.sessions.test.ts`
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
  - Slice 2 delivery-attribution plan documented in `docs/dev/slack-turn-slice-2-delivery-attribution-plan.md`

### 4. Upgrade / branch discipline

- Doc: `docs/dev/local-features/upgrade-branch-discipline.md`
- Related playbook: `docs/dev/rebase-friendly-branching-playbook.md`
- Scope:
  - `ec-main` branch discipline
  - unattended upgrades target `ec-main` only
  - feature-branch sync must not block live deploys
  - cherry-pick deployable slices early; keep branches narrow

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
