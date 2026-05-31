State: COMPLETE
Created: 2026-05-30

# Slack Connector Receiver And Health Overhaul

## Current State

Slack Socket Mode delivery in the OpenClaw Slack plugin is not reliable enough
for operator-facing channels. Recent SoyLei misses show Slack itself and
Slack Mirror can receive events while OpenClaw records no admission ledger
entry and later restarts the Slack account as `stale-socket`.

The immediate watchdog from
`docs/dev/plans/0007-2026-05-18-slack-stale-socket-watchdog.md` detects missed
admissions after the fact. This plan addresses the deeper receiver and health
model so OpenClaw stops creating the miss window in the first place.

## Progress

- 2026-05-30: Started Phase 1/2 implementation. Slack Socket Mode now publishes
  SDK lifecycle fields, raw websocket envelope timestamps, raw Slack event
  timestamps, and receiver/admission counters through channel status. Slack
  connect status no longer seeds `lastTransportActivityAt`; receiver-level
  `ws_message` and `slack_event` activity is exposed through Slack-owned fields
  instead of the generic transport heartbeat field.
- Focused proof:
  `node scripts/run-vitest.mjs extensions/slack/src/monitor/provider.reconnect.test.ts extensions/slack/src/monitor/message-handler.test.ts src/channels/account-snapshot-fields.test.ts src/gateway/protocol/channels.schema.test.ts src/gateway/channel-health-policy.test.ts`
  passed with 8 files and 87 tests.
- 2026-05-30: Extended Phase 3 telemetry. Slack status counters now classify
  app/team mismatches, self/bot drops, policy drops, admission records,
  dispatch preparation, and dispatch failures. Watchdog health output now cites
  the compact Slack receiver/admission counters from `channels.status`.
- Focused proof:
  `node scripts/run-vitest.mjs extensions/slack/src/monitor/provider.interop.test.ts extensions/slack/src/monitor/events/messages.test.ts extensions/slack/src/monitor/message-handler/prepare.test.ts src/commands/channels/slack-watchdog-scan.test.ts`
  passed with 4 files and 132 tests.
- 2026-05-30: Enabled source-thread replies in the live SoyLei scheduled
  watchdog wrapper, bounded by `OPENCLAW_SLACK_WATCHDOG_MAX_REPLIES` defaulting
  to `1`, while preserving operator alerting. The wrapper documents why both
  alert paths stay enabled. `watchdog-status --account soylei --json` advanced
  `sourceReplied` from 1 to 2 after a write-gated scan for
  `1780107218.910779`; the repeat dry-run reported `sourceReplies.sent=0` and
  `sourceReplies.skippedKnown=2`.
- 2026-05-30: Live patched OpenClaw and the external Slack plugin twice via
  `scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch --patch-external-plugin slack`.
  The first live proof exposed that `createComputedAccountStatusAdapter` was
  dropping the new runtime receiver fields. The shared status helper now
  preserves Socket Mode lifecycle/receiver fields and Slack telemetry.
- 2026-05-30: Live SoyLei proof in `ask-lei`:
  Slack Mirror listed the controlled top-level, threaded, and bot/self probe
  messages from `20260530T164350Z`; OpenClaw `channels status --json` exposed
  SoyLei `lastSocketEnvelopeAt`, `lastSlackEventAt`, and `slackTelemetry`
  after the `20260530T165740Z` probe; watchdog classified the controlled
  messages as `explicitly-ignored`/`not-relevant` with no `missing-admission`.
- 2026-05-30: Final review caught that raw Slack frames/events were still being
  copied into generic `lastTransportActivityAt`. That field now stays unset for
  raw Slack receiver activity; the final installed proof for
  `20260530T171441Z` showed SoyLei raw receiver fields and counters without
  `lastTransportActivityAt`, and watchdog reported the message as
  `explicitly-ignored` with no `missing-admission`.
- Focused proof:
  `node scripts/run-vitest.mjs extensions/slack/src/monitor/provider.reconnect.test.ts extensions/slack/src/monitor/provider.interop.test.ts extensions/slack/src/monitor/message-handler.test.ts extensions/slack/src/monitor/events/messages.test.ts extensions/slack/src/monitor/message-handler/prepare.test.ts src/commands/channels/slack-watchdog-scan.test.ts src/channels/account-snapshot-fields.test.ts src/gateway/protocol/channels.schema.test.ts src/gateway/channel-health-policy.test.ts src/plugin-sdk/status-helpers.test.ts`
  passed with 13 files and 238 tests.

