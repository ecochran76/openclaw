State: CLOSED
Created: 2026-07-16

# sessions_list Pre-Authorization Oracle

## Current State

`src/agents/tools/sessions-list-tool.ts` sends an explicit `agentId` to the
gateway before applying the session-visibility checker. Empty versus denied
results can reveal whether a hidden agent has rows.

Execution owner: dedicated subagent for Plan 0018.

## Scope

- Authorize explicit cross-agent scope before any agent-filtered row lookup.
- Preserve approval behavior for authorized or approval-eligible requests.
- Add regression coverage that cannot distinguish absent from hidden rows.

## Non-Goals

- Redesigning session visibility policy or gateway list semantics.
- Changing selector resolution owned by Plan 0019.

## Work Phases

1. Map the tool entry point, visibility checker, gateway call, and approval
   result boundary.
2. Move authorization ahead of the agent-filtered lookup without duplicating
   policy.
3. Add focused absent/hidden/authorized tests.
4. Run the focused sessions-list tests and `git diff --check` for owned paths.

## Acceptance Criteria

- Unauthorized callers trigger no hidden-agent row lookup.
- Hidden and nonexistent agents are observationally equivalent.
- Existing authorized and approval flows remain covered and pass.

## Definition Of Done

The plan is `CLOSED`, its subagent records exact source/test proof, and Plan
0019's selector surface remains untouched.

## Completion | 2026-07-16

- `src/agents/tools/sessions-list-tool.ts` now constructs the existing row
  visibility checker before dispatch and applies it to an explicit cross-agent
  scope before calling `sessions.list`. Denials reuse the existing durable
  approval result builder, so no hidden-agent store lookup occurs.
- `src/agents/tools/sessions-list-tool.test.ts` covers absent and hidden target
  stores with the same pre-lookup approval and proves the gateway is not called.
  It also proves an authorized explicit scope performs one gateway lookup and
  returns the target row.
- Focused proof:
  `node scripts/run-vitest.mjs src/agents/tools/sessions-list-tool.test.ts`
  passed 13 tests in one agents shard.
- Hygiene proof:
  `git diff --check -- src/agents/tools/sessions-list-tool.ts src/agents/tools/sessions-list-tool.test.ts docs/dev/plans/0018-2026-07-16-sessions-list-preauthorization-oracle.md`
  passed.
- Plan 0019 selector-resolution files were not changed.
