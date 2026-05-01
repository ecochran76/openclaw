# Per-Agent Heartbeat Scheduler Miss

State: CLOSED
Created: 2026-04-24
Closed: 2026-04-24

## 2026-05-01 Review

This note is ready to commit as durable history. The original scheduler-miss
hypothesis was already corrected in the note itself, and no additional
OpenClaw code change is required for the observed SoyLei heartbeat incident.
The smaller observability follow-up remains valid future work but does not
reopen this incident.

## Summary

The original hypothesis in this note was that OpenClaw 2026.4.23 recognized a
per-agent heartbeat setting in status output but did not dispatch the configured
agent heartbeat. Follow-up evidence disproved that for the observed
`odollo-soylei` case.

Corrected conclusion: OpenClaw dispatched `odollo-soylei` and read the correct
runtime `HEARTBEAT.md`; Odollo's heartbeat instructions let the agent return
`HEARTBEAT_OK` before running the required monitor-tick workflow.

## Resolution Update

Follow-up investigation showed that the original scheduler-miss hypothesis was
incorrect for the observed SoyLei case. The scheduler was dispatching
`odollo-soylei` on the 30-minute cadence, using session key
`agent:odollo-soylei:main`, and reading the correct workspace heartbeat file:

```text
/home/ecochran76/.odollo/openclaw/agents/soylei-prod-odollo-agent/HEARTBEAT.md
```

The failure was workflow semantics inside the Odollo agent heartbeat contract:
the agent read the correct file and returned `HEARTBEAT_OK` without first
running the no-op monitor tick review, validation, and accumulator append.

Evidence from the `10:16 CDT` run:

```text
trigger: heartbeat
sessionKey: agent:odollo-soylei:main
workspaceDir: /home/ecochran76/.odollo/openclaw/agents/soylei-prod-odollo-agent
toolMetas: read from ~/.odollo/openclaw/agents/soylei-prod-odollo-agent/HEARTBEAT.md
assistantTexts: ["HEARTBEAT_OK"]
```

The Odollo runtime heartbeat and reusable template were hardened so a scheduled
heartbeat is explicitly a due monitor-tick review. A manual smoke after that
change created and validated:

```text
/home/ecochran76/.odollo/tenants/soylei-prod/artifacts/monitor-tick-heartbeat-2026-04-24.json
/home/ecochran76/.odollo/tenants/soylei-prod/artifacts/crm-monitor-tick-reviewed-2026-04-24-heartbeat-smoke.json
/home/ecochran76/.odollo/tenants/soylei-prod/artifacts/crm-monitor-events-2026-04-24.jsonl
```

Residual OpenClaw observability issue: `openclaw system heartbeat last` appears
global and can mislead debugging of per-agent heartbeat behavior. A future
enhancement should expose per-agent last-run/skip state, but this incident no
longer demonstrates a dispatch failure.

## Environment

- OpenClaw version: `2026.4.23 (98a27c3)`
- OS: Linux WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`
- Node: `24.13.0`
- Gateway service: systemd, running on `127.0.0.1:18789`
- Node service: systemd, running
- Affected agent id: `odollo-soylei`
- Agent workspace:
  `/home/ecochran76/.odollo/openclaw/agents/soylei-prod-odollo-agent`

## Configuration Evidence

The config contains:

```json
{
  "id": "odollo-soylei",
  "name": "odollo-soylei",
  "workspace": "/home/ecochran76/.odollo/openclaw/agents/soylei-prod-odollo-agent",
  "agentDir": "/home/ecochran76/.openclaw/agents/odollo-soylei/agent",
  "model": "openai-codex/gpt-5.4-mini",
  "identity": {
    "name": "Odollo SoyLei"
  },
  "heartbeat": {
    "every": "30m"
  }
}
```

`openclaw status` also reports:

```text
Heartbeat: 30m (main), ..., 30m (odollo-soylei), ...
Tasks: 0 active · 0 queued · 0 running · no issues · audit clean
```

## Superseded Scheduler-Miss Hypothesis

The sections below preserve the original investigation trail. They are
superseded by the resolution update above and should not be used as the current
root-cause statement for the SoyLei incident.

### Original Observed Behavior

After a manual recovery turn completed at `2026-04-24T12:59:20Z`, no automatic
`odollo-soylei` heartbeat turn ran by `2026-04-24T15:10:33-05:00`, despite the
30-minute interval. No newer monitor packet, reviewed output, or accumulator
append appeared in the agent's tenant runtime artifact directory.

The latest automatic heartbeat inspection returned:

```json
{
  "ts": 1777043287894,
  "status": "skipped",
  "reason": "empty-heartbeat-file",
  "durationMs": 16
}
```

This is suspicious because the affected agent's workspace has a non-empty
`HEARTBEAT.md`, and the runbook state in that file was updated by the manual
recovery turn.

### Stale Task Found And Cleared

Before the recovery check, `openclaw tasks audit` reported a stale running task:

```text
Task error stale_running 8642a640-... running 22h11m running task appears stuck
```

The task was `agent:odollo-soylei:heartbeat-smoke`, created on
`2026-04-23 09:42 CDT`. It was cancelled successfully, and `openclaw tasks audit`
then returned zero findings.

This fixed the task registry state, but not the later automatic scheduling miss.

### Manual Recovery Proved The Agent Works

A manual bounded run was sent with:

```bash
openclaw agent \
  --agent odollo-soylei \
  --session-key agent:odollo-soylei:heartbeat-recovery-20260424 \
  --message 'Heartbeat recovery check after clearing stale task...'
