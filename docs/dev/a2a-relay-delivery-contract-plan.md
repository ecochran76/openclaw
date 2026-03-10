# A2A Relay Delivery Contract Plan

Status: proposed (implementation-ready)
Owner: dev-openclaw
Branch baseline: `ec-main`

## Why this plan exists

The current A2A `sessions_send` flow is already useful:

- cross-agent access is gated
- ingress echo can post to the target channel
- relay can mirror turns to one or both channels
- ping-pong is bounded
- nested `sessions_send` chains are guarded

But the delivery contract is still uneven.

In particular, `session.agentToAgent.relay.requireDelivery` is exposed in config and docs, but the current relay path does not enforce it. Relay failures are logged and ignored. That makes relay delivery policy look stricter on paper than it is in runtime behavior.

This plan closes that gap and makes relay delivery a first-class, inspectable part of the A2A result.

## Branching / integration constraints

This repo uses the rebase-friendly branch model documented in:

- `docs/dev/rebase-friendly-branching-playbook.md`

Rules this plan assumes:

- `ec-main` is the canonical integration branch.
- New feature work should branch from `ec-main`.
- Keep commits small and topic-scoped.
- If this lands in slices, integrate via `cherry-pick -x` into `ec-main`.
- Do not invent a parallel long-lived integration branch for this work.

Recommended working branch for implementation:

- `feat/a2a-relay-delivery-contract`

## Current behavior summary

### What is already implemented

In `sessions_send`, the current A2A flow includes:

- cross-agent gating via `tools.agentToAgent.enabled` and `tools.agentToAgent.allow`
- visibility gating via `tools.sessions.visibility`
- ingress echo via `session.agentToAgent.ingressEcho.*`
- nested relay guard via `session.agentToAgent.guard.allowNestedSessionsSend`
- relay config via `session.agentToAgent.relay.*`
- bounded ping-pong via `session.agentToAgent.maxPingPongTurns`
- post-run announce behavior

Primary implementation files:

- `src/agents/tools/sessions-send-tool.ts`
- `src/agents/tools/sessions-send-tool.a2a.ts`
- `src/agents/tools/sessions-send-helpers.ts`
- `src/agents/tools/sessions-access.ts`
- `src/config/schema.help.ts`

### What is missing

1. `relay.requireDelivery` is parsed but not enforced.
2. Relay result metadata is too shallow to explain what actually happened.
3. Relay status semantics are weaker than ingress echo semantics.
4. Best-effort vs strict delivery behavior is not coherent across ingress echo, relay, and announce.
5. There is no strong end-to-end result contract for partial relay success in dual-channel mode.

## Goal

Make relay delivery behavior explicit, enforceable, and inspectable.

Definition of success:

1. `session.agentToAgent.relay.requireDelivery` has real runtime effect.
2. Relay outcomes are returned in structured result metadata.
3. Relay status language aligns with ingress echo status language where practical.
4. Dual-channel partial failure is represented clearly.
5. Tests cover best-effort and strict modes.
6. Backward compatibility is preserved when relay is disabled or left in best-effort mode.

## Non-goals

This slice should **not** try to redesign all of A2A.

Not in scope for the first implementation slice:

- a new transport model for agent-to-agent messaging
- channel-specific rich UI formatting
- thread-binding/session-binding redesign
- per-provider custom delivery semantics beyond existing gateway send behavior
- replacing announce flow with a larger conversation-state machine

## Proposed design

## 1) Define relay result semantics

Add a structured relay result object that mirrors the maturity of `ingressEcho`.

Suggested top-level shape in `sessions_send` results:

```json
{
  "relay": {
    "status": "disabled | not_applicable | sent | partial | failed | blocked | pending",
    "mode": "target-only | dual-channel",
    "mirrorTurns": "round1 | all",
    "targets": [
      {
        "role": "source | target",
        "channel": "slack",
        "to": "channel:C123",
        "threadId": "optional",
        "status": "sent | failed | blocked | skipped",
        "messageId": "optional",
        "error": "optional"
      }
    ]
  }
}
```

Notes:

