# Session Store Performance Roadmap

State: OPEN
Roadmap: P05
Created: 2026-04-30

This roadmap tracks work to keep service agents such as `odollo-soylei` and `graphiti-agent` responsive when their hot session stores grow large.

It complements:

- `docs/cli/sessions.md`
- `docs/concepts/session.md`
- `docs/reference/session-management-compaction.md`
- `docs/dev/plans/0004-2026-04-29-slack-cold-start-hardening.md`

## Current State

Live fieldwork on 2026-04-30 found oversized service-agent session stores:

- `odollo-soylei`: about 48.6 MB, 227 entries
- `graphiti-agent`: about 41.4 MB, 220 entries

The entries are mostly accumulated fresh-run history rather than one runaway session. Fresh session keys are appropriate for monitor, cron, dispatch, and helper runs, but fresh keys alone do not protect the Gateway when status, helper RPCs, dashboards, or maintenance paths parse a monolithic `sessions.json`.

Existing product surface already includes `openclaw sessions cleanup` and `session.maintenance` controls. The immediate goal is to use and harden that path instead of creating a separate plugin-owned cleanup mechanism.

Phase 1 field check found that the existing cleanup command is safe but too coarse for service-agent hot stores: dry-runs for both oversized agents reported no mutation because the stores are below the default `maxEntries` cap and the entries are recent enough for the default age cutoff. Phase 1 added one-off cleanup overrides and the first enforced pass reduced both hot stores to 75 entries.

## Goal

Keep service agents fast and predictable while preserving useful session history.

The desired steady state:

- health and helper RPCs stay cheap even when old service sessions exist
- service agents use fresh bounded session keys for background work
- old session entries and artifacts move out of hot paths through archive-first maintenance
- durable service facts live in service state stores or memory systems, not in large active chat transcripts
- operators have a safe dry-run-first command for routine cleanup

## Non-Goals

- Do not delete transcripts or session rows without an archive or dry-run preview.
- Do not replace existing session maintenance with a plugin-only mechanism.
- Do not force all interactive agents to use fresh sessions; conversational continuity remains valid for human chats.
- Do not make Graphiti memory a substitute for service-owned operational state.

## Phase 1: Baseline And Safe Cleanup Proof

Status: completed.

Purpose: confirm whether existing `openclaw sessions cleanup` can safely shrink the hot stores for service agents.

Scope:

- run dry-run cleanup for `odollo-soylei` and `graphiti-agent`
- inspect current `session.maintenance` config and defaults
- confirm whether cleanup is archive-first for the relevant entry and transcript types
- identify any stores where cleanup would skip too much because entries look active, missing timestamps, or protected

Candidate commands:

```bash
openclaw sessions cleanup --agent odollo-soylei --dry-run --json
openclaw sessions cleanup --agent graphiti-agent --dry-run --json
openclaw sessions cleanup --all-agents --dry-run --json
openclaw sessions cleanup --agent odollo-soylei --dry-run --json --max-entries 75
openclaw sessions cleanup --agent graphiti-agent --dry-run --json --max-entries 75
```

Validation:

```bash
openclaw gateway status --deep --require-rpc
openclaw sessions --agent odollo-soylei --json
openclaw sessions --agent graphiti-agent --json
```

Exit criteria:

- dry-run output clearly explains what would be kept, pruned, capped, or skipped
- no active session key needed by a live service is selected for removal
- the operator has enough evidence to approve an enforced cleanup pass
- one-off retention overrides exist so service-agent cleanup can be previewed without editing global config

## Phase 2: Service-Agent Retention Policy

Status: in progress.

Purpose: define sane defaults for high-volume service agents without harming normal chat agents.

Scope:

- choose per-agent `session.maintenance` settings for `odollo-soylei` and `graphiti-agent`
- prefer count and age caps over ad hoc manual deletion
- keep the active run protected during cleanup
- document that background monitor and dispatch runs should use fresh bounded session keys

Initial target policy:

- service agents: keep the most recent 25-75 entries or 3-7 days, depending on service cadence
- interactive agents: keep broader defaults unless the operator opts in
- transcript archives: retain long enough for debugging recent failures, then prune by age or disk budget

Exit criteria:

- service-agent hot `sessions.json` files stay small enough that status/helper paths do not visibly stall
- retained session history still covers recent incidents and regressions
- policy is represented in config or documented operator runbook, not just chat

Current implementation:

