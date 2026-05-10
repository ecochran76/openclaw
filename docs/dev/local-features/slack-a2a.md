# Local Feature — Slack A2A

## Summary

This feature family covers `sessions_send`-driven agent-to-agent behavior used heavily in Slack and other threaded/group contexts.

It includes the work that made A2A interactions more visible, safer, and more targetable.

## Scope

- pre-run ingress echo
- nested relay guard
- relay delivery contract
- dual-channel relay behavior
- selector targeting and thread-aware resolution
- natural-language selector parsing
- session-tool config stabilization for A2A flows

## Why it exists

This area introduced a long chain of local commits that repeatedly replayed during rebases. Many of those commits were already semantically present in newer upstream-adjacent code, but Git still wanted help reconciling shapes.

That makes this one of the highest-value local docs to maintain.

## Current status

- active local feature area
- validated after the `v2026.3.13` repair rebase
- especially sensitive to helper-vs-inline implementation drift
- structured `permissionRequest` + pending approval records landed
- Slack in-thread approve/deny buttons now handle config-fixable A2A permission misses
- core approval payloads are channel-neutral; Slack renders `channelData.a2aApproval` metadata into approve/deny buttons in the Slack plugin
- current approval flow patches config narrowly and tells the operator or agent to retry
- later auto-resume work is still governed by [A2A Slack interactive approval plan](/dev/a2a-slack-interactive-approval-plan)
- preservation/rebase strategy is tracked in `docs/dev/upstream-compat-feature-preservation-plan.md`

## Key components

### Target resolution

- selector targeting in `sessions_send`
- agent-id-only `sessions_send` targeting resolves through `sessions.resolve` and prefers a deliverable channel-root session over internal monitor sessions
- thread-aware targeting in `sessions.resolve`
- natural-language selector phrases for recent A2A sessions

### Relay behavior

- ingress echo before target run
- optional strict delivery contract
- dual-channel relay / announce behaviors
- nested relay guard to prevent runaway inter-session forwarding

### Safety and operability

- per-call bounds
- ping-pong guardrails
- helper-based session-tool config handling

## Conflict hotspots

These files have repeatedly conflicted:

- `src/agents/tools/sessions-send-tool.ts`
- `src/agents/tools/sessions-send-helpers.ts`
- `src/agents/tools/sessions-send-tool.a2a.ts`
- `src/agents/openclaw-tools.sessions.test.ts`
- `src/gateway/sessions-resolve.ts`
- `src/gateway/server.sessions-send.test.ts`
- `src/config/schema.help.ts`
- `src/config/schema.labels.ts`
- `src/config/types.base.ts`
- `src/config/zod-schema.session.ts`
- `docs/gateway/configuration-reference.md`
- `docs/concepts/session-tool.md`

## Rebase guidance

When replaying old A2A commits onto newer code:

- prefer the newer helper-based `HEAD` shape over reintroducing older inline `callGateway("agent")` logic
- keep generic A2A approval payloads free of Slack blocks; Slack-specific approval button rendering belongs in `extensions/slack/src/interactive-replies.ts`
- verify whether a commit is truly missing vs merely replaying an older subset of already-present behavior
- after resolving, run focused A2A and gateway selector tests before pushing

## Validation runbook

Recommended focused checks:

```bash
pnpm test -- src/agents/openclaw-tools.sessions.test.ts
pnpm test -- src/gateway/server.sessions-send.test.ts
pnpm test -- src/agents/a2a/permission-approval-action.test.ts
pnpm test -- src/agents/pi-embedded-subscribe.handlers.tools.test.ts
pnpm test -- src/auto-reply/reply/dispatch-stream-delivery.test.ts
pnpm test -- extensions/slack/src/monitor/events/interactions.test.ts
pnpm test -- src/commands/models/auth.test.ts
pnpm test -- src/infra/provider-usage.auth.normalizes-keys.test.ts
```

If ingress/relay changes touched docs or config schemas, inspect those diffs too.

If you are touching the planned A2A permission-approval flow:

- read [A2A Slack interactive approval plan](/dev/a2a-slack-interactive-approval-plan) first
- keep Slack mirroring behavior unchanged unless the change is explicitly about mirrored formatting
- validate denied A2A requests in Slack with both approve and deny outcomes before live patching

Current operator path for live A2A permission misses:

- confirm the approval prompt names the right requester, target, and missing gate
- click `Approve` or `Deny` in the requester Slack thread
- on approval, confirm the thread says which config path changed
- retry the original `sessions_send` or related session tool call
- if the thread reports the request is obsolete or expired, retry to mint a fresh approval instead of editing config blind

## User-visible failure symptoms

- `sessions_send` loses `resolvedTarget` / `ingressEcho` metadata
- selector targeting resolves the wrong thread or channel root
- nested relays recurse when they should be blocked
- ingress echo goes missing or strict delivery fails open
- announce/reply relay steps happen in the wrong order or not at all

## Recovery notes

- compare against the last validated rebased `ec-main` state before inventing new behavior
- if only a couple of hotspot files regressed during rebase, restoring them from a known-good pre-rebase backup can be faster and safer than re-resolving every old hunk manually
