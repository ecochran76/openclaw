# Local Feature — Automation

## Summary

This local feature area adds bounded automation runs plus chat-visible automation control and status surfaces.

It exists as a maintained local layer because it changes both runtime tool behavior and the auto-reply command surface, which makes it easy to lose during rebases if it is not documented explicitly.

## Scope

- bounded automation tool execution
- automation registry and runner behavior
- automation stop conditions and status reporting
- per-turn progress announcements for announced automation runs
- automation defaults in config
- auto-reply commands and help/status surfaces for automation

## Why it exists

Automation landed locally as a coherent feature slice after the Slack turn-tracking work had already started reshaping command/status behavior.

That means rebases tend to conflict in two ways:

- the automation runtime itself collides with upstream tool/runtime evolution
- the automation chat surface collides with newer command-loader and status/help refactors
- command parsing and user-facing automation text should live in shared auto-reply helpers, not in the tool/runtime layer
- preservation/rebase strategy is tracked in `docs/dev/upstream-compat-feature-preservation-plan.md`

## Current status

- active local feature area
- validated after the `2026.3.23` forward-port onto current upstream
- Phase 3 plugin-survivability seams landed across Turns 8-10 on `2026-04-21`
- command parsing/help/status text, progress reporting, worker result mapping, and worker job construction now live in automation-owned helpers
- bounds, turn accounting, and session lifecycle remain core invariants

## Conflict hotspots

Watch these areas during upgrades:

- `src/agents/tools/automation-tool.ts`
- `src/automation/*`
- `src/auto-reply/reply/commands-automation.ts`
- `src/auto-reply/reply/commands-automation-shared.ts`
- `src/auto-reply/reply/commands-automation-status.test.ts`

## Rebase guidance

When replaying automation work onto newer upstream:

- keep the newer runtime-loaded command registration shape instead of restoring older static command wiring
- keep automation command parsing/help/status text in `src/automation/command-surface.ts`
- keep worker prompt/job construction in `src/automation/worker-job.ts`
- keep worker result mapping in `src/automation/worker-result.ts`
- keep progress/final-summary selection in `src/automation/progress-reporting.ts`
- run `pnpm build` before declaring the slice finished, because automation changes can interact with published/runtime output

## Validation runbook

Recommended focused checks:

```bash
pnpm test -- src/automation/command-surface.test.ts
pnpm test -- src/automation/worker-job.test.ts
pnpm test -- src/automation/worker-result.test.ts
pnpm test -- src/automation/progress-reporting.test.ts
pnpm test -- src/automation/runner.test.ts
pnpm test -- src/automation/status.test.ts
pnpm test -- src/agents/tools/automation-tool.test.ts
pnpm test -- src/auto-reply/reply/commands-automation.test.ts
pnpm test -- src/auto-reply/reply/commands-automation-status.test.ts
pnpm test -- src/automation/config.test.ts
pnpm build
```

## User-visible failure symptoms

- automation tool calls disappear or stop honoring bounds
- automation status is missing or stale in chat surfaces
- automation only reports at start/finish and stops emitting turn-by-turn progress
- automation commands stop registering after a rebase
- config defaults silently drift and automation behaves differently than expected

## Recovery notes

- compare against the last validated `ec-main` automation slice before assuming upstream replaced the behavior
- if command registration broke, inspect `src/auto-reply/reply/commands-automation.ts` and `src/automation/command-surface.ts` before reviving older handler tables
- if worker turn behavior regresses, inspect `src/automation/worker-result.ts`, `src/automation/worker-job.ts`, and `src/automation/progress-reporting.ts` before editing the generic tool orchestration
