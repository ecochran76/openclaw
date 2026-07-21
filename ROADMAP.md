# OpenClaw `ec-main` Roadmap

This roadmap is the top-level index for serialized `ec-main` plans. Detailed active plans live under `docs/dev/plans/`.

## P01 | Plugin Survivability

State: COMPLETE

Current State: `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md` is closed with all five phases implemented. The surviving feature families and their focused rebase gates are indexed in `docs/dev/local-feature-index.md`; P07 owns the current upstream replay.

## P02 | OpenClaw Agent Skill Catalog

State: OPEN

Current State: `docs/dev/plans/0002-2026-04-26-openclaw-agent-skill-catalog.md` tracks repo-local skills that make Codex agents better at recurring OpenClaw operator workflows. The first implementation slice adds gateway operation, auth profile debugging, and local feature preservation skills.

## P03 | OpenClaw Agent Skill Catalog Batch 2

State: OPEN

Current State: `docs/dev/plans/0003-2026-04-26-openclaw-agent-skill-catalog-batch-2.md` tracks the second skill batch for automation maintenance, Slack runtime debugging, agent bootstrap diagnostics, and plugin survivability decisions.

## Slack Reliability Sequence

P04 and P05 are ordered milestones. Socket Mode hardening comes first because
the live receiver should use Slack's lifecycle, ack, refresh, and redundancy
contracts correctly. Active reconciliation follows as the durable correctness
path that compares OpenClaw admission state with Slack history and recovers
missed messages when configured.

## P04 | Slack Socket Mode Hardening

State: COMPLETE

Current State: `docs/dev/plans/0011-2026-05-30-slack-socket-mode-hardening.md` completed the first Slack reliability milestone. Socket Mode remains the low-latency receiver, now hardened around ack timing, active-state health, proactive refresh handling, optional multi-connection receivers, ping/pong profiles, and live SoyLei proof.

The next Slack reliability slice is P05 active reconciliation.

## P05 | Slack Active Reconciliation

State: COMPLETE

Current State: `docs/dev/plans/0010-2026-05-30-slack-history-reconciliation-receiver.md` completed the durable Slack history reconciliation milestone. OpenClaw now has a Slack history correctness path alongside Socket Mode: dry-run/replay reconciliation, status, watchdog/why-silent operator surfaces, focused tests, and live SoyLei recovery proof are present as of 2026-05-31.

SoyLei is live-patched with reconciliation enabled and `autoRecover: true`.

## P06 | Profile Support Retirement

State: COMPLETE

Current State: `docs/dev/plans/0014-2026-06-28-profile-support-retirement.md` is closed after reducing the profile delta to a thin local operator UX/policy layer over upstream native auth-profile storage, CLI auth commands, ordering, rotation, and doctor migration.

## P07 | ec-main Upstream Refresh

State: COMPLETE

Current State: Plan 0016 is cancelled after its combined replay/review loop
drifted. Plan 0023 Version 7,
`docs/dev/plans/0023-2026-07-16-ec-main-recovery-integration-and-publication.md`,
now owns an upstream-first refresh: accept current upstream as the tested
baseline, retain only documented downstream features that upstream does not
provide, validate only that minimal delta and its direct seams, skip broad
upstream-owned suites, then publish, patch live, and collect runtime proof.
Version 7 closes the upstream-first refresh at two proven commits: thin
profile commands and the plugin-owned buffered voice transcription bridge.
The usage-policy reconstruction, conditional A2A approval seam, and turn/token
automation controller are deferred because they did not fit the bounded thin-
seam rule. It also closes upstream-owned Slack responsiveness, routing,
lifecycle, discovery, and compatibility stacks as `DROP`, preventing further
historical packet or parity work. `ec-main` and `fork/ec-main` now match
`711d5ea3794`; OpenClaw `2026.7.2 (711d5ea)` is installed; the gateway RPC
probe is admin-capable; the matching Codex plugin is loaded; and the matching
Voice Call package is installed disabled with its buffered transcription
runtime verified. Unpublished upstream plugin-version drift and the bounded
live SDK export overlay are recorded follow-ups, not rebase blockers.

## P08 | ec-main Drift Recovery Blockers

State: COMPLETE

Current State: Plans 0017 through 0022 are closed. Each validated blocker from
the Plan 0016 drift-containment audit was executed by a dedicated subagent with
path-scoped edits and focused regression proof. Their integrated state is
preserved by the six-blocker recovery ref; successor Plan 0023 consumes it.
