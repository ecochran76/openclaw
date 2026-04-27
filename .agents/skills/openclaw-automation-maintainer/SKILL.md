---
name: openclaw-automation-maintainer
description: Maintain and debug OpenClaw automation runs and /automation chat commands. Use when Codex needs to inspect automation syntax, bounds, turn/token/duration limits, stop reasons, one-turn completion, progress announcements, steering/status behavior, worker job construction, or automation rebase preservation.
---

# OpenClaw Automation Maintainer

Use this skill for `/automation` behavior, automation worker execution, and automation local-feature preservation.

## Read First

- `docs/dev/local-features/automation.md`
- `docs/dev/local-feature-index.md`
- `docs/dev/policies/validation-and-handoff.md`
- `docs/automation/tasks.md` when inspecting background task records
- `docs/tools/subagents.md` when automation delegates to subagents

## Triage Order

1. Capture the exact user command and parsed bounds:
   - goal text
   - `--turns`
   - `--tokens`
   - `--duration`
   - label/model/thinking flags when present
2. Inspect status before changing code:
   - `/automation status`
   - `/automation list`
   - relevant task/session logs when accessible
3. Classify the finish reason:
   - `completed`: the worker decided the goal was done
   - `max_turns`: turn guard stopped work
   - `max_tokens`: token guard stopped work
   - `max_duration`: time guard stopped work
   - `approval_required`: worker reached an approval boundary
   - `error`: source/runtime failure
4. If a run stops after one turn, determine whether the worker saw the goal as complete or whether progress/follow-up turn scheduling broke.

## Source Hotspots

- `src/automation/command-surface.ts`
- `src/automation/worker-job.ts`
- `src/automation/worker-result.ts`
- `src/automation/progress-reporting.ts`
- `src/automation/runner.ts`
- `src/automation/status.ts`
- `src/agents/tools/automation-tool.ts`
- `src/auto-reply/reply/commands-automation.ts`
- `src/auto-reply/reply/commands-automation-status.test.ts`

## Command Guidance

Prefer explicit bounds in suggested commands:

```text
/automation run <goal> --turns 5 --tokens 40000 --duration 20m
```

Do not use `/automation run --help`; that starts a run whose goal is `--help`. Use `/automation help`.

## Validation

Use the focused family gate:

```bash
scripts/ec-main-rebase-gate.sh --family automation
```

For source changes that affect runtime loading or generated output, also run:

```bash
pnpm build
```

## Closeout Evidence

Report:

- exact command or parsed bounds
- stop reason and whether it matches expected behavior
- source files changed, if any
- focused validation result
- best next step
