# Slack Tenant Reload Stale Task Blocker

State: OPEN
Created: 2026-04-28

## 2026-05-05 Slack Responsiveness Review

Reviewed during the ec-main Slack response reliability pass. The stale-task
reload blocker is not the active cause of the SoyLei human-root thread drop
tracked in `0020-2026-05-05-soylei-slack-thread-participation-gap.md`, and the
Socket Mode transport liveness gap is now resolved in
`0017-2026-05-04-soylei-slack-socket-stale-ingress.md`.

Current source already covers the highest-risk reload blocker items recorded in
this note:

- channel hot reload deferral uses `gateway.reload.deferralTimeoutMs` and
  proceeds after the bounded timeout when work does not drain;
- task-registry maintenance reconciles generic stale CLI task rows after the
  stale grace period when no active run context backs them;
- channel health monitor can restart stale connected Slack sockets when
  `lastTransportActivityAt` ages past the stale threshold.

Keep this note open for the remaining diagnostics surface, not for the current
Slack response-drop bug. Remaining work is to make pending reload blockers and
per-account Slack lifecycle/reconnect churn visible from status/diagnostic CLI
surfaces without log correlation.

## 2026-05-01 Review

This note is partially acted on but should remain open as a Slack operations
follow-up:

- Channel reload deferral now has a configurable bounded timeout through
  `gateway.reload.deferralTimeoutMs`; when active work does not drain before the
  timeout, channel reload proceeds anyway instead of waiting forever.
- Restart draining now accounts for active command tasks, embedded runs, and
  bundled runtime dependency installs, and reset paths clear stale lane state
  after in-process restarts.
- The recent liveness-probe hardening reduces heavyweight status reads during
  readiness checks.

Remaining gaps from the note are still valid: Slack tenant readiness and
reconnect churn should be surfaced per account, and status should make pending
reload blockers visible without requiring log correlation.

## Summary

SoyLei Slack access changes were written correctly to the user-scoped
`openclaw.json`, but the gateway did not apply them while handling live traffic.
Michael Forrester messaged `#ask-lei` and received no response because the
Slack channel reload was deferred behind task bookkeeping that had become stale.

The file-backed config included the expected SoyLei allowlist and channel users:

```text
U0127BGJ3U5 Eric
U012M8NDV3K Michael Forrester
U09V0174TC7 Baker Kuehl
```

Gateway logs still reported:

```text
[reload] channel reload still deferred after 845500ms with 2 task run(s) active
```

The Odollo processes originally associated with those runs were no longer
present, but `openclaw tasks audit --json` still showed two `stale_running`
`cli` task records for `odollo-soylei` monitor-dispatch work. Cancelling those
task ids cleared the active task count.

## Observed Recovery

The operator recovery sequence was:

```text
systemctl --user restart openclaw-gateway.service
openclaw config validate
openclaw tasks audit --json
openclaw tasks cancel 822fdcc6-5003-4dda-abeb-209933fadff8
openclaw tasks cancel a27ece6a-64f7-4ad8-9844-34b7ca0b416b
openclaw status --deep
```

After restart, Slack startup was slow but eventually applied the expected
SoyLei tenant state:

```text
slack startup step "socket start" completed in 80570ms
slack channels resolved: C0B0AK14B7X->ask-lei
slack users resolved: U0127BGJ3U5->Eric, U012M8NDV3K->Michael Forrester, U09V0174TC7->baker.kuehl
slack channel users resolved: U0127BGJ3U5->Eric, U012M8NDV3K->Michael Forrester, U09V0174TC7->baker.kuehl
```

`openclaw status --deep` then reported:

```text
Tasks: 0 active, 0 queued, 0 running
Slack OK ok (default:default, soylei:soylei)
```

## Product Issues

- Channel reload deferral has no apparent stale-task escape hatch. A dead
  `running` task record can indefinitely prevent Slack allowlist/routing changes
  from applying.
- The gateway can report ready while Slack providers are still blocked in
  `socket start` for more than 80 seconds.
- During this incident, Slack Socket Mode repeatedly missed pongs and
  reconnected after startup. The gateway remained usable after recovery, but the
  reconnect churn should be observable separately from channel config validity.
- `openclaw status --deep` does not make it obvious that a pending channel reload
  is blocked by stale tasks; the operator has to correlate logs and task audit.

## Recommended Fixes

- Add a bounded timeout or stale-run reconciliation path for channel reload
  deferral.
- Surface pending channel reload state in `openclaw status --deep`, including
  blocking operation/task ids.
- Have `openclaw tasks maintenance --apply` reconcile or explicitly explain why
  stale `running` CLI task records cannot be repaired automatically.
- Distinguish Slack provider lifecycle states: configured, startup pending,
  socket connected, reconnecting, and healthy.
- Add tenant/account labels to Slack Socket Mode logs so default-vs-SoyLei
  reconnects can be diagnosed without inference.

## Acceptance Criteria

- A stale background task cannot indefinitely block unrelated Slack allowlist or
  routing changes.
- Operators can see blocked reload state and the exact task ids from a single CLI
  surface.
- Multi-tenant Slack startup reports per-account readiness and reconnect churn.
- A freshly authorized allowlisted user in a no-mention channel can trigger the
  bound agent without a gateway restart.

## Follow-up Observation: Baker Identity Correction

On 2026-04-28, the SoyLei `#ask-lei` allowlist needed another live identity
correction: Baker's real sender id in the SoyLei tenant was observed as
`U012ETLV6NQ`, while the durable config still allowed `U09V0174TC7`.

The file-backed config and workspace policy were corrected in the user-scoped
runtime home, and a direct Slack Web API threaded response to Baker succeeded.
However, the gateway again logged a deferred channel reload after the config
change:

