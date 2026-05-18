# Agent Wake Triggers

State: OPEN
Created: 2026-05-17

## Current State

Slack-bound agents can promise to monitor long-running work, but the current
operational path often keeps the model turn open while shell work blocks. When
the turn exceeds model or gateway timeout, the user sees stalled progress
messages or timeout errors instead of a reliable follow-up.

OpenClaw already has useful substrate: stable session keys, `openclaw agent`
resume, cron, tasks, and `sessions_yield` semantics. The missing surface is a
bounded, agent-facing "wake me when this predicate changes" workflow.

## Scope

- Add a repo-local skill that tells agents how to create bounded wake triggers.
- Add a standalone script that can persist trigger records, evaluate success or
  failure predicates, and resume the same OpenClaw agent/session.
- Keep the first slice outside gateway internals so it can be used immediately
  by existing agents and refined before becoming a core TaskFlow primitive.

## Non-Goals

- Do not replace OpenClaw cron, tasks, or TaskFlow.
- Do not add a new daemon in this slice.
- Do not let triggers run indefinitely.
- Do not hide long-running operation details inside Slack progress spam.

## Phases

1. Userland trigger primitive:
   - `scripts/wake-trigger.mjs set/list/show/rm/check`
   - durable JSON records under `~/.openclaw/wake-triggers`
   - bounded attempts, cooldown, timeout, and terminal states
   - session-level `maxAutomatedResumes` guard that requires human ack before
     further self-wake chains
   - session and global default configuration for operator-tuned limits
   - resume via `openclaw agent --agent ... --session-key ... --message ...`
2. Agent skill:
   - explain when to set a trigger
   - require deterministic success/failure predicates
   - require explicit yield after setting a trigger
   - include same-thread Slack resume examples
3. Scheduler integration:
   - install a recurring systemd user timer that runs `wake-trigger check`
   - keep the checker as a short-lived scan-and-exit process, not a
     long-running watcher
   - expose status in `openclaw status` or a small diagnostic command
4. Core integration:
   - evaluate promoting wake triggers into TaskFlow-managed state
   - reuse existing task audit and maintenance semantics for stale records

## Acceptance Criteria

- An agent can register a trigger for a long-running command outcome.
- A later `check` resumes the same agent/session exactly once for a terminal
  success, failure, or timeout.
- Repeated checks do not retrigger a completed wake record.
- Failed resume attempts are bounded by `maxAttempts`.
- Repeated automated resumes for one session are bounded by
  `maxAutomatedResumes`; after the limit, a human/operator must acknowledge the
  session before additional automated resumes.
- Operators can set limits for the current session or as permanent global
  defaults.
- A recurring checker can be installed without altering gateway internals.
- Trigger records are inspectable and removable by operators.

## Definition Of Done

- Skill and script are tracked in this repo.
- Script has syntax validation.
- A dry-run check can prove command predicates without calling OpenClaw.
- Follow-up work is clear for cron/system integration.
