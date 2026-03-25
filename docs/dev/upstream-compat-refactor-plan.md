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

## Phase 3

Next focus: provider-auth capabilities.

The current `/reauth` flow is still too provider-specific. The first pass should extract a provider capability boundary that can answer:

- can this provider start chat-native reauth?
- how does it start?
- how does it complete?
- what fallback guidance should be shown when chat reauth is unsupported?

Recommended first slice:

- keep current `openai-codex` behavior unchanged
- extract provider-neutral capability lookup behind `/reauth`
- move OpenAI Codex-specific manual auth start/complete logic behind that capability

Primary files to watch in this phase:

- `src/auto-reply/reply/commands-reauth.ts`
- `src/plugins/provider-openai-codex-oauth.ts`
- `src/commands/models/auth.ts`
- `src/plugins/provider-auth-helpers.ts`

Primary validation entry points:

- `pnpm test -- src/auto-reply/reply/commands-reauth.test.ts`
- `pnpm test -- src/commands/openai-codex-oauth.test.ts`
- `pnpm test -- src/plugins/provider-openai-codex-oauth.chat-reauth.test.ts`
- `pnpm test -- src/commands/models/auth.test.ts`
- `pnpm build`