## Problem Statement

The current Slack connector conflates several different signals:

- Socket Mode lifecycle state.
- Raw websocket envelope receipt.
- Slack Events API receipt.
- Business-handler eligibility.
- Admission into an agent turn.
- Reply delivery and user-visible recovery.

The generic channel health monitor expects `lastTransportActivityAt` to be
ongoing transport or heartbeat proof. The Slack connector currently sets it on
connect, then updates only app-level fields (`lastEventAt`, `lastInboundAt`) as
events flow through business handlers. That creates two bad outcomes:

- quiet or partially healthy sockets age into `stale-socket` restarts even when
  the Slack SDK is still connected;
- real missed admissions are diagnosed too late, after a health-monitor cycle
  or watchdog scan.

## Goals

- Make Slack receiver liveness observable before any business filtering.
- Separate transport health from Slack event receipt and admission health.
- Replace generic timestamp aging with a Slack-owned health interpretation where
  the Slack SDK already exposes better lifecycle signals.
- Preserve explicit operator/user recovery for messages that still slip through.
- Keep the fix inside the Slack plugin and generic channel contracts; do not add
  SoyLei-specific policy to core.

## Non-Goals

- Replacing Slack Mirror or making Slack Mirror a hard dependency.
- Rewriting all Slack command, A2A, approval, or rendering behavior.
- Changing Slack app scopes or tokens unless audit evidence shows a token/app
  mismatch.
- Hiding missed-message recovery behind automatic replay without an explicit
  write gate.

## Phase 0: Stabilize The Live Guardrail

Purpose: stop silent misses while deeper receiver work is underway.

- Enable the live scheduled SoyLei watchdog to use `--reply-missed` with a
  small `--max-replies` value and the existing watchdog state file.
- Keep the operator alert path enabled.
- Add a service wrapper comment or checked-in helper documenting why scheduled
  watchdog scans must include both operator alerting and source-thread reply.
- Verify the known missed permalink receives exactly one threaded notice, and a
  repeat scan skips it as known.

Acceptance:

- `openclaw channels watchdog-status --account soylei --json` increments
  `sourceReplied` for new misses.
- Repeated dry-runs report `sourceReplies.skippedKnown > 0` and `sent = 0` for
  previously replied misses.

## Phase 1: Instrument Raw Receiver Liveness

Purpose: add facts before changing restart policy.

- Attach a Slack Socket Mode client observer at receiver construction/start.
- Listen for SDK lifecycle events:
  - `connected`
  - `reconnecting`
  - `disconnecting`
  - `disconnected`
  - `error`
- Listen for raw inbound events:
  - `slack_event`
  - optionally `ws_message` for envelope-level receipt if the SDK version
    exposes it stably enough.
- Publish distinct status fields:
  - `lastSocketConnectedAt`
  - `lastSocketDisconnectedAt`
  - `lastSocketReconnectAt`
  - `lastSocketError`
  - `lastSocketEnvelopeAt`
  - `lastSlackEventAt`
- Keep existing `lastEventAt` and `lastInboundAt` for app/business-level
  activity.
- Do not treat every Slack event as an admitted message.

Acceptance:

- Unit tests prove raw `slack_event` updates receiver liveness even when the
  business handler drops the event.
- Unit tests prove lifecycle events update lifecycle fields without requiring a
  message event.
- Live `openclaw channels status --json` shows a field that changes after raw
  Slack traffic, not only at connect time.

## Phase 2: Fix The Health Contract

Purpose: stop using connect time as a fake transport heartbeat.

Option A, preferred:

- Stop setting `lastTransportActivityAt` from Slack connect unless it is kept
  fresh by real transport or raw receiver activity.
- Update `lastTransportActivityAt` from receiver-level `slack_event` or
  websocket-level `ws_message`, with docs stating this is receiver activity, not
  admitted-message activity.
- Add Slack-specific tests showing the generic health monitor does not mark a
  recently active receiver stale.

Option B:

- Leave `lastTransportActivityAt` unset for Slack Socket Mode.
- Add Slack-specific health issue collection using SDK lifecycle fields instead
  of the generic stale-socket age rule.

Preferred implementation should choose the smallest contract change that is
truthful for all channels. If `lastTransportActivityAt` means transport proof,
then Slack must update it from receiver-level activity or not set it at all.

