State: COMPLETE
Created: 2026-05-30
Completed: 2026-05-30

# Slack Health And Diagnostics Remediation

## Current State

Plan `docs/dev/plans/0008-2026-05-30-slack-connector-overhaul.md`
separated Slack Socket Mode receiver facts from business-message admissions.
That was the right direction, but follow-up audit found the remaining health
and diagnostic model is still too willing to leave operators with the old
`stale-socket` explanation.

For Slack Socket Mode, `stale-socket` should mean a concrete Slack/network
transport outage or SDK lifecycle failure. It must not be used as a generic
reason for OpenClaw non-responsiveness when Slack delivered the event and the
real failure happened in filtering, admission, dispatch, agent execution, or
reply delivery.

Current gaps:

- Generic channel health still evaluates only `connected` and
  `lastTransportActivityAt`; Slack-specific `lastSocketError`,
  `lastSocketDisconnectedAt`, `lastSocketEnvelopeAt`, and `lastSlackEventAt`
  are mostly status-display facts.
- Slack `error` lifecycle events update `lastSocketError` and `lastError`
  without necessarily changing `connected`, so some SDK/network failures do not
  drive health or restart.
- `why-silent`, `channels status`, and watchdog health output still emphasize
  `lastTransportActivityAt`, even though Slack now intentionally leaves that
  field unset for Socket Mode.
- Reconnect success clears `lastError` but not stale forensic socket fields,
  which is safe for display only but unsafe if those fields become health
  inputs without lifecycle comparison.

## Completion Proof

Source validation:

- Focused Slack health/diagnostics suite:
  `node scripts/run-vitest.mjs src/gateway/channel-health-policy.test.ts src/gateway/channel-health-monitor.test.ts extensions/slack/src/monitor/provider.reconnect.test.ts extensions/slack/src/monitor/provider.interop.test.ts extensions/slack/src/monitor/events/messages.test.ts extensions/slack/src/monitor/message-handler.test.ts extensions/slack/src/monitor/message-handler/prepare.test.ts src/commands/channels/why-silent.test.ts src/commands/channels/slack-watchdog-scan.test.ts src/commands/channels/status.test.ts src/infra/channels-status-issues.test.ts`
  passed with 15 files and 358 tests.
- Slack responsiveness gate:
  `node scripts/run-vitest.mjs src/auto-reply/reply/dispatch-from-config.test.ts src/auto-reply/reply/commands-turn-status.test.ts src/auto-reply/turn-tracker.test.ts`
  passed with 3 files and 161 tests.
- `git diff --check` passed.
- `$autoreview` clean: no accepted/actionable findings after fixing two
  diagnostics-ordering findings:
  - candidate-specific Slack admission ledger proof now wins over later/current
    socket state;
  - the Slack-specific `socket-receiver-problem` verdict is scoped to Slack.

Installed runtime proof:

- `scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch --patch-external-plugin slack`
  rebuilt OpenClaw, installed the root tarball, installed the external Slack
  plugin tarball, refreshed the registry, restarted the systemd user gateway,
  and verified gateway RPC.
- `openclaw channels status --json` after the post-install probe showed SoyLei
  Slack connected and healthy with:
  - `lastSocketConnectedAt=1780181838367`
  - `lastSocketEnvelopeAt=1780181917905`
  - `lastSlackEventAt=1780181917905`
  - `lastInboundAt=1780181910566`
  - `rawSocketEnvelopes=8`, `rawSlackEvents=7`, `messageEvents=2`,
    `admissionsRecorded=2`, `preparedForDispatch=2`,
    `droppedSelfBotEvents=5`, `droppedEvents=5`
- Controlled post-install Slack probe:
  `https://soyleiinnovations.slack.com/archives/C0B0AK14B7X/p1780181908983929`
  advanced SoyLei receiver telemetry and was classified by installed
  `openclaw channels why-silent` as `account-inbound-after-message`, with the
  explanation that candidate-specific Slack admission ledger proof exists.
