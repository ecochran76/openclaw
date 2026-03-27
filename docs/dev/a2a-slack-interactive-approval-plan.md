# A2A Slack Interactive Approval Plan

Status: active
Owner: dev-openclaw
Branch baseline: `ec-main`

## Why this plan exists

Recent A2A work made `sessions_send` more visible and safer:

- ingress echo exists
- dual-channel relay exists
- sender-attributed mirroring exists
- nested relay is guarded by default
- session access denials now return structured `permissionRequest` payloads

That is enough for an agent to ask the user for approval in plain text, but it is still not a real operator-grade approval flow.

The remaining gap is straightforward:

- a user watching Slack should be able to approve an A2A permission miss without leaving the thread
- the approval prompt should explain exactly what config gate is missing
- Slack mirroring must remain visible so the user can monitor the handoff
- the approval path must be auditable and safe against broad accidental config expansion

## Current behavior

Today, when A2A is blocked by config:

- `sessions_send`
- `sessions_history`
- `session_status`

can return a structured `permissionRequest` describing the missing gate:

- `tools.agentToAgent.enabled`
- `tools.agentToAgent.allow`
- `tools.sessions.visibility`

That is a good foundation, but not the final UX. The agent still has to translate that payload into a natural-language ask, the user still has to respond manually, and the retry is still a second step.

## Goal

Add a Slack-native approval flow for A2A permission misses that:

1. renders a clear approval prompt in the current Slack thread
2. lets the authorized user approve or deny with a button click
3. applies only the narrow config change needed for the specific A2A request
4. keeps the approval and resulting retry visible in Slack
5. does not weaken the existing A2A allow/visibility model

## Non-goals

- replacing `sessions_send` with Slack transport
- introducing silent auto-approval for missing A2A permissions
- broadening `tools.agentToAgent.allow` semantics
- building a general-purpose config editing UI in Slack
- auto-resuming every denied tool path in the product in this same slice

## User-facing requirements

### Requester thread behavior

When an agent hits an A2A permission miss in Slack:

- the agent should post a short explanation
- the same thread should include interactive approve/deny controls
- the prompt should name the requester and target agents
- the prompt should identify the exact missing gate

### Monitoring behavior

Slack mirroring remains important and should not be reduced:

- the user should still see sender-labeled mirrored A2A turns
- the approval prompt should appear in the same observable thread context
- approval outcomes should be announced explicitly in-thread

### Safety behavior

Approval should be narrow and inspectable:

- only the missing gate for the current requester/target pair should be patched
- wildcard expansion should never be inferred automatically
- prompt expiry and duplicate-click handling should be deterministic
- every applied approval should record provenance

## Proposed architecture

### 1. Keep `permissionRequest` as the control-plane contract

The new structured payload should remain the source of truth.

Slack should render from that contract rather than re-deriving policy decisions from the error text.

Minimum contract fields needed by the Slack approval layer:

- reason
- action
- requesterAgentId
- targetAgentId
- suggestedChanges
- missingAllowAgents
- askUser

If more metadata is needed, add it to the contract once and reuse it everywhere.

### 2. Introduce a pending A2A approval record

We need durable state for button clicks and retries.

Suggested shape:

```ts
type PendingA2AApproval = {
  approvalId: string;
  createdAt: number;
  expiresAt: number;
  sessionKey: string;
  threadId?: string;
  requesterAgentId: string;
  targetAgentId: string;
  action: "send" | "history" | "status";
  permissionRequest: SessionAccessPermissionRequest;
  originalToolName: "sessions_send" | "sessions_history" | "session_status";
  originalArgs: Record<string, unknown>;
  requesterMessageId?: string;
  approvedBy?: string;
  approvedAt?: number;
  deniedBy?: string;
  deniedAt?: number;
};
```

Requirements:

- durable across gateway restarts
- idempotent on repeated button clicks
- easy to expire and garbage collect

### 3. Render a Slack-specific approval message

Slack should render a focused approval card with:

- one short text summary
- optional detail lines for missing gates
- `Approve` and `Deny` buttons

Example prompt shape:

- `dev-agent -> gpod is blocked by tools.agentToAgent.allow`
- `Missing allow entries: dev-agent`
- `Approve this narrow config change and retry?`

The button payload should reference only the approval record id, not raw config JSON.

### 4. Apply a narrow config patch

Approval handling should use the stored `suggestedChanges`, but only after validation against current config.

Rules:

