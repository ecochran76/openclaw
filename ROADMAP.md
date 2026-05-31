# OpenClaw `ec-main` Roadmap

This roadmap is the top-level index for serialized `ec-main` plans. Detailed active plans live under `docs/dev/plans/`.

## P01 | Plugin Survivability

State: OPEN

Current State: `ec-main` carries local feature families that must survive frequent rebases onto upstream OpenClaw. The current active plan is `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md`; Phases 1 and 2 are implemented.

The next implementation slice is the automation command/status seam.

## P02 | OpenClaw Agent Skill Catalog

State: OPEN

Current State: `docs/dev/plans/0002-2026-04-26-openclaw-agent-skill-catalog.md` tracks repo-local skills that make Codex agents better at recurring OpenClaw operator workflows. The first implementation slice adds gateway operation, auth profile debugging, and local feature preservation skills.

## P03 | OpenClaw Agent Skill Catalog Batch 2

State: OPEN

Current State: `docs/dev/plans/0003-2026-04-26-openclaw-agent-skill-catalog-batch-2.md` tracks the second skill batch for automation maintenance, Slack runtime debugging, agent bootstrap diagnostics, and plugin survivability decisions.

## P04 | Slack Socket Mode Hardening

State: COMPLETE

Current State: `docs/dev/plans/0011-2026-05-30-slack-socket-mode-hardening.md` completed the first Slack reliability milestone. Socket Mode remains the low-latency receiver, now hardened around ack timing, active-state health, proactive refresh handling, optional multi-connection receivers, ping/pong profiles, and live SoyLei proof.

The next Slack reliability slice is P05 active reconciliation.

## P05 | Slack Active Reconciliation

State: OPEN

Current State: `docs/dev/plans/0010-2026-05-30-slack-history-reconciliation-receiver.md` tracks the durable Slack history reconciliation milestone. This is the second receiver path that catches missed mentions/messages after Socket Mode hardening, using checkpointed `conversations.history` / `conversations.replies`, candidate classification, idempotent replay, scheduling, status, and live proof.

The next implementation slice is dry-run reconciliation state, fetch, and candidate classification.
