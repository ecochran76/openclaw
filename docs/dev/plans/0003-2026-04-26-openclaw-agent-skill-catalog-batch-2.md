# OpenClaw Agent Skill Catalog Batch 2

State: OPEN
Created: 2026-04-26

## Current State

The first OpenClaw-specific Codex skill batch added gateway operation, auth profile debugging, and local feature preservation. The next recurring operator problems are automation behavior, Slack runtime diagnostics, agent bootstrap identity failures, and plugin survivability decisions.

## Scope

- Add four concise repo-local skills under `.agents/skills/`.
- Install the skills into Codex user scope after validation.
- Keep each skill procedural and linked to canonical repo docs.
- Update `ROADMAP.md` and `RUNBOOK.md` so the catalog remains discoverable.

## Non-Goals

- Do not implement product behavior changes in this batch.
- Do not add scripts unless the workflow is fragile enough to need deterministic automation.
- Do not migrate parked notes or unrelated plans.
- Do not live patch for docs-only / skill-only changes.

## Phases

1. Add `openclaw-automation-maintainer` for `/automation` syntax, bounds, status, progress, steering, and one-turn-stop diagnosis.
2. Add `openclaw-slack-runtime-debugger` for Slack delivery, typing indicators, thread behavior, A2A approvals, and responsiveness tools.
3. Add `openclaw-agent-bootstrap-debugger` for bootstrap loops, identity loss, skill visibility, memory files, and bootstrap-size warnings.
4. Add `openclaw-plugin-survivability` for plugin-vs-core decisions, SDK seams, bundled plugin boundaries, and local feature migration.

## Validation

- Confirm each skill has clear `name` and `description` frontmatter.
- Confirm each skill body names read-first docs and bounded commands.
- Run `git diff --check`.
- Verify user-scope skill install resolves to the repo-local source.

## Definition Of Done

- The four batch-2 skills exist under `.agents/skills/`.
- The four skills are installed under `~/.codex/skills/`.
- `ROADMAP.md` and `RUNBOOK.md` reference this batch.
- The handoff names remaining candidate skills for a future batch.