- `disabled`: relay feature off by config
- `not_applicable`: relay enabled but no relay work was attempted
- `sent`: all required relay deliveries succeeded
- `partial`: at least one relay send succeeded and at least one failed/skipped in best-effort mode
- `failed`: relay was attempted and all required deliveries failed, or strict mode failed before continuation
- `blocked`: strict mode prevented continuation because required relay delivery could not be satisfied
- `pending`: async fire-and-forget path where final relay outcome is not yet known at return time

This keeps result semantics parallel to ingress echo without forcing byte-for-byte identical behavior.

## 2) Make `relay.requireDelivery` real

Current behavior in `sessions-send-tool.a2a.ts`:

- each relay send uses `callGateway({ method: "send" })`
- errors are caught
- failures are logged
- flow continues

Proposed behavior:

### Best-effort mode (`requireDelivery=false`)

- continue current behavior of attempting relay sends without blocking the whole flow
- record per-target failures in relay metadata
- final relay status can become `partial` or `failed`

### Strict mode (`requireDelivery=true`)

For each relay phase, identify required targets based on `relay.mode`:

- `target-only`: target relay target is required
- `dual-channel`: both source and target relay targets are required

If a required relay target cannot be resolved or delivery fails:

- mark relay as `blocked` or `failed`
- stop the remaining relay phase work for that step
- do not silently downgrade to log-only behavior

Recommended behavior split:

#### Synchronous path (`timeoutSeconds > 0`)

- if a required round-1 relay fails before tool return, return an error result for the tool call
- include structured `relay` metadata in the error result

#### Fire-and-forget path (`timeoutSeconds === 0`)

- if failure happens before immediate return, return `accepted` only if the agent run itself was accepted **and** no strict relay failure has already been observed
- if strict relay failure is observed in the background after return, log it and surface it in runtime events if available, but do not try to retroactively change the already-returned tool result

This keeps sync mode honest while respecting the existing async contract.

## 3) Return richer relay metadata from the A2A flow

Today, the `sessions_send` tool seeds a lightweight relay object before the async A2A flow actually performs sends.

That needs a small refactor.

Recommended approach:

- move relay execution into a helper that returns a structured `RelayAttemptResult`
- use that helper for:
  - initial requester -> target relay
  - round-1 reply relay
  - ping-pong relay turns when `mirrorTurns=all`
- aggregate per-target/per-turn results into a summarized relay outcome object

Possible internal types:

```ts
type RelayTargetResult = {
  role: "source" | "target";
  channel?: string;
  to?: string;
  threadId?: string;
  status: "sent" | "failed" | "blocked" | "skipped";
  messageId?: string;
  error?: string;
};

type RelayAttemptResult = {
  status: "sent" | "partial" | "failed" | "blocked" | "not_applicable";
  targets: RelayTargetResult[];
  requiredFailure?: boolean;
};
```

## 4) Keep announce behavior separate

Do **not** fold announce semantics into relay semantics in this slice.

Treat them as distinct:

- ingress echo = pre-run target-channel echo
- relay = mirror actual conversational turns
- announce = optional post-run summary/final note

That separation keeps this change tractable.

However, relay strictness should not be undermined by announce being best-effort.

Recommendation:

- strict relay enforcement should apply only to relay sends
- announce can remain best-effort in this slice
- dual-channel mode should keep current duplicate-suppression behavior for announce

## 5) Normalize status language with ingress echo

Ingress echo already uses statuses like:

- `sent`
- `failed`
- `blocked`
- `not_applicable`
- `disabled`

Relay should use the same family, with one additive status:

- `partial`

That gives operators one mental model for A2A delivery outcomes.

## Behavior matrix

## Relay disabled

- config: `relay.enabled=false`
- result: `relay.status="disabled"`
- no relay sends attempted
- existing behavior preserved

## Target-only, best-effort, target succeeds

- result: `relay.status="sent"`
- one target result with `status="sent"`

## Target-only, best-effort, target fails

- result: `relay.status="failed"`
- tool can still succeed if the agent run succeeds

## Dual-channel, best-effort, one succeeds and one fails

