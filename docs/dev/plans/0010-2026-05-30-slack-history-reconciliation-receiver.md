State: COMPLETE
Created: 2026-05-30
Last Updated: 2026-05-31

# Slack History Reconciliation Receiver

## Current State

Plans `0008` and `0009` improved Slack Socket Mode telemetry, health wording,
and missed-message diagnosis. They did not close the reliability gap: OpenClaw
can still be connected and healthy while Slack contains an explicit mention that
never reaches the admission pipeline.

Source implementation for Phases 1-6 is present and live SoyLei proof completed
as of 2026-05-31.

The SoyLei miss at `C0B0AK14B7X` / `1780182187.975599` proves the gap:

- Slack history contains `<@U0B0BS18D70> did you enjoy the probe?`.
- OpenClaw has no original accepted or dropped admission ledger row for that
  timestamp.
- The ledger contains only watchdog replay rows after operator recovery.
- A same-channel explicit mention minutes earlier was admitted normally, so the
  failure was not mention matching.

Slack Receipts is more reliable because it does not trust a live event stream as
the only source of truth. It uses Slack Web API history with checkpoints,
pagination, and bounded catch-up. OpenClaw needs the same correctness model for
operator-facing message admission: Socket Mode is the low-latency fast path;
Slack history reconciliation is the durable truth path.

## Goal

Make configured Slack accounts converge on Slack history even when Socket Mode
misses an event. An explicit mention visible in Slack history must either be
admitted, recorded as a policy/self/bot drop, or recorded as an unrecoverable
Slack/API error with concrete evidence.

## Non-Goals

- Do not replace Slack Socket Mode as the fast path.
- Do not make Slack Receipts or Slack Mirror a runtime dependency.
- Do not add SoyLei-specific channel policy.
- Do not auto-reply to arbitrary historical Slack content by default.
- Do not bypass existing Slack admission, authorization, self/bot, dedupe,
  routing, or reply-delivery rules.

## Design

Add a Slack-owned history reconciler inside the Slack plugin.

The reconciler periodically reads recent Slack history for configured, enabled
Slack surfaces and compares Slack messages with OpenClaw admission state:

1. Fetch recent channel/DM history with `conversations.history`.
2. Fetch replies for recent active thread roots with `conversations.replies`.
3. Use per-account/per-channel checkpoints with overlap, not a single latest
   timestamp with no lookback.
4. For each candidate human message, check admission ledger and inbound-delivery
   state before doing anything.
5. If missing, submit it through the same message handler path used by Socket
   Mode, with a source label such as `history_reconcile`.
6. Record reconciliation attempts, accepted/drop outcomes, and failures in a
   durable ledger/state file.

This must be idempotent. A Socket Mode event and a reconciliation read of the
same Slack timestamp must never produce duplicate agent turns or duplicate
replies.

## Phase 1: State And Fetcher

- Add plugin-owned reconciliation state under the OpenClaw state directory:
  `slack/reconciliation/<account>.json`.
- Store per-channel checkpoints:
  - latest processed Slack ts;
  - last successful scan time;
  - last API error;
  - counts for scanned, skipped, admitted, dropped, replayed, failed.
- Implement a small Slack history fetcher modeled after Slack Receipts:
  - `conversations.history` with `oldest`, `latest`, `inclusive: true`,
    `limit: 200`, and cursor pagination;
  - `conversations.replies` for recent roots and known active/admitted thread
    roots;
  - bounded API backoff for `ratelimited`, transient network errors, and Slack
    5xx-like failures.

Acceptance:

- Unit tests prove cursor pagination and checkpoint overlap.
- Unit tests prove `not_in_channel`, `missing_scope`, and `channel_not_found`
  are recorded without crashing the account monitor.
- No Slack credentials or message bodies are written to logs.

## Phase 2: Candidate Classification

- Reuse the existing watchdog/admission-gap classifier where possible.
- Classify fetched messages before replay:
  - bot/self/not relevant;
  - already accepted/dropped;
  - already delivered by inbound-delivery state;
  - missing admission and eligible;
  - missing admission but blocked by channel/user policy.
- Treat replay ledger rows as recovery evidence, not original admission proof.
- Include `client_msg_id`, `thread_ts`, user id, and text hash in durable
  records.

Acceptance:

- The known SoyLei message classifies as `missing-admission` before recovery and
  not as a mention miss.
- A same-ts Socket Mode admission suppresses reconciliation dispatch.
- Policy/self/bot drops are explicit records, not silent skips.

## Phase 3: Safe Admission Replay

