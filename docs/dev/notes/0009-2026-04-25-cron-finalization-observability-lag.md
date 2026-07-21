# Cron Finalization Observability Lag

State: OPEN
Created: 2026-04-25

## Summary

During live validation of an OpenClaw cron-driven daily CRM report, the agent
completed its domain workflow before OpenClaw observability surfaces reflected
the terminal cron state.

The workflow had already:

- written the expected downstream artifacts
- rendered and validated the report
- posted to the bound Slack channel
- recorded the downstream post registry
- updated the agent runtime status file

At that point, `openclaw tasks list --runtime cron --json` still showed the
manual cron task as `running`, and `openclaw cron runs --id <job-id>` had not
yet appended the final run-history row.

After additional polling, both OpenClaw surfaces converged:

- the task changed to `succeeded`
- the cron run-history row appeared with `status: ok`
- the run recorded actual model `gpt-5.5`, provider `openai-codex`, successful
  delivery, and the final bound-channel delivery target

This means the earlier concern was not a permanent stale-task bug. It is an
observability-lag and operator-debugging hazard.

## Why This Matters

Operators may inspect OpenClaw state immediately after a cron-launched agent
has completed its application-level work. If task/run history is still lagging,
they can incorrectly conclude that:

- the cron run is broken or hung
- the scheduler did not finalize the task
- the final report was not delivered
- the model metadata is unavailable
- another manual run is needed

For workflows that can post to chat, that confusion creates duplicate-send
risk if the operator forces another run before finalization catches up.

## Observed Sequence

1. Manual cron run was enqueued with `openclaw cron run <job-id>`.
2. The command returned an enqueued run id rather than waiting for the final
   agent answer.
3. Runtime artifacts and downstream post registry showed the agent workflow had
   completed successfully.
4. `openclaw tasks list --runtime cron --json` still showed the task as
   `running`.
5. `openclaw cron runs --id <job-id>` still showed only older run-history rows.
6. After further polling, task status changed to `succeeded` and the cron
   history row appeared.

## Product Implications

The current behavior is technically eventually consistent, but the CLI makes
that consistency boundary hard to see. For live operations, the safer mental
model is:

- domain artifacts can be complete before cron/task history is complete
- run history is authoritative once appended, but absence of the latest row is
  not immediate proof of failure
- duplicate-send workflows need their own idempotency guard, not only cron task
  state

## Recommended Fixes

- Make `openclaw cron run --expect-final` actually wait for terminal run
  history or task state, or document that it only confirms enqueue in this
  path.
- Add an intermediate task status such as `finalizing` or expose a `lastAgent`
  event timestamp so operators can tell the agent has returned but persistence
  is still catching up.
- Have `openclaw cron runs --id <job-id>` show a pending/latest in-flight run
  when task state exists but the run-history row is not yet appended.
- In task output, include enough session metadata to correlate an in-flight
  cron run with the active session before final history appears.
- For delivery-capable cron jobs, surface an explicit duplicate-send warning
  when a prior post registry or delivery idempotency marker already exists.

## Acceptance Criteria

- A manual cron run with `--expect-final` does not return as final until either
  task state or run history is terminal, or it clearly reports
  `enqueued_only`.
- Operators can distinguish `running`, `agent_completed_finalizing`, and
  `succeeded` without reading downstream application artifacts.
- `cron runs` can show the latest in-flight run or explain that run-history
  persistence is pending.
- Delivery-capable cron jobs expose enough state to avoid duplicate sends while
  OpenClaw finalization is still catching up.
