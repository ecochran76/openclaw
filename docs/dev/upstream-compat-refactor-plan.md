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

## Phase 4 checkpoint

As of 2026-04-20, the Slack A2A presentation boundary slice landed on `ec-main`.

Completed extraction:

- core A2A approval payloads now emit generic text plus `channelData.a2aApproval` metadata
- Slack-owned interactive reply helpers render A2A approval metadata as Slack approve/deny buttons
- Slack approval button rendering stays available even when optional inline interactive reply directives are disabled
- core tests assert A2A safety metadata instead of Slack presentation blocks

Validation:

- `pnpm test -- src/agents/openclaw-tools.sessions.test.ts src/agents/a2a/permission-approval-action.test.ts src/agents/pi-embedded-subscribe.handlers.tools.test.ts extensions/slack/src/monitor/events/interactions.test.ts extensions/slack/src/channel.test.ts extensions/slack/src/interactive-replies.test.ts`

## Phase 5

Next focus: automation command and status seams.

The current automation surface is useful but still rebase-sensitive because command parsing, help/status text, progress presentation, and lifecycle semantics can be easy to mix in the same files.

Recommended first slice:

- keep bounds, turn accounting, session lifecycle, and stop guards in core
- extract automation command parsing and help/status text into feature-owned helpers
- extract automation progress/status payload shaping away from generic dispatch/tool handlers
- add preservation tests for multi-turn progress announcements and status output

Primary files to watch in this phase:

- `src/agents/tools/automation-tool.ts`
- `src/automation/*`
- `src/auto-reply/reply/commands-automation.ts`
- `src/auto-reply/reply/commands-automation-shared.ts`
- `src/auto-reply/reply/commands-automation-status.test.ts`

Primary validation entry points:

- `pnpm test -- src/agents/openclaw-tools.automation.test.ts`
- `pnpm test -- src/auto-reply/reply/commands-automation.test.ts`
- `pnpm test -- src/auto-reply/reply/commands-automation-status.test.ts`
- `pnpm test -- src/config/config.automation-defaults.test.ts`
