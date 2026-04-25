# Cron Model Override And Delivery Status

State: OPEN
Created: 2026-04-24

## Summary

An isolated OpenClaw cron job can record the requested model in job config but
run the actual agent session on the agent default model. The same run can also
deliver a final message successfully through the OpenClaw bound message path
while the background task and cron run are marked `error` because an earlier
non-final send tool failed.

This was observed during live Odollo SoyLei daily CRM report validation. The
Odollo side produced valid daily report artifacts and OpenClaw delivered the
final report to the bound Slack channel, but early run metadata showed the
wrong model and one run had a misleading failed-task state.

Follow-up after refreshing runtime instructions produced a later run that did
use `gpt-5.5` and succeeded. That narrows the model concern: the first two runs
still need explanation because their summaries claimed the configured model
while cron run metadata recorded `gpt-5.4-mini`, but the latest run shows model
override propagation can work in the current runtime state.

## Bug Report Draft

Bug type: Cron model override / task delivery status accounting

Beta release blocker: No

Summary: Early runs of a cron job configured with a stronger model override
`openai-codex/gpt-5.5` and `medium` thinking launched the agent turn with
`openai-codex/gpt-5.4-mini`, apparently the configured agent default. One run
also delivered the final Slack message through the OpenClaw bound message tool,
but `openclaw tasks list`, `openclaw tasks show`, and `openclaw cron runs`
reported the run as failed because an earlier Slack Mirror send attempt failed.
After runtime instruction refresh, a later run used `gpt-5.5` and succeeded, so
the remaining need is to explain and make visible why earlier cron runs ignored
or failed to reflect the model override.

Steps to reproduce:

1. Configure an agent whose default model is `openai-codex/gpt-5.4-mini`.
2. Add an isolated cron job for that agent with payload model
   `openai-codex/gpt-5.5`, `thinking: medium`, and Slack announce delivery.
3. Run the cron job manually with `openclaw cron run <job-id>`.
4. Inspect the resulting session metadata, trajectory metadata, task record,
   and `openclaw cron runs --id <job-id>`.

Expected behavior:

- The cron-launched session uses the cron payload model and thinking override,
  or records an explicit fallback reason if the override is unavailable.
- `openclaw cron runs` exposes both configured model and actual runtime model
  when they differ.
- A failed non-final send attempt should not make the overall cron task fail
  when the final OpenClaw delivery path succeeds and the agent final answer is
  otherwise successful.
- Delivery status should distinguish:
  - final message delivered
  - auxiliary tool send failed before final delivery
  - task failed with no final delivery
- Task and cron status should not require operators to infer this distinction
  from raw trajectory logs.

Actual behavior observed in early runs:

- Cron job config contained:
  - `payload.model: openai-codex/gpt-5.5`
  - `payload.thinking: medium`
  - isolated session target
  - Slack announce delivery
- Session metadata and trajectory metadata recorded:
  - provider: `openai-codex`
  - model: `gpt-5.4-mini`
- `openclaw cron runs` recorded:
  - `status: error`
  - `error: Slack-mirror Messages-send failed`
  - `delivered: true`
  - `deliveryStatus: delivered`
  - `delivery.fallbackUsed: false`
  - actual model: `gpt-5.4-mini`
- `openclaw tasks list --runtime cron --json` recorded the task as `failed`
  while its terminal summary claimed the workflow itself completed and posted
  the final report.

Follow-up behavior after runtime refresh:

- A later manual cron run recorded:
  - `status: ok`
  - actual model: `gpt-5.5`
  - `delivered: true`
  - `deliveryStatus: delivered`
  - `fallbackUsed: false`
- That later run posted another copy of the daily report, showing the need for
  idempotent daily-report repost guards in the agent workflow or cron runner.

## Source Areas To Inspect

- Cron job payload to agent-session launch path.
- Model/thinking override propagation for isolated cron sessions.
- Fallback accounting when a requested model cannot be used.
- Task status aggregation when an agent turn has tool errors before a
  successful final answer and successful final delivery.
- Distinction between plugin/tool send failures and OpenClaw bound-channel
  final delivery.
- Cron run history schema for configured model vs actual model.
- Idempotency or duplicate-post prevention for manually re-run daily report
  jobs that have already posted a report for the report date.

## Acceptance Criteria

- A cron job with `--model` and `--thinking` launches the agent session with
  those values when available.
- If OpenClaw falls back, task/cron/session metadata includes the configured
  target, actual model, and fallback reason.
- A successful final `message` delivery is not reported as a failed cron task
  solely because an earlier auxiliary send tool failed.
- Cron/task output makes mixed outcomes explicit without requiring trajectory
  inspection.
- Manual re-runs of a daily report can identify an already-posted report and
  avoid duplicate bound-channel posts unless explicitly instructed to repost.
- Regression coverage includes a cron-run fixture where:
  - requested model differs from agent default
  - one non-final send tool fails
  - final bound delivery succeeds
  - final task status reflects the intended aggregate semantics.