```text
[reload] config change detected; evaluating reload (channels.slack.accounts.soylei.allowFrom, channels.slack.accounts.soylei.channels.C0B0AK14B7X.users)
[reload] config change requires channel reload (slack) — deferring until 2 task run(s) complete
[reload] channel reload still deferred after 61328ms with 2 task run(s) active
```

At the same time, `openclaw status --deep` reported `Tasks: 0 active · 0 queued ·
0 running` and `Slack OK`. This makes the stale-task blocker harder to diagnose:
the gateway reload guard and status/task surfaces disagreed about active work.

A controlled `systemctl --user restart openclaw-gateway.service` cleared the
deferred reload path, but startup again exposed a readiness gap: the service
reported gateway ready and listened on `127.0.0.1:18789`, while HTTP probes could
connect but timed out without receiving bytes during provider startup.

Additional recommended fix:

- Reconcile the reload guard's active-run count with the same task accounting
  used by `openclaw status --deep`, or surface both counts with their sources.
- Add a health/readiness distinction for "HTTP socket listening" versus
  "gateway can answer status requests" during channel/provider startup.

## Follow-up Observation: Null-Id Task Records Block Maintenance

On 2026-05-01, a user-scoped OpenClaw runtime tune-up hit the same stale-task
family through the task maintenance surface. `openclaw tasks maintenance --apply`
reported stale/lost task audit drift but did not reconcile it:

```text
tasks.total=351
tasks.active=2
tasks.byStatus.running=2
audit.errors=1
audit.warnings=3
audit.byCode.stale_running=1
audit.byCode.lost=3
maintenance.tasks.reconciled=0
maintenance.tasks.recovered=0
maintenance.tasks.cleanupStamped=0
maintenance.tasks.pruned=0
```

The active rows shown by `openclaw tasks list --json` had `id: null`, both for
`odollo-soylei` CLI monitor-dispatch runs. Because the records had no task id,
the usual operator recovery path from the earlier incident (`openclaw tasks
cancel <id>`) was not available.

The same tune-up removed a disabled plugin config key from the live
`openclaw.json`; gateway reload correctly detected that a restart was required,
but restart was deferred while these active task counts were present. A controlled
`systemctl --user restart openclaw-gateway.service` restored gateway RPC health
after warm-up, but the null-id task audit drift remained.

Additional recommended fixes:

- Ensure task creation cannot persist `running` task records without stable task
  ids.
- Teach `openclaw tasks maintenance --apply` to reconcile or quarantine null-id
  task rows instead of reporting zero repair actions.
- Include a reason in task maintenance output when a stale record cannot be
  repaired automatically.

## Cross-Repo Handoff: Odollo Integration

Odollo is a representative long-running OpenClaw integration, not an out-of-scope
use case. Its intended boundary is appropriate:

- Odollo remains the deterministic execution engine for Odoo writes.
- OpenClaw reviews bounded Odollo work packets and returns reviewed artifacts,
  operator questions, or recommendations.
- Odollo validates and applies through deterministic commands.
- Slack is the operator surface for status, approvals, reports, and visibility.

The product issue here is OpenClaw reliability around task-ledger durability and
gateway reload blockers. The null-id `running` task records were associated with
`odollo-soylei` CLI monitor-dispatch runs, but the same failure class would
affect any long-running CLI-backed integration whose task record is persisted
without a stable id.

The matching Odollo-side note is:

```text
/home/ecochran76/workspace.local/odollo/doc/dev/notes/openclaw-task-ledger-handoff-2026-05-01.md
```

Implementation direction:

- Add regression coverage for a `running` task record with a missing/null id.
- Decide whether maintenance should repair the record in place, mark it lost, or
  move it to a quarantine ledger; the key requirement is that the gateway reload
  guard no longer treats it as indefinitely active work.
- Report unrepairable task rows explicitly in `openclaw tasks maintenance`
  output and `openclaw status --deep`.
- Keep reload blocking diagnostics tied to both task ids and raw ledger row
  identity so operators can act without log correlation.

## 2026-05-01 Follow-up: Gateway CLI Task Reconciliation

Patched task-registry maintenance so generic gateway-backed `cli` tasks no
longer stay active solely because a child session row remains. After the normal
stale grace period, a `cli` task without a task kind is treated as run-context
tracked: if neither `sourceId` nor `runId` maps to an active agent run context,
maintenance can mark the row `lost` even when the session ledger still has the
child session key.

The patch intentionally keeps task-kind-specific `cli` work, such as media
generation jobs, on the prior backing-session path so long-running tool jobs do
not get swept just because they are not represented by the generic gateway run
context.

Validation:

- `pnpm test src/tasks/task-registry.test.ts src/tasks/task-registry.audit.test.ts`
- `pnpm exec oxfmt --check --threads=1 src/tasks/task-registry.maintenance.ts src/tasks/task-registry.test.ts`
- `pnpm build`
- `scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch`

Live result after patch:

- Gateway RPC recovered after warm-up with `Read probe: ok`.
- The two stale SoyLei `odollo-soylei` monitor-dispatch `running` tasks were
  reconciled to `lost` with `error="backing session missing"`.
- SABER had no active stale task rows; recent `odollo-saber` drain tasks were
  terminal.
- `openclaw tasks audit --json --code stale_running` returned zero findings.

Residual work:

- This closes the current cancellable-id SoyLei stale-task incident.
- Direct fixture coverage now exists for the older null-id row class. Restore
  paths skip invalid task/delivery ids defensively, and the SQLite store purges
  legacy rows with missing or blank `task_id` values before exposing a snapshot
  to the in-memory task registry. The durable invariant remains that active task
  rows need a stable repair token.
