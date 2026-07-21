# Graph-Backed Memory Policy

This policy adapts the shared `graph-backed-memory-usage` module for the `ec-main` OpenClaw branch.

## Authority Model

- Treat tracked repo files as authoritative for product, branch, and architecture truth.
- Use Graphiti as advisory operator memory for compact, durable, retrievable facts.
- If Graphiti memory conflicts with `AGENTS.md`, `docs/dev/policies/*`, `docs/dev/local-feature-index.md`, feature docs, runbooks, or commits, trust the tracked repo source first and update or ignore the stale memory.
- Do not use Graphiti as a replacement for plans, runbooks, feature indexes, policy files, or commit history.

## When To Read Memory

- Before re-asking the user about likely durable context, run a bounded Graphiti read.
- Read memory when investigating recurring operator issues such as auth profile confusion, gateway instability, Slack agent identity, live patch habits, or repeated rebase conflicts.
- Read memory when a task depends on user preferences that may have been established outside the current chat.
- Keep memory reads bounded to the current repo or operational domain; do not treat unrelated project memories as relevant without evidence.

## When To Write Memory

- Write compact durable facts that future sessions should retrieve quickly:
  - user workflow preferences
  - `ec-main` operator conventions
  - recurring rebase or live-patch gotchas
  - stable profile/auth expectations
  - known fragile local feature seams
  - durable relationships between local features, agents, plugins, or runtime services
- Prefer one well-scoped memory over many near-duplicate entries.
- If a durable fact changes, record the new state directly rather than narrating every intermediate turn.
- Keep long-form rationale, dated lessons, and handoff detail in tracked notes, memory docs, plans, or policy files instead of Graphiti.

## What Not To Store

- Do not store secrets, tokens, refresh tokens, passwords, private keys, raw OAuth payloads, or credential material.
- Do not store raw command output unless it is summarized into a durable incident fact.
- Do not store transient debug state, one-off errors, speculative reasoning, or every-turn progress.
- Do not store facts that are already cheaply and deterministically available from git unless the memory adds a useful cross-session retrieval cue.

## Partitioning

- Use a repo/domain-specific group or namespace for OpenClaw `ec-main` operator facts when the Graphiti tool call supports it.
- Preferred group id: `openclaw_ec_main`.
- Do not create a parallel `openclaw-ec-main` group; older references to that hyphenated name should be treated as stale policy text and normalized to `openclaw_ec_main`.
- Use narrower group ids only when isolation matters, such as tenant/profile-specific runtime facts.
- Do not mix unrelated repos, tenants, or personal workflows into the `openclaw_ec_main` group.

## Maintenance

- Verify Graphiti health before debugging against memory availability or assuming memory writes persisted.
- Treat destructive memory operations as explicit cleanup or repair tasks, not normal day-to-day workflow.
- If a memory is stale but harmless, prefer writing the corrected durable fact over deleting history.
- If a memory contains sensitive material or actively misleading facts, clean it up deliberately and record the cleanup in a tracked note or policy feedback file when relevant.
