# Profile Usage Alerts and Auto-Switch Plan

Status: proposed
Owner: local profiles/auth feature area
Scope: additive profile-aware quota warnings, stop gates, and optional auto-profile switching for providers that expose plan-usage windows such as `openai-codex`.

## Goal

Add configurable usage alerts and optional automatic profile switching when an auth profile is nearing provider plan limits, without turning the maintained `ec-main` delta into a rebase trap.

The immediate motivating case is Codex-style windows such as:

- `5h`
- `1w`

But the design should stay provider-neutral where possible.

## Requirements

1. Warning behavior is configurable.
2. Stop behavior is configurable.
3. Auto-switch behavior is configurable.
4. Policy can be set globally, per provider, and per profile.
5. Manual `/profile` selection remains predictable.
6. The implementation stays additive and rebase-friendly on top of read-only upstream.

## Non-goals

- Do not interrupt an in-flight model turn.
- Do not repurpose error cooldowns as fake quota state.
- Do not require every run to fetch live provider usage before it can start.
- Do not build a UI-first feature before CLI/chat/runtime seams are stable.

## Existing seams to reuse

These are the current narrow seams worth building on:

- `src/infra/provider-usage.load.ts`
  - async usage fetch path already exists
  - already accepts `profileId`
- `src/infra/provider-usage.fetch.codex.ts`
  - already normalizes Codex `5h` / `1w` style windows
- `src/agents/auth-profiles/order.ts`
  - existing sync profile-order resolver
- `src/agents/auth-profiles/session-override.ts`
  - existing per-session auto profile selection/persistence seam
- `src/agents/model-auth.ts`
  - existing profile-order auth resolution
- `src/auto-reply/reply/commands-status.ts`
- `src/agents/tools/session-status-tool.ts`
- `src/commands/models/list.status-command.ts`
  - current user-visible usage/status surfaces

## Rebase-friendly design rules

1. Keep provider fetching separate from policy evaluation.
2. Keep policy evaluation pure and data-driven.
3. Keep runtime enforcement behind existing profile-selection seams.
4. Do not make `resolveAuthProfileOrder()` perform network I/O.
5. Do not overload `usageStats.cooldownUntil` or `disabledUntil` with quota semantics.
6. Prefer new helper modules over expanding already-hot orchestration files.
7. Land the feature in slices that are independently deployable.

## Proposed architecture

## A. Add a separate cached usage-policy state

Introduce a small, additive cache/state module for normalized provider-usage snapshots and derived policy state.

Recommended new module family:

- `src/infra/provider-usage.cache.ts`
- `src/infra/provider-usage.policy.ts`

Why a separate cache instead of `auth-profiles.usageStats`:

- cooldowns and quota policy are different concepts
- cooldown state is error-driven and mutation-heavy
- provider-usage snapshots are async/network-driven and should stay isolated
- this avoids turning auth-profile ordering into a store-schema conflict hotspot

Recommended cached record shape:

```ts
type CachedProfileUsageState = {
  provider: string;
  profileId: string;
  updatedAt: number;
  windows: Array<{
    label: string;
    usedPercent: number;
    resetAt?: number;
  }>;
  plan?: string;
  error?: string;
  lastAlertAt?: Record<string, number>;
};
```

Keyed by `provider + profileId`.

## B. Add a pure policy evaluator

Introduce a pure evaluator that consumes:

- cached usage windows
- current config policy
- session/source context

and returns a normalized decision:

```ts
type UsagePolicyDecision = {
  action: "allow" | "warn" | "switch" | "stop";
  matchedWindow?: string;
  matchedThreshold?: number;
  reason: "threshold" | "stale" | "no-data" | "unsupported";
  message?: string;
};
```

This module must not:

- write session state
- fetch provider data
- know about chat delivery

It should only evaluate cached state.

## C. Refresh usage snapshots asynchronously

Refresh should happen in places that already tolerate async provider-usage calls:

- `/status`
- `session_status`
- `openclaw models status`
- optional background heartbeat later

Phase 1 refresh strategy:

- opportunistic refresh when these surfaces are used
- cached state drives runtime decisions
- runtime does not block on live fetch by default

Optional later improvement:

- periodic background refresh on gateway heartbeat or timed task

## D. Enforce at the session auth-profile seam

Runtime enforcement should hang off `src/agents/auth-profiles/session-override.ts`, not off provider-specific runners.

Recommended shape:

- keep `resolveSessionAuthProfileOverride()` as the low-level selector
- add a wrapper/helper that:
  - reads cached usage-policy decisions for the current/ordered profiles
  - decides whether to warn, switch, or stop
  - persists a switched profile using the existing session override path

This keeps the mutation surface narrow and avoids pushing quota logic into:

- `src/agents/pi-embedded-runner/run.ts`
- provider-specific transport code
- generic fallback orchestration

## Proposed config

Add a new additive block under `auth`:

```ts
auth: {
  usagePolicy?: {
    enabled?: boolean;
    refreshMinutes?: number;
    staleAfterMinutes?: number;
    staleBehavior?: "allow" | "warn" | "stop";
    defaults?: UsagePolicyRules;
    providers?: Record<string, UsagePolicyRules>;
    profiles?: Record<string, UsagePolicyRules>;
  };
}
```

Suggested rules shape:

```ts
type UsageThresholdRule = {
  window: string; // e.g. "5h", "1w"
  remainingPercentLte: number; // e.g. 15 means 15% or less left
};

type UsagePolicyRules = {
  warn?: UsageThresholdRule[];
  stop?: UsageThresholdRule[];
  switch?: UsageThresholdRule[];
  respectUserOverride?: boolean; // default true
  onNoSwitchTarget?: "allow" | "warn" | "stop";
  surfaces?: {
    status?: boolean;
    sessionStatus?: boolean;
    preflightNotice?: boolean;
  };
};
```

Resolution precedence:

1. profile override rule
2. provider rule
3. global default rule

## Behavior rules

## 1. Warning

When the cached usage state matches a `warn` threshold:

- the turn is allowed
- `/status`, `session_status`, and `models status` show the alert
- optional preflight notice may be emitted once per threshold window

## 2. Stop

When the cached usage state matches a `stop` threshold:

- new turns are blocked before model execution
- the user gets a clear message explaining:
  - profile id
  - matched window
  - remaining percentage
  - suggested next action

If `respectUserOverride` is true and the current profile source is user-selected:

- warning still applies
- stop only applies if explicitly configured for that scope

## 3. Auto-switch

When the cached usage state matches a `switch` threshold:

- attempt to switch to the next eligible profile in the existing order
- keep selection within the same provider
- do not switch to a profile whose cached decision is `stop`
- prefer profiles whose decision is `allow`, then `warn`

If no switch target exists:

- follow `onNoSwitchTarget`

Recommended default:

- `warn`

## 4. Manual `/profile`

Default rule:

- user-selected profile overrides stay sticky
- auto-switch applies only to auto-selected profiles unless a rule explicitly disables `respectUserOverride`

This keeps `/profile openai-codex:pcg` predictable.

## Suggested implementation slices

## Slice 0 — Policy model and docs only

- add config/types/schema
- add pure evaluator
- no runtime mutation yet

Primary files:

- `src/config/types.auth.ts`
- config schema/help/labels/generated files
- `src/infra/provider-usage.policy.ts`
- docs in `docs/dev/*`

## Slice 1 — Cached usage state

- add usage snapshot cache read/write
- refresh from `/status`, `session_status`, `models status`
- no enforcement yet

Primary files:

- `src/infra/provider-usage.cache.ts`
- `src/auto-reply/reply/commands-status.ts`
- `src/agents/tools/session-status-tool.ts`
- `src/commands/models/list.status-command.ts`

## Slice 2 — Warning surfaces

- show warning lines in status surfaces
- optional one-line preflight notice in chat/runtime result metadata
- still no stop/switch enforcement

Primary files:

- `src/auto-reply/status.ts`
- `src/auto-reply/reply/commands-status.ts`
- `src/agents/tools/session-status-tool.ts`

## Slice 3 — Stop gate

- add preflight policy check before model execution
- return structured blocked reason
- do not start the run when policy says stop

Primary files:

- `src/agents/auth-profiles/session-override.ts`
- `src/auto-reply/reply/get-reply-run.ts`
- `src/agents/btw.ts`

## Slice 4 — Auto-switch

- add next-eligible profile selection using existing order
- persist switched profile via current session override mechanism
- emit a clear one-line switch notice

Primary files:

- `src/agents/auth-profiles/session-override.ts`
- `src/agents/auth-profiles/order.ts`
- `src/agents/model-auth.ts` (only if needed)

## Slice 5 — Optional background refresh

- periodic refresh for supported providers
- keep this separate so the core feature does not depend on scheduler churn

Primary files:

- new helper under `src/infra/provider-usage.*`
- possibly gateway heartbeat/tick wiring

## MVP recommendation

MVP should stop at Slice 4 and scope provider support to `openai-codex` first.

Reasons:

- the live need is strongest there
- the windows (`5h`, `1w`) are already normalized
- profile-aware status support is already adjacent
- it avoids broad provider churn while the seam proves out

## Validation plan

Pure logic:

```bash
pnpm test -- src/infra/provider-usage.policy.test.ts
pnpm test -- src/infra/provider-usage.cache.test.ts
pnpm test -- src/agents/auth-profiles/session-override.test.ts
```

Status surfaces:

```bash
pnpm test -- src/auto-reply/status.test.ts
pnpm test -- src/auto-reply/reply/commands-status.test.ts
pnpm test -- src/agents/openclaw-tools.session-status.test.ts
pnpm test -- src/commands/models/list.status.test.ts
```

Runtime behavior:

```bash
pnpm test -- src/agents/model-auth.profiles.test.ts
pnpm test -- src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.e2e.test.ts
pnpm build
```

## Rebase hotspots to avoid expanding

Keep this feature away from unnecessary churn in:

- `src/agents/pi-embedded-runner/run.ts`
- `src/auto-reply/reply/dispatch-from-config.ts`
- large UI panels under `ui/src/ui/views/*`

Preferred local-delta footprint:

- new `src/infra/provider-usage.*` helper modules
- small additive config changes
- narrow edits in status and session-auth-profile helpers

## Design notes worth preserving

- quota policy is not cooldown
- quota policy should be cache-driven and sync-readable by runtime selectors
- warning/stop/switch are policy outputs, not provider-specific hardcoding
- auto-switch should reuse existing profile order instead of inventing a second rotation system
- manual `/profile` should remain understandable and predictable by default
