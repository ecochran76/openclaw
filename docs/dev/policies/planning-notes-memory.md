# Planning, Notes, And Memory Conventions

This policy adapts the shared `planning-discipline` and `notes-and-memories` modules for the `ec-main` OpenClaw branch.

## Canonical Directories

- Actionable bounded plans live under `docs/dev/plans/`.
- Dated observations, lessons, migration notes, and policy adoption notes live under `docs/dev/notes/`.
- Stable durable repo memories live under `docs/dev/memories/`.
- Long-lived feature docs may remain under `docs/dev/local-features/`.
- Legacy `docs/dev/*.md` plans may remain in place until deliberately migrated; new bounded plans should use `docs/dev/plans/`.

## Filename Convention

- Use deterministic serial-plus-date filenames:

```text
NNNN-YYYY-MM-DD-slug.md
```

- Use four digits for the serial.
- Use the local calendar date for the date stamp.
- Use lowercase hyphenated slugs.
- Allocate the next serial by inspecting existing files in the target directory.
- Keep serials independent per directory: plans, notes, and memories each have their own sequence.

## Plan Contract

Each new bounded plan should include:

- `State:` with a fixed value such as `PLANNED`, `OPEN`, `CLOSED`, or `CANCELLED`.
- `Created:` with the local date.
- `Current State` for `OPEN` plans.
- scope and non-goals.
- ordered work phases or lanes.
- validation or acceptance criteria.
- definition of done.

Do not let a plan become an endless catchall. Close it or open a new serialized plan when the scope changes materially.

## Notes Contract

Use notes for dated observations tied to a slice or event, including:

- policy adoption feedback
- rebase lessons
- semantic mismatches
- migration findings
- live-operator fieldwork that should later be productized or retired

One well-scoped note is better than several overlapping notes about the same event.

## Memories Contract

Use repo memories for stable context future sessions should not rediscover, including:

- durable branch conventions
- recurring rebase gotchas
- long-lived feature ownership decisions
- validation entrypoints that are easy to forget

Keep richer narrative context in tracked memory docs. Use Graphiti for compact retrieval-oriented facts and relationships.

## Migration Discipline

- When moving an existing unnumbered plan into the new convention, preserve history through `git mv` where practical.
- Update inbound links in the same change.
- Do not migrate all legacy docs mechanically. Migrate only when a file is active, touched, or causing confusion.
- When the repo eventually adopts top-level `ROADMAP.md` and `RUNBOOK.md`, record that as a deliberate planning-contract migration rather than doing it opportunistically.
