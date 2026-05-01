# Slack Tenant Reload Stale Task Blocker

State: OPEN
Created: 2026-04-28

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
