# Retained Lost Task Audit Noise

Date: 2026-05-06
State: OPEN

## Summary

`openclaw status --deep` can make the task ledger look stale even when there are no active stale tasks. On the live user-scoped gateway, status reports:

- `Tasks 0 active · 0 queued · 0 running · 92 issues · audit 14 warn · 424 tracked`
- Gateway reachable and Slack OK.
- The 14 audit findings are all terminal `lost` task records retained until `cleanupAfter`.
- `openclaw tasks maintenance --json` preview reports no available repair or prune action.

This appears to be expected retention behavior in the current implementation, but the operator-facing status is too ambiguous. It reads like an actionable stale task problem even when maintenance has nothing safe to do.

## Evidence

Runtime commands from `~/.openclaw`:

```sh
openclaw tasks audit --json
openclaw tasks maintenance --json
openclaw status --deep
```

Audit summary:

```json
{
  "count": 14,
  "summary": {
    "total": 14,
    "warnings": 14,
    "errors": 0,
    "byCode": {
      "stale_queued": 0,
      "stale_running": 0,
      "lost": 14,
      "delivery_failed": 0,
      "missing_cleanup": 0,
      "inconsistent_timestamps": 0
    },
    "taskFlows": {
      "total": 0,
      "warnings": 0,
      "errors": 0
    }
  }
}
```

Maintenance preview:

```json
{
  "mode": "preview",
  "maintenance": {
    "tasks": {
      "reconciled": 0,
      "recovered": 0,
      "cleanupStamped": 0,
      "pruned": 0
    },
    "taskFlows": {
      "reconciled": 0,
      "pruned": 0
    }
  },
  "tasks": {
    "total": 424,
    "active": 0,
    "terminal": 424,
    "byStatus": {
      "queued": 0,
      "running": 0,
      "succeeded": 331,
      "failed": 78,
      "timed_out": 0,
      "cancelled": 1,
      "lost": 14
    }
  }
}
```

Sample retained lost task:

```json
{
  "severity": "warn",
  "code": "lost",
  "taskId": "cc4a356e-e6b9-42e3-9580-8f2ed7f532b9",
  "status": "lost",
  "runtime": "cli",
  "agentId": "odollo-soylei",
  "cleanupAfter": 1778168594000,
  "detail": "manual stale-running cleanup after OpenClaw task CLI hang; archived before state at /home/ecochran76/.openclaw/tasks/archive/manual-stale-running-cleanup-20260430-104314"
}
```

`1778168594000` resolves locally to `2026-05-07T10:43:14-05:00`.

## Source Reading

`src/tasks/task-registry.audit.ts` reports every `status === "lost"` task as an audit finding. Lost tasks with future `cleanupAfter` are warnings; expired lost tasks are errors.

`src/tasks/task-registry.maintenance.ts` prunes terminal tasks only when `shouldPruneTerminalTask()` returns true. If `cleanupAfter` is set, pruning waits until `now >= cleanupAfter`.

`src/tasks/task-registry.audit.test.ts` explicitly tests that retained lost tasks with future `cleanupAfter` are downgraded to warnings.

## Product Gap

The current behavior is internally coherent, but the operator surface conflates two different states:

- Actionable stale or wedged work that needs recovery.
- Retained terminal lost records that are waiting for normal cleanup.

That ambiguity matters for repos like Odollo that use OpenClaw as an operational task runner. Operators need to know whether the task ledger is unsafe or merely retaining historical failed/lost records.

## Recommended Fix

- Add a distinct audit/status category for retained terminal lost records, for example `retained_lost`, separate from actionable `lost`.
- In `openclaw status --deep`, summarize actionable task health separately from retained-terminal warning count.
- Teach `openclaw tasks maintenance --json` to explain why warnings remain when preview has no available action.
- Consider an explicit operator-approved command such as `openclaw tasks maintenance --ack-lost` or `--prune-retained-lost --before-cleanup`, with automatic archive/backup, for cases where the operator wants a quiet ledger before retention expires.

## Runtime Recommendation

Do not manually edit `~/.openclaw/tasks/runs.sqlite` just to quiet the warnings. The supported maintenance preview says there is nothing to prune yet. If immediate cleanup is required, use a backup-first/manual SQLite intervention only as an operator-approved break-glass action.