- Installed watchdog proof for the same permalink returned
  `admitted=1`, `not-relevant=1`, `missing-admission=0`; the bot response was
  classified as `not-relevant` / `bot-message`, not a socket failure.
- Earlier controlled thread proof for
  `thread_ts=1780176757.598359` returned `admitted=1`, `not-relevant=1`,
  `missing-admission=0`.

Live policy-drop proof was not forced because manufacturing that state would
require mutating live Slack policy/app membership or using a disallowed sender.
Policy-drop behavior is covered by focused tests and candidate-specific ledger
classification; live self/bot drops are covered by the installed watchdog proof
above.

## Goal

Make Slack health and diagnostics answer this question with evidence:

> Did Slack fail to deliver to OpenClaw, or did OpenClaw receive the event and
> then drop, fail to admit, fail to dispatch, fail during the turn, or fail to
> reply?

## Non-Goals

- Do not reintroduce connect-time `lastTransportActivityAt` for Slack.
- Do not make Slack Mirror a runtime dependency.
- Do not add SoyLei-specific health policy to core.
- Do not hide missed-message recovery behind automatic replay without an
  explicit write gate.
- Do not change Slack app scopes or tokens unless the diagnostics prove a real
  token/app mismatch.

## Phase 1: Define Slack Health Semantics

Purpose: make `stale-socket` exceptional and evidence-backed.

- Add a Slack-owned health classifier in the Slack plugin, or a narrow generic
  SDK-lifecycle health contract if a plugin status hook cannot influence the
  health monitor cleanly.
- Treat `connected=false`, recent disconnect, reconnecting loops, and current
  socket errors as Slack receiver health problems.
- Treat recent `lastSocketEnvelopeAt` or `lastSlackEventAt` after the current
  lifecycle start as receiver-liveness proof.
- Leave quiet but connected Slack sockets healthy when there is no SDK error or
  disconnect evidence.
- Avoid labeling missing admissions as `stale-socket` when raw receiver facts
  prove Slack delivered traffic to OpenClaw.

Acceptance:

- A connected Slack account with no `lastTransportActivityAt` and no socket
  error is healthy after the stale threshold.
- A Slack account with a current SDK/network error is unhealthy even if
  `connected` has not flipped false.
- A Slack account with raw receiver activity after `lastStartAt` is never
  classified as stale solely because business-message admission is quiet.
- Existing Telegram, WhatsApp, Discord, and Matrix transport semantics are not
  changed.

## Phase 2: Make Lifecycle Fields Safe For Health

Purpose: prevent old outage facts from poisoning new health decisions.

- On successful Slack Socket Mode connect, clear or supersede current socket
  failure state:
  - `lastSocketError`
  - current disconnect/error reason if one is introduced
  - reconnecting/error health flags
- Preserve historical fields only as clearly historical timestamps, or compare
  them against `lastSocketConnectedAt` / `lastStartAt` before using them.
- Add tests for error -> reconnect -> healthy transitions.

Acceptance:

- A past `lastSocketError` before the latest `lastSocketConnectedAt` does not
  keep the account unhealthy.
- A current `lastSocketError` after the latest connect does keep the account
  unhealthy until reconnect/success clears or supersedes it.

## Phase 3: Upgrade Operator Diagnostics

Purpose: make status surfaces explain the real stage of failure.

- Update `channels status` Slack output to include compact receiver/admission
  facts:
  - socket connected/reconnecting/disconnected/error state;
  - raw envelope age;
  - raw Slack event age;
  - message/admission/drop/dispatch-failure counters.
- Update `channels why-silent` for Slack to prefer:
  - newest Slack history message time;
  - `lastSocketEnvelopeAt` / `lastSlackEventAt`;
  - `lastInboundAt`;
  - admission ledger result for the candidate message when available;
  - `slackTelemetry` counters.
