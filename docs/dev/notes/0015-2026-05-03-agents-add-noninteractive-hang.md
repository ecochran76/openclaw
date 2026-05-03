# 0015 - 2026-05-03 - Agents Add Noninteractive Hang

State: OPEN
Created: 2026-05-03

## Summary

While installing the SoyLei marketing specialist in the live OpenClaw home,
`openclaw agents add --non-interactive --json` hung without producing output and
left high-CPU `openclaw-agents` child processes. The agent was installed by a
manual config/workspace path afterward, but the CLI path should be treated as an
OpenClaw product issue.

## Command

```bash
openclaw agents add soylei-marketing \
  --workspace /home/ecochran76/.openclaw/workspace-soylei-marketing \
  --model openai-codex/gpt-5.5 \
  --non-interactive \
  --json
```

## Observed Behavior

- The command produced no JSON output.
- It did not return after repeated polling.
- `ps` showed multiple stuck processes:
  - parent `openclaw`
  - child `openclaw-agents`
- The `openclaw-agents` child processes consumed high CPU until killed.
- The agent entry was not written to `openclaw.json`.
- The expected agent state directory was not created under
  `~/.openclaw/agents/soylei-marketing/agent`.

## Expected Behavior

In `--non-interactive --json` mode, `openclaw agents add` should either:

- complete deterministically with valid JSON output and create the configured
  agent entry/state directory, or
- fail with a bounded timeout/error payload.

It should not hang silently or leave runaway child processes.

## Workaround Used

The operator workflow proceeded by:

- rendering/installing the workspace files through `company-bot`
- adding the agent config entry directly to `~/.openclaw/openclaw.json`
- creating the minimal agent state directory
- validating with:
  - `openclaw config validate`
  - `openclaw agents list --json`
  - company-bot `a2a_readiness_smoke.py`

## Follow-Up

Reproduce in the OpenClaw repo with a temp OpenClaw home and inspect the
`agents add` implementation for:

- prompts or lock waits that still run under `--non-interactive`
- JSON output path deadlocks
- process supervision of the `openclaw-agents` child
- config write lock contention with the running gateway