- Add a plugin-internal replay entrypoint that feeds history-fetched messages
  into `createSlackMessageHandler`.
- Extend handler option source from `message | app_mention` to include
  `history_reconcile`, while preserving explicit-mention semantics:
  - if Slack text explicitly mentions the bot user, mark it mentioned;
  - otherwise use normal channel/thread policy.
- Reuse existing dedupe state and durable inbound-delivery state before
  dispatch.
- Record a reconciliation-specific admission attempt before agent dispatch and
  final accepted/drop/failure result afterward.

Acceptance:

- A history-reconciled explicit mention enters the same routing/session/reply
  path as a Socket Mode mention.
- A duplicate Socket Mode event arriving after reconciliation is dropped.
- A duplicate reconciliation pass after a successful replay is dropped.

## Phase 4: Runtime Scheduling

- Add opt-in account config:
  - `channels.slack.accounts.<id>.reconciliation.enabled`
  - `intervalMs` defaulting to a conservative value such as 60 seconds
  - `lookbackMs` defaulting to at least 10 minutes
  - `maxMessagesPerCycle`
  - `maxThreadRootsPerCycle`
  - `autoRecover` defaulting to false until live proof is complete
- In HTTP mode, allow reconciliation too; this is a receiver correctness layer,
  not a Socket Mode-only patch.
- Start the reconciler after Slack auth metadata is available and stop it with
  the account abort signal.

Acceptance:

- The reconciler starts/stops with the account lifecycle.
- Quiet connected sockets remain healthy; reconciliation status shows whether
  Slack history was checked recently.
- Disabling reconciliation leaves current Socket Mode behavior unchanged.

## Phase 5: Operator Surface

- Add reconciliation fields to channel status:
  - last reconciliation scan;
  - latest channel checkpoint;
  - missing candidates found;
  - recovered candidates;
  - last API error.
- Update `why-silent` and watchdog output to say:
  - "Slack history reconciliation has not checked this message yet";
  - "Slack history reconciliation found and recovered this message";
  - "Slack history reconciliation found this message but admission failed";
  - "Slack history reconciliation could not read this channel because ...".

Acceptance:

- For a pasted permalink, status can distinguish Socket Mode miss from
  reconciliation failure.
- Operators do not need raw logs to see whether history catch-up is running.

## Phase 6: Live Proof

- Patch live OpenClaw and the Slack plugin.
- Enable reconciliation for SoyLei `ask-lei` in dry-run mode first.
- Send controlled probes:
  - top-level explicit mention;
  - thread explicit mention;
  - bot/self message;
  - non-mentioned channel message when `requireMention` is true.
- Compare:
  - Slack history;
  - Socket Mode admission ledger;
  - reconciliation state;
  - watchdog scan;
  - agent reply delivery.
- Then enable `autoRecover` for the configured SoyLei operator-facing channel.

Acceptance:

- A controlled Socket Mode-admitted message is observed by reconciliation but
  not duplicated.
- A simulated missing-admission fixture is recovered by reconciliation without
  operator action.
- The previously missed permalink remains classified as recovered, not as
  current evidence of health.

## Definition Of Done

- Slack Socket Mode is no longer the only path by which a Slack user message can
  reach OpenClaw.
- Configured Slack history converges to admission/drop/recovery records.
- Missing explicit mentions visible in Slack history are automatically surfaced
  and, when configured, recovered.
- `stale-socket` is not used as a blanket explanation for Slack history/admission
  disagreement.
- Focused Slack receiver, admission, watchdog, and status tests pass.
- Live SoyLei proof shows no duplicate replies and successful recovery of a
  deliberately withheld/missing admission fixture.

## Implementation Evidence

2026-05-31 source implementation:

- Added Slack-owned reconciliation state and scanner in
  `extensions/slack/src/monitor/reconciliation.ts` and
  `extensions/slack/src/monitor/reconciliation-state.ts`.
- Wired reconciliation startup/shutdown through
  `extensions/slack/src/monitor/provider.ts`, deferred until bot identity is
  hydrated, with retry only when reconciliation is enabled.
- Extended the Slack handler/admission path to accept
  `source: "history_reconcile"` and bypass live-event debounce while preserving
  normal prepare/dispatch/delivery proof.
- Added config schema/types/UI metadata for `channels.slack.reconciliation` and
  account-level field-by-field overrides.
- Added sanitized `reconciliationStatus` to status snapshots, gateway protocol,
  `why-silent`, and `slack-watchdog-scan`.
- Preserved live-admission parity for DM policy, channel user allowlists,
  bot/self drops, bot-room authorization, implicit thread replies, thread
  broadcasts, Slack user-group mentions, known older thread roots, discovery
  failures, bounded backlog drain, and scheduler failure containment.

