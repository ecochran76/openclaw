# Cron Tool Profile And Lost Session Smoke

Date: 2026-04-28

## Context

While smoke-testing the SoyLei daily chat memory review cron in
`/home/ecochran76/.openclaw`, the job exposed two scheduler/runtime gaps.

Job:

- `a53a4de9-a0c0-4b97-9ecd-c60265f911f6`
- `soylei-daily-chat-memory-review`
- schedule: `30 20 * * *` in `America/Chicago`

## Observed Behavior

1. With agent `soylei-primary` using `tools.profile="messaging"`, adding a
   cron payload `toolsAllow` containing `read` and `exec` did not expose file or
   shell tools. The model completed with a blocked final response, and the cron
   run was recorded as `ok`.
2. After moving the job to a cron-only agent with `tools.profile="coding"`, the
   packet script ran and updated:
   `/home/ecochran76/.openclaw/workspace-soylei-primary/tmp/daily-chat-review/2026-04-28/soylei-chat-review-packet.json`.
3. The same run later became stuck, then task state showed `lost` with
   `error="backing session missing"`, while `cron/jobs-state.json` recorded the
   run as `lastRunStatus="ok"` and `lastStatus="ok"`.

## Related Log Signals

- Repeated bundle MCP startup failures for `imcli`:
  `McpError: MCP error -32000: Connection closed`.
- Stuck-session diagnostics for:
  `agent:soylei-primary-memory-reviewer:cron:a53a4de9-a0c0-4b97-9ecd-c60265f911f6`.
- Tool-policy warnings that Graphiti allow-list entries did not match callable
  tools in the cron-only agent context.

## Expected Behavior

- Cron-specific `toolsAllow` should either clearly be documented as a final
  narrowing filter only, or fail/warn when it asks for tools excluded by the
  effective agent profile.
- If an isolated cron backing session is lost, cron state should not record the
  run as successful.
- Bundle MCP startup failure should not strand unrelated cron finalization.

## Reproduction Sketch

1. Create an isolated cron job for an agent with `tools.profile="messaging"`.
2. Add `--tools read,exec,...` and prompt it to read a file and run a script.
3. Observe blocked model response but `lastRunStatus="ok"`.
4. Move the job to a `coding`-profile agent sharing the same workspace.
5. Observe packet script execution, followed by stuck/lost task state and
   successful cron state.

## Impact

This makes cron smoke tests falsely green and can prevent the next scheduled
run from being evaluated correctly unless task/cron state is checked together.

## Fix Applied

Patched cron-triggered embedded runs so `toolsAllow` entries that are not
callable after effective profile/policy resolution fail before the model is
prompted. The error now states that cron `--tools` / `toolsAllow` is a final
narrowing filter and cannot add tools excluded by `tools.profile` or other tool
policies. Updated cron docs with the same rule.

Patched task-registry cron recovery so durable cron run logs or job sidecar state
can recover an already-`lost` cron task when they prove the same run reached a
terminal status. Successful late recovery also clears stale
`error="backing session missing"` task text.

Validation:

- `pnpm test -- src/agents/tool-allowlist-guard.test.ts src/cron/isolated-agent/run.message-tool-policy.test.ts src/tasks/task-registry.maintenance.issue-60299.test.ts`
- `pnpm test -- src/tasks/task-registry.maintenance.issue-60299.test.ts`
- `pnpm test -- src/cron/service/ops.regression.test.ts src/cron/service/timer.regression.test.ts src/cron/service/ops.test.ts src/cron/service/timer.test.ts`
- `pnpm test -- src/tasks/task-registry.test.ts src/tasks/detached-task-runtime.test.ts`
