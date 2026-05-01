# Cron Model Allowlist Reporting

State: CLOSED
Created: 2026-04-24
Closed: 2026-05-01

## 2026-05-01 Resolution

This note is acted on by the current cron model-selection behavior. Cron no
longer silently falls back when a job payload model is not allowed or cannot be
resolved; it fails the run with an explicit validation error. The operator docs
now state this behavior in both the cron automation guide and CLI cron
reference.

Relevant current surfaces:

- `docs/automation/cron-jobs.md` documents that an invalid or disallowed
  `--model` fails instead of falling back.
- `docs/cli/cron.md` carries the same warning for CLI users.
- `src/cron/isolated-agent/model-selection.ts` produces explicit rejection
  reasons such as `cron payload.model ... rejected by agents.defaults.models
allowlist`.
- Cron model-selection tests cover rejected model refs and allowlist failures.

## Summary

OpenClaw cron can store and display an agent-turn job with a configured model
that is not currently allowed for the target runtime, then silently fall back at
execution time except for a gateway log warning.

This made the SoyLei daily-report cron look correctly configured:

```text
model: openai-codex/gpt-5.5
```

but the run metadata showed:

```json
{
  "provider": "openai-codex",
  "model": "gpt-5.4-mini"
}
```

The gateway log contained the real explanation:

```text
[cron] payload.model 'openai-codex/gpt-5.5' not allowed, falling back to agent defaults
```

In this environment, the immediate config fix was to add
`openai-codex/gpt-5.5` to `agents.defaults.models` in
`/home/ecochran76/.openclaw/openclaw.json`. After hot reload,
`openclaw models list` showed `openai-codex/gpt-5.5` as configured, and a forced
cron run completed with:

```json
{
  "status": "ok",
  "provider": "openai-codex",
  "model": "gpt-5.5",
  "deliveryStatus": "delivered"
}
```

## Problem

The operator-facing surfaces did not make the mismatch obvious before runtime:

- `openclaw cron show` displayed the requested model without warning.
- `openclaw cron list` displayed the requested model without warning.
- The job did not fail validation despite the model being outside the active
  allowed set.
- The fallback was visible in gateway logs and final run metadata, not in the
  cron configuration surface.

This is risky because agents may report the configured model as the actual model
unless they independently inspect run metadata.

## Recommended Fixes

- Validate `cron add` and `cron edit --model` against the same allowed-model set
  used at run dispatch time.
- Make `cron show` and `cron list` indicate when a stored model is currently not
  allowed for the target agent/runtime.
- Include `requestedModel`, `actualModel`, and `modelFallbackReason` explicitly
  in cron run history.
- Consider making model fallback opt-in for isolated cron jobs that explicitly
  request a model, or at least mark the run status/warnings as degraded.

## Acceptance Criteria

- An operator can tell before running a job whether its configured model will be
  honored.
- A completed cron run clearly distinguishes requested model from actual model.
- If fallback occurs, cron history includes the fallback reason without requiring
  journal inspection.