- result: `relay.status="partial"`
- per-target statuses show which side failed
- tool can still succeed if the agent run succeeds

## Dual-channel, best-effort, both fail

- result: `relay.status="failed"`
- tool can still succeed if the agent run succeeds

## Target-only, strict, target missing or failed

- result: `relay.status="blocked"` or `"failed"`
- synchronous path should return tool error

## Dual-channel, strict, either required target missing or failed

- result: `relay.status="blocked"` or `"failed"`
- synchronous path should return tool error

## File touchpoints

Primary code files:

- `src/agents/tools/sessions-send-tool.ts`
- `src/agents/tools/sessions-send-tool.a2a.ts`
- `src/agents/tools/sessions-send-helpers.ts`

Possible supporting files:

- `src/agents/tools/sessions.test.ts`
- `src/gateway/server.sessions-send.test.ts`

Docs/config references if behavior wording changes:

- `src/config/schema.help.ts`
- `src/config/schema.labels.ts`
- `docs/concepts/session-tool.md`
- `docs/gateway/configuration-reference.md`

## Implementation slices

## Slice 1: strict relay enforcement + result contract

Deliverables:

- enforce `relay.requireDelivery`
- return structured relay result metadata for round-1 sends
- cover sync and async baseline behaviors
- update docs/help text if semantics change materially

Why first:

- finishes an already-exposed config knob
- provides immediate operator value
- keeps blast radius contained

## Slice 2: extend metadata across ping-pong turns

Deliverables:

- include aggregated per-turn relay outcomes when `mirrorTurns=all`
- keep summary concise in tool result while preserving debug detail internally if needed

## Slice 3: optional announce strictness discussion

Only if later desired:

- decide whether announce should gain its own strictness semantics
- do not couple this to Slice 1 unless required by tests or UX review

## Test plan

### Unit / tool tests

1. **Relay disabled**
   - returns `relay.status="disabled"`
   - no relay sends attempted

2. **Target-only success**
   - relay result shows `sent`
   - target metadata populated

3. **Dual-channel partial success**
   - source succeeds, target fails
   - relay result shows `partial`

4. **Dual-channel all fail, best-effort**
   - relay result shows `failed`
   - tool result can still be `ok` if agent run succeeds

5. **Strict target-only failure**
   - unresolved/failing target blocks or fails relay
   - sync tool result returns error with relay metadata

6. **Strict dual-channel failure**
   - one side fails in `dual-channel`
   - sync tool result returns error with per-target detail

7. **Fire-and-forget accepted path**
   - immediate return remains `accepted` when no strict relay failure has been observed yet

8. **Backward compatibility**
   - ingress echo behavior unchanged
   - nested relay guard behavior unchanged
   - announce suppression in `dual-channel` unchanged

### Gateway loopback / e2e

Add or extend tests to cover:

- sync `sessions_send` with strict relay success
- sync `sessions_send` with strict relay failure
- label-based target resolution with relay enabled

## Open questions

1. In strict mode, should an unresolved source target in `dual-channel` be treated identically to a delivery failure?
   - Recommended: yes.

2. Should strict relay failure abort only relay work, or the whole `sessions_send` sync result?
   - Recommended: fail the whole sync result.

3. Should async background strict relay failures emit structured agent events?
   - Recommended: eventually yes, but not required for Slice 1.

4. How much relay detail should be exposed in normal tool results vs debug logs?
   - Recommended: concise summary + per-target status, not per-turn transcript duplication.

## Recommended first commit breakdown

If implementing on a feature branch, keep commits topic-scoped:

1. **types/helpers**
   - relay result types and helper refactor
2. **runtime enforcement**
   - implement strict relay delivery behavior
3. **tests**
   - add/adjust unit and gateway tests
4. **docs**
   - update config/reference wording if needed

This matches the repo’s `ec-main` integration model and makes later `cherry-pick -x` straightforward.

## Short recommendation

The next implementation slice should be:

- make `session.agentToAgent.relay.requireDelivery` real
- return structured relay status metadata
- align relay status semantics with ingress echo
- add tests for best-effort vs strict behavior

That is the cleanest way to finish the A2A relay control surface that already exists today.