```

The manual run succeeded:

- run id: `48b05262-68aa-4ad4-a6bd-ff5a755cc68a`
- task id: `c849d708-9f55-4205-95b3-64e8c748f562`
- task status: `succeeded`
- completed at: `2026-04-24T12:59:36.797Z`

It produced the expected Odollo artifacts:

- monitor packet:
  `/home/ecochran76/.odollo/tenants/soylei-prod/artifacts/monitor-tick-heartbeat-2026-04-24.json`
- reviewed output:
  `/home/ecochran76/.odollo/tenants/soylei-prod/artifacts/crm-monitor-tick-reviewed-2026-04-24-0757cdt.json`
- accumulator:
  `/home/ecochran76/.odollo/tenants/soylei-prod/artifacts/crm-monitor-events-2026-04-24.jsonl`

Odollo validation passed:

```json
{
  "valid": true,
  "schema": "odollo.crm_monitor.tick_reviewed_output.v1",
  "status": "complete",
  "errors": [],
  "warnings": [],
  "summary": {
    "interval_notes": 1,
    "event_candidates": 0,
    "lead_update_candidates": 0,
    "memory_candidates": 0,
    "apply_candidates": 0,
    "operator_questions": 0
  }
}
```

### Original Expected Behavior

For each agent with `heartbeat.every`, the heartbeat scheduler should:

- inspect that agent's configured workspace heartbeat state, not only the
  default agent heartbeat surface
- enqueue or run that agent's heartbeat turn on the configured interval
- expose per-agent heartbeat last-run/skip state, including which file or
  workspace caused a skip
- keep stale task state from silently preventing future per-agent heartbeat
  dispatch

### Original Actual Behavior

The gateway recognizes `30m (odollo-soylei)` in status output, and manual
`openclaw agent --agent odollo-soylei ...` works, but automatic interval
dispatch did not run the per-agent heartbeat. `openclaw system heartbeat last`
reported `empty-heartbeat-file`, apparently from a heartbeat surface other than
the non-empty `odollo-soylei` workspace `HEARTBEAT.md`.

## Remaining OpenClaw Observability Follow-Up

The scheduler-miss root cause is closed, but a smaller OpenClaw observability
gap remains: `openclaw system heartbeat last` appears global and can mislead
per-agent heartbeat debugging when multiple agents have heartbeat config.

Useful future improvements:

- expose per-agent heartbeat last-run/skip state
- include agent id, session key, workspace, and heartbeat file path in heartbeat
  last/diagnostic output
- distinguish "global heartbeat skipped" from "specific agent heartbeat skipped"

## Acceptance Criteria

- The SoyLei incident is not treated as an OpenClaw dispatch failure.
- Future heartbeat diagnostics can answer which agent, workspace, session key,
  and heartbeat file produced the last heartbeat status.
- `openclaw system heartbeat last` or a companion command can query per-agent
  heartbeat state without relying on global-only output.
