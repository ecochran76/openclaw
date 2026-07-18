State: CLOSED
Created: 2026-07-16
Closed: 2026-07-16

# Cross-Agent Selector Authorization Ordering

## Current State

Cross-agent session tools resolve target selectors before establishing that the
caller may inspect the target agent. Resolution success and failure can leak
target existence across the visibility boundary.

Execution owner: dedicated subagent for Plan 0019.

## Scope

- Put authorization before cross-agent selector resolution for every affected
  session tool caller.
- Reuse the canonical visibility/approval contract.
- Add sibling-tool regressions for hidden versus nonexistent selectors.

## Non-Goals

- Changing same-agent selector behavior or gateway resolution semantics.
- Reopening the `sessions_list` row-query fix owned by Plan 0018.

## Work Phases

1. Trace selector resolution callers and the shared authorization boundary.
2. Introduce one canonical pre-resolution authorization step.
3. Migrate affected session tools and add focused sibling coverage.
4. Run the affected sessions tool tests and `git diff --check`.

## Acceptance Criteria

- No cross-agent selector is resolved before authorization.
- Hidden and nonexistent targets are observationally equivalent.
- Same-agent and approved cross-agent behavior remains unchanged.

## Definition Of Done

The plan is `CLOSED`, all affected callers are enumerated with proof, and its
subagent changes no unrelated session policy.

## Execution Result

The selector authorization boundary is now decided before an explicit
cross-agent lookup:

- `all` visibility preserves the existing authorized global lookup;
- `tree` visibility passes the requester session as `spawnedBy`, so Gateway
  label/search resolution can match only requester-owned children;
- `self` and `agent` visibility produce the canonical visibility denial before
  calling `sessions.resolve`.

The A2A enabled/allow check still precedes the visibility decision. Same-agent
selectors remain unrestricted, and the post-resolution visibility guard still
validates the concrete resolved session.

## Caller Inventory

`resolveSessionReference` has five production callers:

1. `src/agents/tools/sessions-history-tool.ts` resolves only an explicit
   session key or session ID.
2. `src/agents/tools/sessions-search-tool.ts` resolves only its optional
   explicit session key or session ID before transcript search.
3. `src/agents/tools/session-status-tool.ts` uses it only as the session-ID
   fallback after requester-store lookup.
4. `src/agents/tools/sessions-tool.ts` resolves only the explicit patch target.
5. `src/agents/tools/sessions-send-tool.ts` resolves explicit keys/session IDs
   and is also the sole caller that sends label/search/agent selector fields to
   `sessions.resolve`.

Therefore only `sessions_send` required selector-call migration. The shared
decision lives in `src/agents/tools/sessions-resolution.ts`; the other four
callers retain their existing direct-reference behavior.

Gateway contract proof: `src/gateway/sessions-resolve.ts` applies `spawnedBy`
to both label listing and advanced selector listing before choosing a match.

## Validation Receipts

- `./node_modules/.bin/oxfmt --check src/agents/tools/sessions-resolution.ts src/agents/tools/sessions-resolution.test.ts src/agents/tools/sessions-send-tool.ts src/agents/tools/sessions-helpers.ts src/agents/tools/sessions.test.ts`
  - passed; all five files already used repository formatting.
- `node scripts/run-vitest.mjs src/agents/tools/sessions-resolution.test.ts src/agents/tools/sessions.test.ts`
  - passed; 2 files and 92 tests.
- `git diff --check -- src/agents/tools/sessions-resolution.ts src/agents/tools/sessions-resolution.test.ts src/agents/tools/sessions-send-tool.ts src/agents/tools/sessions-helpers.ts src/agents/tools/sessions.test.ts docs/dev/plans/0019-2026-07-16-cross-agent-selector-authorization.md`
  - passed.

Focused regressions prove that a hidden cross-agent selector and a nonexistent
selector produce the same response under tree visibility, that the gateway
lookup is requester-scoped, and that an approved requester-owned cross-agent
child still resolves and dispatches. Pure helper coverage also locks same-agent,
`all`, `tree`, `self`, and `agent` decisions.