- `agents.list[].sessionMaintenance` provides a per-agent retention override merged over global `session.maintenance`.
- Standard agent stores infer the agent id from `~/.openclaw/agents/<agentId>/sessions/sessions.json`, so normal Gateway writes and `openclaw sessions cleanup --agent <id>` use the same per-agent policy.
- The local target policy for `odollo-soylei` and `graphiti-agent` is currently `mode: "enforce"`, `maxEntries: 75`, and `pruneAfter: "7d"`.
- Disk-budget settings are intentionally deferred until Phase 4 because current disk-budget cleanup removes session entries/artifacts directly after orphan cleanup rather than producing manifest-backed archive evidence first.

## Phase 3: Core Hot-Path Guardrails

Status: partially started.

Purpose: prevent Gateway health, status, and helper RPC paths from depending on expensive session-store scans.

Already started:

- `gateway status --deep --require-rpc` should verify cheap read reachability instead of full `status`
- probe-only status should be able to skip heavyweight session/task/channel sections
- gateway-bindable plugin/tool registry reuse should avoid repeated plugin materialization for embedded service runs

Remaining scope:

- audit other helper/status paths for accidental all-agent session scans
- make slow helper logs identify the exact method and store path when a scan is expensive
- ensure dashboards and `/status` can choose rich status intentionally while liveness checks stay cheap

Validation:

```bash
pnpm test src/cli/daemon-cli/probe.test.ts src/gateway/probe.test.ts
pnpm test src/commands/status.summary.test.ts src/gateway/server-methods/server-methods.test.ts
pnpm build
openclaw gateway status --deep --require-rpc
```

Exit criteria:

- liveness and helper probes stay subsecond on a warm Gateway
- rich status remains available when explicitly requested
- logs make future regressions attributable to a specific method or store

## Phase 4: Archive-First Maintenance Hardening

Status: in progress.

Purpose: make cleanup safe enough to run routinely for service agents.

Scope:

- verify or add manifest-backed archive evidence for removed session entries and transcript artifacts
- add a targeted report mode that ranks stores by size, entry count, and largest rows
- make dry-run output useful for deciding whether to enforce cleanup
- protect active keys by default when invoked from a live Gateway context

Potential command shape:

```bash
openclaw sessions cleanup --agent odollo-soylei --dry-run --json
openclaw sessions cleanup --agent odollo-soylei --enforce --active-key <key>
openclaw sessions report --all-agents --json
```

Exit criteria:

- cleanup can be run by an operator without guessing which files were touched
- archive or manifest evidence exists for destructive actions
- post-cleanup `openclaw gateway status --deep --require-rpc` remains green

Current implementation:

- `openclaw sessions report` provides the first read-only artifact report surface.
- Reports classify session-directory files as store, referenced transcript, referenced trajectory, referenced checkpoint, orphan transcript, orphan trajectory, orphan checkpoint, orphan temp store, archive, or other.
- Reports include total bytes, file counts, category totals, and largest files so operators can see disk pressure before enabling mutating disk-budget cleanup.
- `openclaw sessions cleanup --archive-artifacts` adds the first manifest-backed artifact archive path for `orphan-temp-store`, `orphan-trajectory`, and `archive` files.
- Artifact archive cleanup defaults to dry-run previews in the operator workflow; enforcement moves files under `.artifact-cleanup-archive/<run>/files/` and records `manifest.json` with source path, archived path, category, size, and status.
- Artifact archive cleanup is bounded by default to 100 files per run; operators can override with `--max-artifacts`.
- `openclaw sessions archive list/show/prune` makes archive runs inspectable and removable after evidence has been recorded.
- `.artifact-cleanup-archive/` is git-ignored so repo-local session-store maintenance cannot accidentally stage generated archive payloads.

## Phase 5: Optional Plugin Or Observability Layer

Status: deferred.

Purpose: decide whether a plugin adds value after core hot paths and cleanup are stable.

A plugin may be useful for:

- scheduled reporting of large session stores
- Prometheus/OpenTelemetry metrics around store size and cleanup results
- operator alerts when service-agent stores cross thresholds

A plugin should not own:

- core session-store layout
- Gateway liveness semantics
- mandatory cleanup safety rules

Exit criteria:

- plugin work is only opened if core cleanup exists and the remaining need is reporting, scheduling, or external observability

## Definition Of Done

- `odollo-soylei` and `graphiti-agent` hot session stores are reduced or bounded by a documented retention policy.
- Gateway liveness and helper probes do not use rich status as their success condition.
- Operators have a dry-run-first maintenance workflow with clear evidence.
- Tests cover the cheap-probe and cleanup/report paths that protect service responsiveness.
- Any live patch is installed from a packed tarball and validated with `openclaw gateway status --deep --require-rpc`.