2026-05-31 validation:

- `pnpm tsgo:extensions --pretty false`
- `pnpm tsgo:core --pretty false`
- `node scripts/run-vitest.mjs extensions/slack/src/accounts.test.ts extensions/slack/src/monitor/provider.allowlist.test.ts extensions/slack/src/monitor/reconciliation.test.ts extensions/slack/src/monitor/message-handler.test.ts extensions/slack/src/monitor/message-handler/subteam-mentions.test.ts extensions/slack/src/config-schema.test.ts src/commands/channels/why-silent.test.ts src/commands/channels/slack-watchdog-scan.test.ts src/channels/account-snapshot-fields.test.ts src/plugin-sdk/status-helpers.test.ts`
  - 10 test files, 144 tests passed.
- `pnpm config:channels:check`
- `git diff --check`
- `.agents/skills/autoreview/scripts/autoreview --mode local`
  - clean: no accepted/actionable findings reported.

2026-05-31 live SoyLei proof:

- Patched live OpenClaw and the Slack plugin with
  `scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch --patch-external-plugin slack`.
  The script built tarballs, reinstalled the user-scoped runtime and Slack
  plugin, refreshed the plugin registry, repaired/restarted the gateway, and
  ended with gateway RPC healthy. The build emitted only the existing Vite
  chunk-size warning; patch smoke tests passed.
- Enabled SoyLei reconciliation in dry-run first with `autoRecover: false`,
  `intervalMs: 60000`, `lookbackMs: 600000`,
  `maxMessagesPerCycle: 200`, and `maxThreadRootsPerCycle: 50`.
  `openclaw channels status --deep --json` reported
  `reconciliationStatus.enabled: true`, a recent `lastScanAt`, and zero
  candidates after scanning the configured SoyLei channel set.
- Rechecked the original unanswered permalink with
  `openclaw channels watchdog-scan --account soylei --permalink https://soyleiinnovations.slack.com/archives/C0B0AK14B7X/p1780182187975599`.
  It remains a historical miss: `missing-admission=1` for
  `1780182187.975599`, reason `activation-without-ledger-record`. That message
  is outside the current reconciliation lookback, so it is incident evidence,
  not a current health failure.
- Simulated a missed event by stopping the gateway, posting an explicit SoyLei
  mention while the receiver was offline, then restarting the gateway. The first
  probe was correctly recorded as `dropped` with reason
  `bot-message-disabled` because Slack marked the API-authored message with
  `bot_id` while SoyLei production policy had `allowBots: false`.
- Temporarily set SoyLei `allowBots: "mentions"` and `lookbackMs: 30000` for a
  controlled recovery proof, stopped the gateway, posted
  `1780249696.940159` while offline, and restarted the gateway. Reconciliation
  state recorded `status: "replayed"` and
  `reason: "history-reconcile-dispatched"`.
- Operator proof for the recovered probe:
  `openclaw channels watchdog-scan --account soylei --permalink https://soyleiinnovations.slack.com/archives/C0B0AK14B7X/p1780249696940159`
  scanned the 30-minute window with `admitted=1` and `missing-admission=0`.
  Gateway logs show the replay entered the normal Slack turn path and completed
  in 27 seconds.
- Restored SoyLei production policy after the controlled proof:
  `allowBots: false`, reconciliation `lookbackMs: 600000`, and
  `autoRecover: true`. `openclaw gateway status --deep --require-rpc` remained
  healthy, and config reads confirmed the restored values.
- Added final live coverage for the named probe classes in the `website`
  channel (`C06L8DVBWQP`), which has `requireMention: true`:
  - top-level parent `1780250237.379219` had no Lei mention and was recorded as
    `admission-ledger:dropped`; watchdog reported `explicitly-ignored=1` and
    `missing-admission=0`;
  - threaded explicit mention `1780250242.131789` was recorded as
    `admission-ledger:accepted`, entered the normal Slack turn path, and
    received a thread reply at `1780250244.651209`;
  - reconciliation later observed the bot reply as `bot-self`.
    Final SoyLei status remained healthy with two Socket Mode connections,
    reconciliation `autoRecover: true`, and zero missing/failed candidates.

Known residuals:

- The user-scoped gateway service still reports the pre-existing PATH warning.
- The live log still reports `Slack persistent inbound delivery state failed`
  because `openKeyedStore` is unavailable to this external plugin release.
  Reconciliation still proved replay safety through the existing admission
  ledger and watchdog surfaces.
