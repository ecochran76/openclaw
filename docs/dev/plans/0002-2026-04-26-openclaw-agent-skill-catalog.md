# OpenClaw Agent Skill Catalog

State: OPEN
Created: 2026-04-26

## Current State

OpenClaw already has repo-local skills for maintainer workflows, QA, releases, security, Parallels smoke, test performance, and `ec-main` rebase/live-patch maintenance. Recent operator work shows repeated rediscovery in three areas that should be first-class Codex skills:

- gateway service operation and live runtime repair
- model auth profile diagnosis
- `ec-main` local feature preservation

## Scope

- Add concise repo-local skills under `.agents/skills/`.
- Keep each skill as an action-oriented `SKILL.md` that points to canonical repo policies and validation entrypoints.
- Favor progressive disclosure: link existing docs instead of copying large workflows.
- Validate skill files and plan docs with lightweight local checks.

## Non-Goals

- Do not add scripts unless a workflow needs deterministic automation.
- Do not replace `AGENTS.md`, repo policies, or `docs/dev/local-feature-index.md`.
- Do not migrate existing skills or restructure the full skill catalog in this slice.
- Do not live patch for docs-only / skill-only changes.

## Phases

1. Add `openclaw-gateway-operator` for service status, version skew, doctor findings, systemd repair, and gateway RPC verification.
2. Add `openclaw-auth-profile-debugger` for expired refresh tokens, profile selection, ChatGPT-vs-API model support, and `models auth` login flows.
3. Add `openclaw-feature-preservation` for local feature-family routing, focused validation, and rebase conflict preservation.
4. Review the next candidate batch: Slack runtime debugging, automation maintainer, plugin survivability, docs/notes/memory, and bundled plugin deps.

## Validation

- Confirm skill frontmatter includes clear `name` and `description`.
- Confirm skill bodies point to canonical policies and commands.
- Run focused file inspection after edits.
- Run `git diff --check`.

## Definition Of Done

- The first three skills exist under `.agents/skills/`.
- `ROADMAP.md` indexes this plan.
- `RUNBOOK.md` records the creation event.
- The handoff names the remaining second-batch skill candidates.
