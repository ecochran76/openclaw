# Upstream Compatibility Feature Preservation Plan

This plan is about preserving and continuing to develop the `ec-main` local feature set while rebasing frequently onto `openclaw/openclaw`.

The goal is not to constrain upstream. The goal is to make local features survive upstream churn with less manual replay work.

## Goal

Keep the maintained `ec-main` feature set deployable and evolvable by:

- making local behavior explicit
- shrinking the number of upstream-hot files that directly contain local policy
- adding stable local seams for replay
- validating feature preservation after each rebase and live upgrade

## Non-goals

- do not weaken or remove local features just to make rebases easier
- do not fork whole subsystems when a smaller adapter or helper seam will work
- do not assume upstream file stability

## Source of truth

`ec-main` is the deployable integration branch.

Feature branches can help with active development, but once a slice lands on `ec-main`, the integrated `ec-main` version is the authoritative behavior.

## Maintained local feature families

These are the current durable feature families that must be preserved:

1. Profiles / auth / usage policy
2. Slack / A2A approvals and mirroring
3. Slack / agent responsiveness
4. Automation
5. Voice / telephony / local STT
6. Outbound relay and bound-channel protections

See `docs/dev/local-feature-index.md` for the current map and validation entrypoints.

## Core strategy

Every local delta should be pushed toward one of these categories:

### 1. Policy

Local rules, defaults, thresholds, notices, and product behavior decisions.

Policy should live in:

- dedicated helper modules
- feature-owned payload builders
- feature-owned config evaluators

Policy should not keep accumulating inline inside upstream-hot orchestrators.

### 2. Adapter

Small seams that connect local policy to upstream orchestration.

Adapters should:

- accept upstream-native inputs
- call local helpers
- return upstream-native outputs

Adapters are the preferred place for replay conflict resolution.

### 3. Core fork

Behavior that still requires deep edits in unstable upstream files.

This category should be explicit and minimized. Hidden core forks are what make rebases expensive.

## Target seam model

The main local compatibility seams should be:

### A. Dispatch compatibility layer

Owns local reply-dispatch behavior such as:

- ACP bypass policy
- verbose progress shaping
- tool-result formatting hooks
- deterministic local dispatch behavior layered onto current upstream orchestration

Primary pressure files to shrink:

- `src/auto-reply/reply/dispatch-from-config.ts`
- `src/auto-reply/reply/dispatch-acp.ts`
- `src/auto-reply/reply/dispatch-reply-resolver-options.ts`

### B. Runner compatibility layer

Owns local runner behavior such as:

- auth-profile/run selection
- local auth/header injection
- run-result normalization
- runner-specific local runtime decisions

Primary pressure files to shrink:

- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-embedded-runner/run/types.ts`
- nearby runner auth/runtime helpers

### C. Tool-event payload layer

Owns structured user-facing payload generation for:

- exec approvals
- A2A approvals
- patch summaries
- plan/progress notices
- automation turn/status payloads

Primary pressure files to shrink:

- `src/agents/pi-embedded-subscribe.handlers.tools.ts`
- automation announcement/status surfaces

## Workstreams

### Workstream 1: Feature inventory and ownership

Create and maintain feature docs that record:

- user-visible behavior that must survive rebases
- implementation hotspots
- validation entrypoints
- recovery notes

This is already partially in place and should be kept current.

### Workstream 2: Compatibility seam extraction

Move local behavior from upstream-hot files into:

- leaf helpers
- feature-owned payload builders
- thin adapter modules

Priority order:

1. dispatch compatibility
2. runner compatibility
3. tool-event payload shaping

### Workstream 3: Feature preservation tests

Add or maintain small tests that prove feature behavior, not file shape.

Examples:

- A2A deny emits approval payload
- automation announced runs emit per-turn progress
- usage policy keeps manual profile selection sticky
- stale assistant replies are not reused

These are the rebase gates that matter most.

### Workstream 4: Generated artifact discipline

When a local feature changes generated surfaces, document:

- source file
- generation command
- expected artifact

Current examples:

- tool display metadata
- config baseline metadata
- plugin SDK baselines

### Workstream 5: Rebase execution discipline

After every meaningful rebase onto `origin/main`:

1. finish mechanical replay
2. run focused feature-preservation lanes
3. repair only failing seams
4. run `pnpm build`
5. push `fork/ec-main`
6. run live patch

Do not broaden into unrelated upstream-red failures unless they block the deploy path.

## Implementation order

### Phase 1: Documentation and ownership

- keep `docs/dev/local-feature-index.md` current
- link each feature family to its seam and preservation tests
- record recovery notes when rebases expose new hotspots

### Phase 2: Dispatch seam hardening

- extract local dispatch policy from `dispatch-from-config` and related files
- keep upstream files as orchestration-only callsites where possible
- preserve current local Slack responsiveness, automation, and A2A behavior

### Phase 3: Runner seam hardening

- continue moving local run-selection and auth-profile behavior behind shared adapters
- keep `pi-embedded` runner callsites thin

### Phase 4: Tool payload extraction

- move approval/progress/payload shaping into dedicated builders
- leave the main tool-event handler as a router, not a formatting monolith

### Phase 5: Rebase-gate stabilization

- codify a small preservation lane per feature family
- prefer these focused gates for rebase repair over broad exploratory test runs

## Decision rules for future local feature work

When adding or extending an `ec-main` feature:

1. first choose the intended compatibility seam
2. add a helper or adapter before editing a hot upstream file
3. add a preservation test for the user-visible behavior
4. update the relevant local feature doc

If a change cannot fit a seam cleanly, document it as an intentional fork.

## Immediate next slices

These are the highest-value next implementation steps:

1. extract a dispatch compatibility helper layer for `dispatch-from-config` and `dispatch-acp`
2. extract tool-event payload shaping from `pi-embedded-subscribe.handlers.tools`
3. keep runner compatibility work moving behind shared adapters instead of inline branches

## Success criteria

This plan is succeeding when:

- rebases mainly conflict in helper/adaptor files instead of orchestration files
- local features can be described and validated from docs without chat archaeology
- focused feature-preservation tests catch replay regressions quickly
- live patching can proceed after a rebase without broad unrelated repair work