- re-read config at click time
- re-check whether the approval is still needed
- merge only the specific suggested value
- preserve unrelated config formatting/shape as much as current config helpers allow
- if state drift makes the request obsolete, mark it resolved without applying a stale patch

Expected narrow patch behavior:

- `tools.agentToAgent.enabled` -> `true`
- `tools.agentToAgent.allow` -> append only the missing agent ids, deduped
- `tools.sessions.visibility` -> set to `all` only when the user explicitly approves that broader access

### 5. Start with approve-and-retry, not approve-and-auto-resume

The first safe product slice should stop at:

- approval recorded
- config patched
- Slack thread updated with success/denial
- user or agent retries the original request

Do not auto-replay the denied tool call in the first slice.

Reasons:

- keeps approval semantics clear
- avoids hidden second-order side effects
- prevents replaying stale context after a long pause
- reduces coupling between Slack interaction plumbing and tool execution state

Auto-resume can be a later slice once the approval store and retry contract are stable.

### 6. Keep authorization explicit

Only trusted users should be able to click approve.

Reuse existing Slack interaction authorization patterns where possible:

- same approver identity checks used for other sensitive interactive actions
- clear rejection message for unauthorized clicks
- approval result visible, but only authorized users can mutate config

### 7. Audit and operator visibility

Every approval outcome should be visible in Slack and inspectable in logs:

- approval requested
- approved
- denied
- expired
- obsolete due to config drift

Log fields should include:

- approvalId
- requesterAgentId
- targetAgentId
- reason
- changed paths
- approver identity

## Implementation slices

### Slice 0 - Contract hardening

Status: landed

- normalize and freeze the `permissionRequest` contract
- add any missing fields needed by Slack rendering
- add tests for all three deny reasons

Acceptance:

- tool-level contract is stable and documented
- no Slack-specific logic required yet

### Slice 1 - Pending approval store

Status: landed

- add durable pending approval records with TTL
- add create/read/update/expire helpers
- add tests for duplicate clicks and restart recovery

Acceptance:

- approvals survive a gateway restart
- expired approvals cannot be applied

### Slice 2 - Slack prompt rendering

Status: landed

- render A2A permission prompts with Slack interactive buttons
- post them in the same requester thread
- keep text concise and operator-readable

Acceptance:

- a denied A2A request in Slack produces a visible approve/deny prompt
- prompt names requester, target, and missing gate

### Slice 3 - Click handling and config patching

Status: landed

- authorize the click actor
- re-validate current config
- apply the narrow patch
- update the Slack prompt with the outcome

Acceptance:

- approve applies only the specific change needed
- deny leaves config unchanged
- duplicate clicks do not double-apply

### Slice 4 - Retry guidance and runbook polish

Status: in progress

- thread reply explains what changed
- thread reply tells the operator or agent to retry
- local feature runbook documents live verification steps

Acceptance:

- operator can complete the flow without leaving Slack
- docs match runtime behavior

## Validation plan

Minimum coverage:

- unit tests for permission-request normalization
- store tests for pending approval lifecycle
- Slack interaction tests for render + approve + deny + unauthorized click
- config patch tests for narrow merge behavior
- focused A2A regression tests to confirm mirroring behavior is unchanged

Suggested focused commands once the feature exists:

```bash
pnpm test -- src/agents/tools/sessions-access.test.ts
pnpm test -- src/agents/tools/sessions.test.ts
pnpm test -- src/agents/openclaw-tools.sessions.test.ts
pnpm test -- extensions/slack/src/shared-interactive.test.ts
pnpm test -- extensions/slack/src/monitor/slash.test.ts
pnpm build
```

## Risks and design guardrails

### Risk: approval grows broader than intended

Mitigation:

- store exact suggested changes
- re-validate before apply
- never synthesize wildcard allow entries

### Risk: Slack buttons outlive the context

Mitigation:

- TTL-backed approval records
- explicit expired state in thread
- no auto-resume in slice 1

### Risk: mirroring and approval flows collide

Mitigation:

- keep approval prompt in requester thread
- do not alter existing mirrored A2A turn formatting in the first slice

### Risk: config drift between request and click

Mitigation:

- re-read config at click time
- if approval is already satisfied or no longer valid, mark obsolete instead of applying stale state

## Recommended order

Do the work in this order:

1. stabilize the permission-request contract
2. add the durable approval store
3. render Slack prompts
4. handle approve/deny clicks
5. update runbooks and live-test in Slack

That keeps the first runtime slice small and avoids coupling UI, config writes, and automatic retries all at once.
