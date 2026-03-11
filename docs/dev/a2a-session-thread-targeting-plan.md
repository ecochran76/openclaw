# A2A Session/Thread Targeting Plan

Status: proposed (implementation-ready)
Owner: dev-openclaw
Branch baseline: `ec-main`

## Why this plan exists

The current A2A `sessions_send` work is already useful:

- ingress echo works
- relay works
- dual-channel round-1 mirroring works
- relay verbosity exists in runtime config
- live Slack validation confirmed compact relay text (`sender -> target`)

But the current model is still too **channel-centric** in a few key places.

Today, the system is good at:

- "send to this session key"
- "mirror this message to this channel target"

It is not yet first-class at:

- "find the agent bound to this channel"
- "continue that agent's most recent thread"
- "keep all A2A delivery pinned to that exact thread/session"
- "bound this A2A follow-up loop to a specific number of cycles for this request"

That gap matters for natural instructions like:

> tell the agent in `<#C0AG96MGJTV>` to continue the work in its most recent thread and then ask you for further instructions. You will respond with new instructions and ask for a report. Repeat for up 2 full cycles.

This plan is aimed directly at making that scenario work reliably.

---

## Current state summary

### Already landed

Under `session.agentToAgent` we already have:

- `ingressEcho.enabled`
- `ingressEcho.requireDelivery`
- `guard.allowNestedSessionsSend`
- `relay.enabled`
- `relay.mode`
- `relay.mirrorTurns`
- `relay.verbosity`
- `relay.requireDelivery`
- `maxPingPongTurns`

Relevant code/docs already in tree:

- `src/agents/tools/sessions-send-tool.ts`
- `src/agents/tools/sessions-send-tool.a2a.ts`
- `src/agents/tools/sessions-send-helpers.ts`
- `src/agents/tools/sessions-announce-target.ts`
- `src/gateway/sessions-resolve.ts`
- `src/gateway/protocol/schema/sessions.ts`
- `src/sessions/session-key-utils.ts`
- `docs/dev/a2a-dual-channel-relay-plan.md`
- `docs/dev/a2a-relay-delivery-contract-plan.md`

### What live validation confirmed

A live `dev-openclaw -> gpod` test showed:

- ingress echo delivered
- dual-channel relay delivered
- round-1 source and target mirroring worked
- compact relay text is live:
  - `dev-openclaw -> gpod`
  - `gpod -> dev-openclaw`
- the older `[A2A handoff:...]` full-payload format is no longer the default visible path

### What is still missing

#### 1) Relay verbosity is implemented, but not fully productized

`session.agentToAgent.relay.verbosity` already exists in:

- `src/config/zod-schema.session.ts`
- `src/config/schema.help.ts`
- `src/config/schema.labels.ts`

But user-facing docs are still uneven. The control surface exists in runtime/config help, but the end-user session tool docs do not explain it clearly enough.

#### 2) Session resolution is still too narrow

Current `sessions.resolve` supports only:

- `key`
- `sessionId`
- `label`

That is not enough for workflows driven by:

- channel binding
- delivery context
- thread preference
- recency selection

#### 3) Thread-aware routing support exists in lower layers, but is not preserved end-to-end

Important facts from current code:

- `DeliveryContext` already supports `threadId`
- session keys already encode `:thread:` / `:topic:` patterns
- A2A relay send code already accepts/passes `threadId`
- `resolveAnnounceTargetFromKey()` can recover thread info from session keys

But:

- `sessions_list` drops `threadId` from its public `deliveryContext`
- `resolveAnnounceTarget()` fallback currently returns mostly `channel + to + accountId`
- A2A targeting is still described mentally as "send to a channel" rather than "continue a concrete session with a concrete delivery target"

#### 4) Ping-pong limits are only globally configurable today

`session.agentToAgent.maxPingPongTurns` exists, but it is global config.

That is not precise enough for natural requests like:

> repeat for up to 2 full cycles

For that workflow, the requester needs **per-call** loop control, not just a global ceiling.

---

## Product goal

Make A2A first-class at **session-aware continuation**, not just channel mirroring.

### Definition of success

A requester agent should be able to reliably translate a natural instruction like:

> tell the agent in `<#C0AG96MGJTV>` to continue the work in its most recent thread and then ask you for further instructions. You will respond with new instructions and ask for a report. Repeat for up 2 full cycles.

into behavior that is deterministic and inspectable.

That means all of the following must work:

1. Resolve the agent bound to Slack channel `C0AG96MGJTV`
2. Find that agent's most recent eligible thread-bound session on that channel
3. Fall back predictably if no thread exists
4. Send into that exact session key
5. Preserve the target thread for ingress/relay/announce delivery
6. Keep follow-up turns bounded for this request
7. Return enough metadata to explain what was targeted and why

## Safety goal: bounded orchestration, not open-ended conversation drift

These workflows must be **cheap by default** and resistant to accidental infinite or high-cost loops.

For the purposes of this plan, "success" is **not** merely that the target agent keeps talking. Success means the system can support iterative instruction/report workflows while remaining strongly bounded in scope, target, and cost.

Required invariants:

1. **Single target resolution per handoff**
   - Resolve the target session/thread once at the start of the handoff.
   - Do **not** re-resolve "most recent thread" on every turn.
   - Once selected, the target session is pinned for the lifetime of that bounded A2A run.
2. **Per-call loop budget**
   - Multi-turn orchestration must use an explicit per-call turn budget.
   - Global config remains the hard ceiling; per-call settings may only reduce it.
3. **Per-call wall-clock budget**
   - Multi-turn orchestration should also have a bounded elapsed-time window so a slow turn cannot keep the workflow alive indefinitely.
4. **No implicit escalation of scope**
   - The run must not silently switch from one thread to another, one agent to another, or one channel-root to a different thread mid-loop.
5. **No recursive A2A fan-out by default**
   - Existing nested `sessions_send` guard remains the default.
   - The new orchestration workflow must not weaken that protection.
6. **Clear stop semantics**
   - When the turn/time budget is exhausted, the workflow stops and reports that it hit a guardrail instead of silently continuing.

---

## Non-goals

This plan does **not** try to:

- replace `sessions_send` with an entirely new transport
- build a full workflow engine or job graph for A2A
- add rich per-platform UI blocks for relay
- redesign thread bindings globally across all providers
- solve every possible natural-language targeting phrase in one pass

The goal is a clean, composable foundation.

---

## Proposed design

## Workstream A — Finish the A2A control surface

### A1. Treat relay verbosity as already-implemented runtime behavior

This is mostly a docs/productization slice, not a new runtime feature.

Current runtime behavior already supports:

- `none`
- `sender-message`
- `full-payload`

Current default is effectively:

- `sender-message`

### A2. Update user-facing docs so they match runtime reality

Required doc updates:

- `docs/concepts/session-tool.md`
- config reference docs where A2A relay is documented
- optionally cross-link from the existing A2A dev plans

The docs should clearly explain:

- relay vs ingress echo
- relay `mode`
- relay `mirrorTurns`
- relay `verbosity`
- relay `requireDelivery`
- that dual-channel suppresses the extra target announce step

### Acceptance criteria

- a reader can discover `relay.verbosity` without reading schema help
- docs reflect current runtime behavior exactly
- no drift between `schema.help.ts`, session-tool docs, and live behavior

---

## Workstream B — Introduce first-class session-aware target resolution

This is the core architectural change.

### Problem

Current `sessions.resolve` can find a session only by:

- exact key
- session id
- label

That is not enough for instructions framed around:

- a bound Slack/Discord/etc channel
- a thread selection rule like "most recent thread"
- an agent id constraint
- a delivery target constraint

### Proposed change

Extend session resolution so it can target by **delivery identity + thread policy**, not only explicit session identifiers.

### Proposed API shape

Either extend `sessions.resolve` or introduce a sibling method with a richer selector.

Recommended direction: extend `sessions.resolve` in a backward-compatible way.

Add optional selector fields such as:

```json
{
  "channel": "slack",
  "to": "channel:C0AG96MGJTV",
  "accountId": "default",
  "agentId": "gpod",
  "threadPolicy": "most-recent",
  "allowChannelRootFallback": true,
  "activeMinutes": 10080
}
```

Possible new selector fields:

- `channel?: string`
- `to?: string`
- `accountId?: string`
- `agentId?: string`
- `threadId?: string`
- `threadPolicy?: "exact" | "prefer-thread" | "most-recent" | "channel-root"`
- `allowChannelRootFallback?: boolean`
- `activeMinutes?: number`

### Recommended semantics

#### `threadPolicy = "exact"`

- requires a matching `threadId`
- error if no exact thread-bound session matches

#### `threadPolicy = "most-recent"`

- select the most recently updated thread-bound session for the given delivery target
- if none exists, either:
  - error, or
  - fall back only if `allowChannelRootFallback=true`

#### `threadPolicy = "prefer-thread"`

