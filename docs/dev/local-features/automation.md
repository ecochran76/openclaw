# Local Feature — Automation

## Summary

This local feature area adds bounded automation runs plus chat-visible automation control and status surfaces.

It exists as a maintained local layer because it changes both runtime tool behavior and the auto-reply command surface, which makes it easy to lose during rebases if it is not documented explicitly.

## Scope

- bounded automation tool execution
- automation registry and runner behavior
- automation stop conditions and status reporting
- automation defaults in config
- auto-reply commands and help/status surfaces for automation

## Why it exists

Automation landed locally as a coherent feature slice after the Slack turn-tracking work had already started reshaping command/status behavior.

That means rebases tend to conflict in two ways:

- the automation runtime itself collides with upstream tool/runtime evolution
- the automation chat surface collides with newer command-loader and status/help refactors

## Current status

- active local feature area
- validated after the `2026.3.23` forward-port onto current upstream
- should continue to land after Slack responsiveness slices during large rebases

## Conflict hotspots

Watch these areas during upgrades:

- `src/agents/tools/automation-tool.ts`
- `src/automation/*`
- `src/auto-reply/reply/commands-automation.ts`
- `src/auto-reply/reply/commands-automation-status.test.ts`
- `src/auto-reply/reply/commands-handlers.runtime.ts`
- `src/auto-reply/commands-registry.data.ts`
- `src/config/schema.base.generated.ts`
- `src/config/types.agent-defaults.ts`
- `src/config/zod-schema.agent-defaults.ts`

## Rebase guidance

When replaying automation work onto newer upstream:

- keep the newer runtime-loaded command registration shape instead of restoring older static command wiring
- let tracked-turn and status semantics settle first, then port automation command/status behavior on top
- if config schema changes are involved, regenerate or reconcile the generated schema files instead of hand-editing around drift
- run `pnpm build` before declaring the slice finished, because automation changes can interact with published/runtime output

## Validation runbook

Recommended focused checks:

```bash
pnpm test -- src/agents/openclaw-tools.automation.test.ts
pnpm test -- src/auto-reply/reply/commands-automation.test.ts
pnpm test -- src/auto-reply/reply/commands-automation-status.test.ts
pnpm test -- src/config/config.automation-defaults.test.ts
pnpm build
```

## User-visible failure symptoms

- automation tool calls disappear or stop honoring bounds
- automation status is missing or stale in chat surfaces
- automation commands stop registering after a rebase
- config defaults silently drift and automation behaves differently than expected

## Recovery notes

- compare against the last validated `ec-main` automation slice before assuming upstream replaced the behavior
- if command registration broke, inspect `src/auto-reply/reply/commands-handlers.runtime.ts` first rather than reviving older handler tables
- if schema drift appears, fix the generated/base-config surfaces before chasing downstream test fallout
