# Slack Cold-Start Hardening

State: OPEN
Created: 2026-04-29

## Current State

Slack can report as transport-connected while the operator sees no response after a reboot or config reload. Recent fieldwork showed three distinct failure classes that are too easy to conflate:

- Slack Socket Mode/gateway connectivity.
- Inbound authorization or mention-gating drops.
- Heavy startup work, especially plugin/MCP/skill staging, delaying channel readiness or starving the event loop.

The current diagnostics are insufficient because a healthy channel status can still hide event-loop delay, Socket Mode churn, or intentional inbound drops. Some drop paths are verbose-only or silent, which makes cold-start regressions hard to distinguish from allowlist, tenant, mention, or self-message behavior.

2026-04-29 follow-up evidence from the SoyLei `#website` tenant showed a fourth
coupled failure mode: bundled runtime-dependency mirror refresh exposed a
transient missing root chunk during Slack plugin registration
(`dist/setup-*.js`, `dist/mcp-stdio-*.js`). The gateway could then restart or
run without Slack registered while later heavy agent/tool materialization caused
long event-loop stalls, Socket Mode ping/pong misses, and Bolt
`client is not ready` errors.

2026-04-29 second follow-up: provider runtime hook resolution now defaults to
non-installing bundled runtime dependency lookups. Gateway startup/preflight and
explicit repair paths remain responsible for staging bundled runtime deps; live
agent-turn hook lookup should not perform dependency install work on the same
event-loop path that owns Slack Socket Mode.

## Scope

- Make Slack inbound drops explicit, structured, and content-redacted.
- Add readiness/status evidence that separates transport, listener, authorization, and reply-path health.
- Reduce cold-start coupling between Slack listener readiness and heavyweight plugin/MCP/skill startup.
- Add watchdog/recovery behavior for known Socket Mode/event-loop stall signatures.
- Keep changes generic to Slack runtime behavior; do not encode local tenant IDs or user-specific policy into core/product code.

## Non-Goals

- Do not commit local Slack tokens, tenant IDs, or user-specific channel bindings.
- Do not rewrite Slack transport architecture in one pass.
- Do not make API-authored bot/self messages a substitute for human inbound smoke unless Slack Events delivery semantics prove they are equivalent.
- Do not move unrelated provider/plugin startup policy into the Slack plugin.

## Phases

1. Inbound drop diagnostics.
   - Log every intentional Slack inbound drop through a structured, content-redacted path.
   - Include account id, channel id, channel type, sender id or bot id, subtype, timestamp, and stable reason code.
   - Cover bot/self drops, disabled bot forwarding, missing sender, channel deny, DM deny, channel user deny, command deny, mention gating, and empty-content drops.

2. Slack readiness/status smoke surface.
   - Add or extend status output so operators can see Slack listener mode, account readiness, event timestamp progress, recent inbound drops, and recent successful prepared inbound events.
   - Prefer a CLI/status surface that can be used after reboot without inspecting raw journal logs.

3. Startup ordering and deferral.
   - Audit gateway startup so Slack transport can become ready before nonessential plugin/MCP/skill staging finishes.
   - Defer or isolate heavyweight bundle setup that is not required for receiving Slack events.
   - Preserve deterministic plugin policy and deny-list semantics.
   - Replace bundled runtime mirror chunks without an unlink gap so another
     process cannot observe a missing `dist/*.js` file during plugin import.
   - Default provider hook lookup to non-installing bundled runtime dependency
     resolution; startup/preflight or explicit repair flows must perform heavy
     staging before live channel dispatch needs those hooks.

4. Watchdog and recovery.
   - Detect Socket Mode disconnect/ping-pong timeout and high event-loop-delay patterns.
   - Add bounded recovery actions that restart the affected Slack account/listener without requiring full gateway churn where feasible.
   - Ensure recovery is observable through status/logs.

5. Regression fixtures and live runbook evidence.
   - Add targeted tests for authorization/drop visibility and cold-start-safe startup boundaries.
   - Record live smoke procedure for real human Slack client messages, `/status`, and normal prompt handling.
   - Keep synthetic/API Slack sends labeled as outbound-write proof, not inbound-event proof, unless delivery semantics are verified.

## Validation

- Targeted Slack monitor tests for changed drop behavior.
- `scripts/ec-main-rebase-gate.sh --family slack-responsiveness` before live patching a completed responsiveness slice.
- `pnpm build` before live patching startup/runtime changes.
- Live gateway verification after patch:
  - gateway RPC status succeeds.
  - Slack status reports account/listener readiness.
  - a real human Slack client message produces either a prepared inbound event or a structured drop reason.

## Definition Of Done

- A reboot/cold-start Slack silence report can be classified from first-party diagnostics without guessing whether the fault is transport, policy drop, event-loop starvation, or reply delivery.
- Slack listener readiness is not blocked by avoidable heavyweight tool/plugin initialization.
- Known Socket Mode churn signatures have bounded recovery or an explicit operator action.
- The live patch handoff includes validation commands, runtime status, residual risks, and the best next step.