- prefer a thread-bound session if present
- otherwise choose the channel-root session

#### `threadPolicy = "channel-root"`

- explicitly target the non-thread channel session

### Return shape

The resolve result should return more than just `key`.

Recommended response:

```json
{
  "ok": true,
  "key": "agent:gpod:slack:channel:C0AG96MGJTV:thread:1773230000.123",
  "agentId": "gpod",
  "deliveryContext": {
    "channel": "slack",
    "to": "channel:C0AG96MGJTV",
    "accountId": "default",
    "threadId": "1773230000.123"
  },
  "resolution": {
    "matchedBy": "delivery-target",
    "threadPolicy": "most-recent",
    "fallbackUsed": false
  }
}
```

That stays backward-compatible because older clients can still read only `key`.

### Why this matters

This is the missing foundation for requests like:

- "message the agent in `<#channel>`"
- "continue in its most recent thread"
- "use the root channel, not a thread"
- "resume the exact thread we were using"

### Primary files

- `src/gateway/protocol/schema/sessions.ts`
- `src/gateway/protocol/schema/types.ts`
- `src/gateway/sessions-resolve.ts`
- `src/gateway/server-methods/sessions.ts`
- `src/agents/tools/sessions-resolution.ts`
- `src/agents/tools/sessions-send-tool.ts`

---

## Workstream C — Preserve thread-aware delivery context end-to-end

### Problem

The runtime can already carry `threadId`, but the A2A/session tool path does not preserve it consistently.

### Proposed change

Promote `threadId` to a first-class field everywhere session-target metadata is surfaced.

### Concrete changes

#### C1. Add `threadId` to session-list delivery metadata

Update session tool row types so `deliveryContext` includes:

- `channel`
- `to`
- `accountId`
- `threadId`

This is currently missing from the public `SessionListDeliveryContext` shape even though the gateway/session layer already knows about it.

#### C2. Make announce/relay target resolution prefer full delivery context

Today `resolveAnnounceTarget()` may fall back to list/session info that effectively preserves only:

- `channel`
- `to`
- `accountId`

That should become a fuller delivery-target resolution path preserving:

- `channel`
- `to`
- `accountId`
- `threadId`
- resolved session key
- agent id (when known)

#### C3. Stop thinking of A2A relay targets as just channel targets

The current `AnnounceTarget` type is directionally useful, but the next slice should move toward a richer internal type such as:

```ts
type ResolvedSessionDeliveryTarget = {
  sessionKey: string;
  agentId?: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
  source: "session-key" | "session-list" | "delivery-context" | "resolver";
};
```

A2A ingress/relay/announce should operate on this richer object, not on a lossy `channel-to-channel` mental model.

### Why this matters

If the user says:

> continue the work in its most recent thread

then **all** of these should stay pinned to that same thread target:

- initial A2A ingress echo
- relay request mirror
- relay reply mirror
- post-run announce, when announce is active

### Primary files

- `src/agents/tools/sessions-helpers.ts`
- `src/agents/tools/sessions-list-tool.ts`
- `src/agents/tools/sessions-announce-target.ts`
- `src/agents/tools/sessions-send-tool.ts`
- `src/agents/tools/sessions-send-tool.a2a.ts`
- `src/agents/tools/sessions-helpers.ts`
- `src/utils/delivery-context.ts`

---

## Workstream D — Add per-call follow-up loop control

### Problem

Global `session.agentToAgent.maxPingPongTurns` is useful as a safety ceiling, but it is not expressive enough for request-level orchestration.

For the motivating scenario, the requester needs to say:

- continue the work
- ask for further instructions
- requester replies with more instructions
- ask for a report
- repeat up to 2 full cycles

That should not depend only on a global config knob.

### Proposed change

Add **per-call** loop control to `sessions_send`, clamped by the global ceiling, and pair it with a wall-clock budget.

### Recommended params

At minimum:

- `maxPingPongTurns?: number`
- `maxElapsedMs?: number`

Optionally, if we want a more human-facing abstraction:

- `maxFollowUpCycles?: number`

Recommended first slice:

- add `maxPingPongTurns` per call
- add `maxElapsedMs` per call
- keep `maxFollowUpCycles` as a later alias or caller-side translation layer

Why:

- it matches existing runtime concepts
- it minimizes implementation risk
- it lets the caller translate natural phrases like "up to 2 full cycles" into a numeric turn budget
- it ensures a slow/stalled workflow cannot stay alive indefinitely even when turn count is still available