Acceptance:

- A Slack account connected for more than 10 minutes without messages is not
  restarted solely because its connect timestamp aged out.
- A Slack account with recent receiver traffic is considered healthy.
- A Slack account with SDK disconnected/error state is marked unhealthy without
  waiting for the stale threshold.
- Existing Telegram/WhatsApp/Discord health semantics are not regressed.

## Phase 3: Add Admission Gap Telemetry

Purpose: make missed-message cause visible without a separate forensic scan.

- Record counters or recent timestamps for:
  - raw Slack events received;
  - message events received;
  - events dropped for team/account mismatch;
  - events dropped by self/bot filtering;
  - events dropped by channel/user policy;
  - events prepared for dispatch;
  - admissions recorded;
  - dispatch failures before admission.
- Ensure the admission ledger write point is early enough to distinguish:
  - Slack never delivered to OpenClaw;
  - OpenClaw received but dropped by policy;
  - OpenClaw received and attempted dispatch but failed;
  - OpenClaw dispatched but the agent/reply failed later.
- Add a compact `channels status` / `health` summary for recent Slack receiver
  and admission counters.

Acceptance:

- For a pasted missed permalink, the operator can tell which stage failed
  without reading raw logs.
- Watchdog output can cite the relevant local receiver/admission counters.

## Phase 4: Receiver Ownership Cleanup

Purpose: make the Slack plugin own Slack behavior cleanly.

- Keep Slack Socket Mode SDK interop and observer code in the Slack plugin.
- Avoid core special cases for Slack account ids or SoyLei channels.
- Expose only generic channel status fields through core.
- Add a narrow plugin-owned helper for status patching so lifecycle, receiver,
  and business liveness updates are named and testable.
- Revisit the current reconnect observer patch in
  `extensions/slack/src/monitor/provider-support.ts`; keep it only if tests show
  the Slack SDK still needs it.

Acceptance:

- Slack provider tests describe lifecycle state, raw receiver liveness, business
  event liveness, and disconnect handling as separate behaviors.
- Core channel health tests do not need Slack internals.

## Phase 5: Live Proving

Purpose: prove the overhaul against real Slack behavior.

- Patch the installed OpenClaw runtime with the committed overhaul.
- Verify gateway RPC health.
- Send controlled messages in SoyLei `ask-lei`:
  - top-level allowed message;
  - thread message;
  - bot/self message;
  - policy-dropped message if safe.
- Compare:
  - Slack Mirror receipt;
  - OpenClaw raw receiver status;
  - OpenClaw admission ledger;
  - agent turn/reply status;
  - watchdog scan result.
- Leave the scheduled watchdog enabled as a backstop until several live windows
  pass without missed admissions.

Acceptance:

- No unexplained `missing-admission` record for controlled live messages.
- No health-monitor `stale-socket` restart caused only by aged connect time.
- If a message is intentionally dropped, status explains why.

## Validation Matrix

Focused tests:

```bash
node scripts/run-vitest.mjs extensions/slack/src/monitor/provider.reconnect.test.ts
node scripts/run-vitest.mjs extensions/slack/src/monitor/provider.interop.test.ts
node scripts/run-vitest.mjs extensions/slack/src/monitor/message-handler.test.ts
node scripts/run-vitest.mjs extensions/slack/src/monitor/events/messages.test.ts
node scripts/run-vitest.mjs src/gateway/channel-health-policy.test.ts
node scripts/run-vitest.mjs src/gateway/channel-health-monitor.test.ts
```

Feature gates:

```bash
scripts/ec-main-rebase-gate.sh --family slack-responsiveness
scripts/ec-main-rebase-gate.sh --family slack-a2a
```

Live checks:

```bash
openclaw gateway status --deep --require-rpc
openclaw channels status --json
openclaw channels watchdog-status --account soylei --json
openclaw channels watchdog-scan --account soylei --target channel:C0B0AK14B7X --since 30m --json
```

## Definition Of Done

- Slack receiver lifecycle and raw event liveness are visible in status output.
- Generic health no longer restarts Slack solely because connect time aged out.
- Missed-message watchdog source replies are enabled for live scheduled scans.
- Admission gaps are classifiable as receiver, policy, dispatch, or reply
  failures.
- The plan is closed with focused tests, feature-family gates, and live Slack
  proof recorded.
