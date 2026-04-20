# Policy Layer And Planning Convention Adoption

Date: 2026-04-20

## Context

`ec-main` adopted a repo-local policy layer from the shared `agent-policies` library, then added Graphiti and plugin-survivability guidance.

The initial policy install created local policy files under `docs/dev/policies/` and a plugin survivability roadmap under `docs/dev/`. Follow-up review identified that the repo should start following the selector's plan, note, and memory conventions more strictly.

## Decision

Use these canonical continuity directories going forward:

- `ROADMAP.md` for the top-level serialized plan index.
- `RUNBOOK.md` for dated execution and planning-contract events.
- `docs/dev/plans/` for bounded active plans.
- `docs/dev/notes/` for dated observations, adoption feedback, rebase lessons, and migration findings.
- `docs/dev/memories/` for stable durable repo context.

New files in those directories should use deterministic serial-plus-date filenames:

```text
NNNN-YYYY-MM-DD-slug.md
```

The first active migrated plan is:

- `docs/dev/plans/0001-2026-04-20-plugin-survivability-roadmap.md`

## Reusable Lesson

The repo still has many legacy `docs/dev/*.md` planning documents. Do not mechanically migrate all of them. Migrate active or touched plans when doing so improves discoverability, and update inbound links in the same slice.
