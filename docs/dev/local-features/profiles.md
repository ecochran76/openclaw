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
- partially overlapping with upstream work
- must be revalidated after rebase/upgrade work

## Known implementation notes

- explicit `openai-codex` profile ids/labels needed normalization support
- profile behaviors have both CLI and runtime surfaces
- dashboard/agents UI has had profile-related drift during feature-branch work

## Conflict hotspots

Watch these areas during rebases:

- `src/commands/models/*`
- `src/cli/*models*`
- provider auth normalization / usage code
- agents overview UI and tests

## Validation runbook

Recommended focused checks:

```bash
pnpm test -- src/commands/models/auth.test.ts
pnpm test -- src/commands/models/auth.login-profiles.test.ts
pnpm test -- src/cli/models-cli.test.ts
pnpm test -- src/infra/provider-usage.auth.normalizes-keys.test.ts
```

If UI/profile picker work changed too, also run targeted agents UI tests.

## User-visible failure symptoms

- `/profile` or `/profiles` regressions
- wrong auth profile selected or reported
- explicit profile-id ignored
- usage shown against the wrong profile
- agents overview/profile controls missing or inconsistent

## Recovery notes

- confirm the deployable profile slices are on `ec-main`, not only on a feature branch
- compare local profile behavior against recent known-good `ec-main` commits before assuming upstream broke it
- prefer cherry-picking deployable profile fixes onto `ec-main` early instead of letting them accumulate on a broad feature branch
