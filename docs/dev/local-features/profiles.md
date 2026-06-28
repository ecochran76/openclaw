# Local Feature — Profiles

## Summary

Profiles are a local feature cluster covering auth-profile-aware behavior across CLI, runtime routing, and UI surfaces.

This work exists because losing profile behaviors during rebases or live patch installs creates immediate user-facing regressions.

## Scope

- auth profile normalization
- explicit profile-id handling
- profile-aware login and usage behaviors
- profile-related UI support
- profile-aware command routing / selection

## Why it exists

Profile work landed across multiple slices and briefly drifted off `ec-main`, which caused live installs to lose `/profile` and `/profiles` behavior until the missing work was merged back.

That makes this a feature family worth tracking explicitly.

## Current status

- active local feature area
- upstream now owns the native auth-profile base layer
- local work should be reduced to thin operator UX/policy over upstream APIs
- must be revalidated after rebase/upgrade work
- active retirement plan:
  - `docs/dev/plans/0014-2026-06-28-profile-support-retirement.md`
- current design docs:
  - `docs/dev/codex-status-profile-quota-plan.md`
  - `docs/dev/profile-usage-alerts-auto-switch-plan.md`

## Known implementation notes

- upstream OpenClaw owns per-agent SQLite auth profile storage, CLI auth commands, ordering, cooldown, and doctor migration
- `ec-main` should not retain a parallel profile storage or migration implementation
- legacy `auth-profiles.json` and OAuth sidecar handling belongs to `openclaw doctor --fix` / import code, not runtime fallback readers
- retained local profile behavior should be limited to operator UX such as `/profile`, `/profiles`, and policy/status surfaces not provided upstream
- explicit `openai-codex` profile ids/labels needed normalization support
- profile behaviors have both CLI and runtime surfaces
- dashboard/agents UI has had profile-related drift during feature-branch work
- session auth/usage presentation should be layered through shared helpers rather than rebuilt inside individual tool handlers
- runner-facing auth-profile shaping should go through shared adapters in `src/agents/auth-profiles/session-override.ts` instead of per-caller translation helpers
- preservation/rebase strategy is tracked in `docs/dev/upstream-compat-feature-preservation-plan.md`

## Conflict hotspots

Watch these areas during rebases:

- `src/commands/models/*`
- `src/cli/*models*`
- provider auth normalization / usage code
- `src/infra/provider-usage.*`
- `src/agents/auth-profiles/*`
- `src/agents/session-status-card.ts`
- `ui/src/ui/views/agents-utils.ts`
- agents overview UI and tests

## Validation runbook

Recommended focused checks:

```bash
node scripts/run-vitest.mjs src/auto-reply/reply/commands-profiles.test.ts
node scripts/run-vitest.mjs src/agents/auth-profiles/session-override.test.ts
node scripts/run-vitest.mjs src/agents/auth-profiles/profiles.test.ts src/agents/auth-profiles.store-cache.test.ts src/agents/auth-profiles.sqlite-store.test.ts
node scripts/run-vitest.mjs src/commands/models/auth.test.ts src/commands/models/auth.login-profiles.test.ts src/cli/models-cli.test.ts
node scripts/run-vitest.mjs src/commands/doctor-auth-flat-profiles.test.ts src/commands/doctor-auth-oauth-sidecar.test.ts
node scripts/run-vitest.mjs src/infra/provider-usage.policy.test.ts src/infra/provider-usage.cache.test.ts src/infra/provider-usage.auth.normalizes-keys.test.ts
node scripts/run-vitest.mjs ui/src/ui/views/agents-utils.test.ts
```

If broader agents overview/profile picker work changed too, also run the relevant agents view tests.

## User-visible failure symptoms

- `/profile` or `/profiles` regressions
- wrong auth profile selected or reported
- explicit profile-id ignored
- usage shown against the wrong profile
- near-quota profile keeps getting selected even though another profile is available
- auto-switch or stop policy fires on stale quota data
- agents overview/profile controls missing or inconsistent

## Recovery notes

- confirm the deployable profile slices are on `ec-main`, not only on a feature branch
- compare local profile behavior against recent known-good `ec-main` commits before assuming upstream broke it
- prefer cherry-picking deployable profile fixes onto `ec-main` early instead of letting them accumulate on a broad feature branch
- keep quota-policy cache/state separate from cooldown logic; if these get mixed during a rebase, unwind that first
