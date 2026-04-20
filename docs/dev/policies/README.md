# OpenClaw Local Agent Policies

This directory contains the repo-local policy layer for the maintained `ec-main` branch.

These policies were adopted from the local `agent-policies` library as a custom composition rather than a direct starter profile. OpenClaw is primarily a product-engineering repo, but `ec-main` is also a downstream fork/integration branch with live operator workflows.

## Installed Policy Composition

- Source library: `/home/ecochran76/workspace.local/agent-policies`
- Selector skill: `/home/ecochran76/workspace.local/agent-policies/repo-policy-selector/SKILL.md`
- Base profile: `repo-product-engineering`
- Local overlays:
  - `upstream-fork-maintenance`
  - `runtime-vs-product-boundary`
  - `fieldwork-productization`
  - `multi-agent-reconciliation`
  - `subagent-workflow-optimization`
  - `graph-backed-memory-usage`
  - `planning-discipline`
  - `notes-and-memories`

## Policy Files

- `ec-main-integration.md`: branch, rebase, live-patch, and local feature preservation rules for `ec-main`.
- `architecture-and-plugin-survivability.md`: architecture guardrails for keeping local features rebase-friendly and plugin-oriented where appropriate.
- `planning-notes-memory.md`: serialized plan, note, and repo-memory conventions.
- `graph-backed-memory.md`: Graphiti-backed memory boundaries for durable operator context.
- `validation-and-handoff.md`: validation, closeout, and handoff expectations for local feature work.
- `policy-adoption-feedback.md`: notes from first policy installation and future update guidance.

## Read Triggers

Agents must read the relevant policy file at the start of any non-trivial turn that touches its scope.

- Rebase, live patch, branch surgery, or local feature preservation: read `ec-main-integration.md`.
- Plugin migration, core seam work, architecture changes, or feature survivability questions: read `architecture-and-plugin-survivability.md`.
- New plans, dated notes, repo memories, or continuity-artifact migration: read `planning-notes-memory.md`.
- Graphiti reads/writes, durable operator memory, or memory cleanup: read `graph-backed-memory.md`.
- Commit, push, test selection, release, live patch closeout, or handoff: read `validation-and-handoff.md`.
- Policy changes or policy friction: read `policy-adoption-feedback.md`.

These policies complement `AGENTS.md`; they do not replace repo-specific build, test, security, release, and scoped-guide rules.
