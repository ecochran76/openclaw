State: CLOSED
Created: 2026-07-16
Closed: 2026-07-16

# Reply-Payload Metadata Global Singleton

## Current State

Before this plan, `src/auto-reply/reply-payload.ts` stored fallback metadata in
a module-local weak map. Frozen or non-extensible payloads cannot carry the
symbol property, so metadata disappeared when another runtime chunk loaded a
separate module copy.

Execution owner: dedicated subagent for Plan 0022.

The fallback metadata store now uses a process-global weak-map singleton keyed
by `Symbol.for("openclaw.replyPayloadMetadata.store")`. The existing payload
symbol remains the fast cross-copy path for extensible objects, while frozen
and proxy payloads now share the same fallback owner across runtime chunks.

## Scope

- Move fallback reply-payload metadata to a process-global weak-map singleton.
- Match the existing command-session metadata singleton convention.
- Prove frozen payload metadata survives isolated module copies.

## Non-Goals

- Changing payload serialization, enumerable fields, or mutable-payload symbol
  behavior.
- Combining unrelated metadata registries.

## Work Phases

1. Compare reply-payload metadata with the established command-session
   singleton implementation.
2. Introduce a stable `Symbol.for` singleton key and typed weak-map owner.
3. Add mutable, frozen, and split-module regression coverage.
4. Run focused reply-payload tests and `git diff --check`.

## Acceptance Criteria

- Frozen payload metadata survives access through another module copy.
- Mutable payload behavior and metadata invisibility remain unchanged.
- Focused regression tests pass.

## Definition Of Done

The plan is `CLOSED`, its subagent records exact proof, and no unrelated payload
contract changes.

## Closeout Receipts

- `src/auto-reply/reply-payload.ts` resolves the fallback weak map through
  `resolveGlobalSingleton`, following the command-session metadata convention.
- `src/auto-reply/reply-payload.test.ts` proves a frozen payload can be written
  and read through separately loaded module copies, while mutable metadata stays
  outside enumerable payload fields.
- `node scripts/run-vitest.mjs src/auto-reply/reply-payload.test.ts`: passed,
  1 file and 7 tests.
- `./node_modules/.bin/oxfmt --write src/auto-reply/reply-payload.ts
src/auto-reply/reply-payload.test.ts`: passed.
- `./node_modules/.bin/oxlint src/auto-reply/reply-payload.ts
src/auto-reply/reply-payload.test.ts`: passed with no findings.
- `git diff --check -- src/auto-reply/reply-payload.ts
src/auto-reply/reply-payload.test.ts
docs/dev/plans/0022-2026-07-16-reply-payload-metadata-singleton.md`: passed.
- Scoped autoreview received one 3,677-byte synthetic-commit bundle containing
  only the two implementation files. The Codex reviewer returned no result and
  was stopped after eight minutes of bounded waiting; it was not restarted.
- The repository oxlint wrapper did not reach this slice because shared-checkout
  TypeScript errors in `src/auto-reply/reply/dispatch-from-config.ts` blocked its
  plugin-SDK boundary preparation. Direct scoped oxlint passed as recorded above.
