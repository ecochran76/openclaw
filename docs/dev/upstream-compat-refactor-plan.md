# Upstream Compatibility Refactor Plan

This doc tracks the refactor work whose only purpose is to reduce long-term rebase pressure on `ec-main` by moving local behavior behind narrower seams that fit upstream's current module boundaries.

## Phase 2 checkpoint

As of 2026-03-25, the main `dispatch-from-config.ts` and `sessions_send` pressure points have been materially reduced.

Completed extractions now landed on `ec-main`:

- A2A relay delivery helpers
- A2A ingress echo helper
- A2A announce target resolution
- A2A flow bootstrap / round-one bootstrap
- A2A flow preparation helper
- dispatch delivery observer
- observed reply-delivery helper
- dispatch reply-resolver options helper
- dispatch final-delivery helper
- dispatch stream-delivery helper

Practical result:

- `src/gateway/sessions-resolve.ts` is no longer the only place where local A2A behavior accumulates
- `src/auto-reply/reply/dispatch-from-config.ts` is still important, but much less structurally overloaded
- future rebases should now conflict on smaller adapters instead of monolithic orchestration blocks

## Phase 3 checkpoint

As of 2026-04-20, the first provider-auth capability slice landed on `ec-main`.

Completed extraction:

- OpenAI Codex now exports its chat reauth capability from `src/plugins/provider-openai-codex-oauth.ts`.
- `src/auto-reply/reply/reauth-capabilities.ts` resolves provider capabilities through a provider-neutral lookup surface instead of composing OpenAI Codex start/complete behavior inline.
- The generic capability type lives in `src/plugins/provider-auth-types.ts`.

Validation:

- `pnpm test -- src/auto-reply/reply/reauth-capabilities.test.ts src/auto-reply/reply/commands-reauth.test.ts src/plugins/provider-openai-codex-oauth.chat-reauth.test.ts src/plugins/provider-openai-codex-oauth.test.ts src/commands/models/auth.test.ts`
- `pnpm build`

## Phase 4

Next focus: Slack A2A presentation boundary.

The current A2A approval surface still has Slack-specific presentation pressure in generic routing/tool-event paths. The first pass should extract a boundary that can answer:

- which parts of permission and routing semantics are generic A2A safety policy?
- which parts are Slack-specific rendering and interaction handling?
- how should Slack-owned helpers build approval payloads without owning generic A2A policy?

Recommended first slice:

- keep current Slack approve/deny behavior unchanged
- keep permission semantics and config patching in core-owned A2A helpers
- move Slack-specific approval payload construction toward Slack-owned helpers

Primary files to watch in this phase:

- `src/agents/a2a/*`
- `src/agents/pi-embedded-subscribe.handlers.tools*`
- `extensions/slack/src/monitor/events/interactions.test.ts`
- `src/agents/openclaw-tools.sessions.test.ts`

Primary validation entry points:

- `pnpm test -- src/agents/openclaw-tools.sessions.test.ts`
- `pnpm test -- src/agents/a2a/permission-approval-action.test.ts`
- `pnpm test -- src/agents/pi-embedded-subscribe.handlers.tools.test.ts`
- `pnpm test -- extensions/slack/src/monitor/events/interactions.test.ts`