- Update watchdog health diagnostics to include socket timestamps and
  `lastSocketError`, not just old transport age and counters.
- Make wording explicit:
  - "Slack/network receiver problem" only when socket evidence supports it.
  - "received by OpenClaw but not admitted" when raw receiver counters advanced
    and the admission ledger has no accepted/dropped record.
  - "dropped by policy/self/bot" when counters or admission records say so.
  - "dispatch failed before admission/reply" when dispatch failure counters or
    logs indicate that stage.

Acceptance:

- For a pasted permalink, an operator can distinguish:
  - Slack did not deliver to OpenClaw;
  - OpenClaw received raw Slack traffic but not this message event;
  - OpenClaw received the message event and dropped it;
  - OpenClaw admitted it but dispatch/turn/reply failed.
- `why-silent` no longer presents missing Slack `lastTransportActivityAt` as a
  meaningful absence for Socket Mode accounts.

## Phase 4: Event Listener Coverage Review

Purpose: ensure all event paths either update the right counters or clearly opt
out.

- Review message, app mention, reactions, member events, pins, channel events,
  interactions, assistant events, and slash commands.
- Ensure raw Socket Mode receipt is counted before Bolt/business filtering.
- Ensure message-event counters are counted for candidate user messages before
  policy/admission decisions.
- Ensure system-event drops from authorization/policy either have telemetry or
  are explicitly out of the user-message responsiveness path.
- Keep admission-ledger writes reserved for message events that can affect
  user-visible responsiveness; do not pollute it with unrelated app home or
  channel metadata events.

Acceptance:

- Tests cover message received -> policy drop -> admission/drop record.
- Tests cover duplicate/self/bot drops without claiming Slack/network failure.
- Tests cover raw event received but no message admission so watchdog/why-silent
  reports an admission gap rather than stale socket.

## Phase 5: Validation And Live Proof

Purpose: prove the diagnostic model against real Slack behavior.

- Focused tests:

```bash
node scripts/run-vitest.mjs \
  src/gateway/channel-health-policy.test.ts \
  src/gateway/channel-health-monitor.test.ts \
  extensions/slack/src/monitor/provider.reconnect.test.ts \
  extensions/slack/src/monitor/provider.interop.test.ts \
  extensions/slack/src/monitor/events/messages.test.ts \
  extensions/slack/src/monitor/message-handler.test.ts \
  extensions/slack/src/monitor/message-handler/prepare.test.ts \
  src/commands/channels/why-silent.test.ts \
  src/commands/channels/slack-watchdog-scan.test.ts \
  src/commands/channels/status.test.ts
```

- Run Slack responsiveness gate from `docs/dev/local-feature-index.md`.
- Live patch with:

```bash
scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch --patch-external-plugin slack
```

- Live probes:
  - `openclaw gateway status --deep --require-rpc`
  - `openclaw channels status --json`
  - controlled top-level, thread, self/bot, and policy-dropped Slack messages
  - `openclaw channels why-silent` against a controlled message
  - watchdog dry-run against a controlled permalink

Acceptance:

- Live `channels status --json` shows Slack receiver fields after controlled
  raw traffic.
- Controlled user messages do not produce unexplained `missing-admission`.
- Controlled policy/self/bot drops are explained as drops, not socket staleness.
- If a simulated/current socket error exists, health reports a Slack/network
  receiver problem with the error evidence.

## Definition Of Done

- Slack health no longer depends on stale generic transport age for Socket Mode.
- `stale-socket` is either unused for Slack Socket Mode or reserved for a
  concrete Slack/network receiver outage with lifecycle evidence.
- Operator surfaces use Slack receiver/admission facts before suggesting
  restart or socket staleness.
- Focused tests, Slack responsiveness gate, live patch, and live Slack proof all
  pass.
- Plan `0008` remains the completed receiver-overhaul record; this plan closes
  only after the health/diagnostic remediation is proven.