### Clamp rules

- per-call `maxPingPongTurns` cannot exceed global `session.agentToAgent.maxPingPongTurns`
- per-call `maxPingPongTurns` can reduce the limit
- zero disables follow-up ping-pong for that request
- per-call `maxElapsedMs` cannot exceed a global config ceiling if one is later added
- when either the turn budget or elapsed-time budget is exhausted, the loop stops immediately

### Additional guardrail rules

- resolve `threadPolicy: "most-recent"` once at the beginning and pin the selected session key for the rest of the run
- do **not** re-run most-recent-thread selection between follow-up turns
- do not allow the loop to hop between thread-bound and channel-root sessions unless a new top-level request explicitly asks for it
- preserve existing nested-`sessions_send` blocking by default

### Result semantics

When a guardrail ends the workflow, return structured metadata rather than vague success text.

Suggested top-level additions in the `sessions_send` result:

```json
{
  "followUp": {
    "status": "disabled | completed | turn_limit_reached | time_limit_reached | reply_skip | blocked",
    "maxPingPongTurns": 4,
    "turnsUsed": 4,
    "maxElapsedMs": 180000,
    "elapsedMs": 121337,
    "targetSessionPinned": true
  }
}
```

### Optional follow-up improvement

If the per-call turn budget feels too low-level in practice, a later slice can add `maxFollowUpCycles` as a friendlier alias.

---

## Workstream E — Carry a stable orchestration contract through follow-up turns

### Problem

The current follow-up prompting is generic:

- it identifies requester/target
- it tracks turn count
- it explains `REPLY_SKIP`

But it does not explicitly preserve a structured request contract like:

- continue existing work
- ask requester for further instructions
- requester should respond with next instructions
- target should report progress
- stop after N cycles

### Proposed change

Keep the current ping-pong mechanism, but strengthen the step context.

Add a stable A2A orchestration contract object carried through the run, for example:

```ts
type A2AOrchestrationContract = {
  objective: string;
  followUpStyle?: "generic" | "instruction-report";
  askForFurtherInstructions?: boolean;
  askForReport?: boolean;
  maxPingPongTurns?: number;
  maxElapsedMs?: number;
  pinnedTargetSessionKey?: string;
  threadSelectionLocked?: boolean;
};
```

The first implementation can keep this internal and derive it from the requester's tool call context.

### Example intended behavior

For the motivating request, the contract should cause the loop to behave like:

1. requester -> target: continue work in most recent thread
2. target -> requester: asks for next instructions / provides status
3. requester -> target: gives next instructions and asks for report
4. target -> requester: reports
5. repeat until turn budget is exhausted or one side replies `REPLY_SKIP`

This is still the same A2A ping-pong engine, just with better guidance.

### Primary files

- `src/agents/tools/sessions-send-helpers.ts`
- `src/agents/tools/sessions-send-tool.a2a.ts`
- `src/agents/tools/sessions-send-tool.ts`

---

## Recommended implementation slices

## Slice 1 — Finish the control surface + preserve threadId in session metadata

### Scope

- document `relay.verbosity` in user-facing docs
- add `threadId` to session-list delivery metadata
- update announce-target resolution to preserve `threadId`
- add tests covering thread-aware delivery metadata

### Why first

This is the smallest high-value slice and improves correctness immediately without changing session selection semantics yet.

### Acceptance

- `sessions_list` shows `deliveryContext.threadId` when present
- A2A relay/announce target resolution preserves thread id when session metadata already knows it
- docs clearly explain relay verbosity

---

## Slice 2 — Add delivery-target / thread-policy session resolution

### Scope

- extend `sessions.resolve` schema + runtime
- support delivery-target-based lookup
- support `threadPolicy`
- return richer resolution metadata

### Why second

This is the core enabler for "agent in `<#channel>`" + "most recent thread" workflows.

### Acceptance

A caller can resolve:

```json
{
  "channel": "slack",
  "to": "channel:C0AG96MGJTV",
  "threadPolicy": "most-recent"
}
```

into a concrete thread-bound session key with metadata.

---

## Slice 3 — Add per-call ping-pong control for `sessions_send`

### Scope

- allow per-call `maxPingPongTurns`
- clamp against global config ceiling
- expose behavior in docs/tests

### Why third

This is what makes bounded workflows like "repeat for up to 2 full cycles" deterministic.

### Acceptance

A requester can issue a targeted `sessions_send` and deliberately bound follow-up interaction for that single request.

---

## Slice 4 — Strengthen orchestration contract in the reply loop

### Scope

- carry structured orchestration intent through ping-pong turns
- improve follow-up prompts for instruction/report workflows
- keep `REPLY_SKIP` semantics unchanged

### Why fourth

This is behavior polish after targeting and limits are in place.

### Acceptance

The motivating workflow behaves reliably without requiring the model to rediscover the interaction pattern on every turn.

---

## Exact user-story acceptance test

This plan is only successful if the following becomes reliably achievable.

### Target scenario

Requester instruction:

> tell the agent in `<#C0AG96MGJTV>` to continue the work in its most recent thread and then ask you for further instructions. You will respond with new instructions and ask for a report. Repeat for up to 2 full cycles.

### Expected system behavior

1. The requester agent resolves `<#C0AG96MGJTV>` to a concrete bound agent/session target.
2. The resolver selects that target agent's most recent thread-bound session.
3. The initial `sessions_send` goes to that exact thread-bound session.
4. A2A ingress/relay/announce delivery stays pinned to that same thread.
5. The requester agent can continue the follow-up exchange without spawning a separate unrelated channel-root session.
6. The follow-up loop stops within the configured/requested turn/time budget.
7. The target session remains pinned for the life of the bounded run; "most recent thread" is not re-evaluated on every turn.
8. Tool/result metadata explains:
   - which session was selected
   - whether a thread was selected or root fallback was used
   - how many follow-up turns were allowed and consumed
   - whether a turn/time guardrail ended the workflow
   - relay delivery outcomes

### Failure cases that should become explicit

- no agent/session bound to the referenced channel
- no thread exists and fallback is not allowed
- multiple possible targets but no selection policy was given
- relay delivery failed in strict mode
- turn budget exhausted
- elapsed-time budget exhausted
- target-session pin could not be maintained

These should return structured, inspectable failures rather than silent fallback or vague channel behavior.

---

## Test plan

## Unit / integration

### Resolution

1. resolve by channel + `to`
2. resolve by channel + `to` + `agentId`
3. resolve most recent thread
4. resolve exact thread id
5. prefer-thread fallback to root
6. no thread found without fallback => error
7. ambiguous channel target => error unless selection policy narrows it

### Metadata

8. `sessions_list` includes `deliveryContext.threadId`
9. `sessions.resolve` returns richer resolution metadata without breaking `key`
10. announce target resolution preserves thread id from session metadata

### A2A behavior

11. ingress echo uses resolved thread id
12. relay round-1 uses resolved thread id on both sides when applicable
13. dual-channel mode still suppresses duplicate-looking target announce
14. per-call `maxPingPongTurns` clamps correctly
15. per-call `maxElapsedMs` clamps and stops correctly
16. target session is pinned once selected; no mid-loop re-resolution to a newer thread
17. `REPLY_SKIP` semantics unchanged
18. nested-`sessions_send` guard remains unchanged

### User-story e2e

19. channel-bound agent + most-recent-thread resolution + bounded follow-up loop works end-to-end
20. root fallback path works when enabled
21. explicit failure is returned when no eligible thread exists
22. explicit `turn_limit_reached` result is returned when the request exhausts its loop budget
23. explicit `time_limit_reached` result is returned when the request exhausts its elapsed-time budget

### Suggested files

- `src/agents/tools/sessions.test.ts`
- `src/agents/openclaw-tools.sessions.test.ts`
- `src/gateway/server.sessions-send.test.ts`
- `src/gateway/server.sessions.gateway-server-sessions-a.test.ts`
- session-resolution / threading tests where needed

---

## Rollout plan

1. Land Slice 1 on `ec-main`
2. Land Slice 2 on `ec-main`
3. Land Slice 3 on `ec-main`
4. Validate live using the existing `dev-openclaw -> gpod` path
5. Validate a real channel-bound thread continuation workflow on Slack
6. Land Slice 4 only after targeting/limits prove stable

---

## Recommended first PR

If doing the minimum useful next step, the first PR should include:

- docs for `relay.verbosity`
- `threadId` in session-list delivery metadata
- announce-target resolution preserving `threadId`
- tests for thread-aware target metadata preservation

That keeps the first slice small while directly improving the foundation needed for session-aware A2A.

---

## Bottom line

To make A2A truly useful for real agent orchestration, OpenClaw needs to move from:

- "send to a channel"

to:

- "resolve and continue a specific session, possibly a specific thread, with explicit follow-up bounds"

That is the difference between a neat relay feature and a reliable agent-to-agent work coordination tool.
