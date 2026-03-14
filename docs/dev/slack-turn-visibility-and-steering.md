# Slack Turn Visibility and Steering

## Problem statement

Slack users need deterministic visibility into what an active turn is doing.

Without that, the user cannot tell whether a turn is:

- quick and still running
- long and healthy
- stalled in a tool/process wait
- finished but not delivered
- blocked on a transport or gateway problem

That ambiguity is especially bad when mid-turn steering is otherwise possible.

## Core principle

If a user can steer an active turn, the runtime must expose enough turn state for the user to know **what they are steering**.

## Proposed turn model

Each active turn should track at least:

- `turnId`
- `sessionKey`
- `channel`
- `threadId`
- `startedAt`
- `durationClass`
- `phase`
- `status`
- `steerable`
- `lastProgressAt`
- `lastUserVisibleUpdateAt`
- `activeTool`
- `activeProcessId`
- `deliveryState`
- `lastError`

## Duration classes

- `instant`: under 5 seconds
- `short`: 5 to 20 seconds
- `medium`: 20 to 90 seconds
- `long`: over 90 seconds
- `open-ended`: unknown / iterative / heavy tool/browser/exec work

## Default progress behavior

- `instant`: no progress message
- `short`: usually silent
- `medium`: one early status update
- `long` / `open-ended`: mandatory progress updates

## Phase model

Suggested phases:

- `received`
- `reasoning`
- `tool_dispatch`
- `tool_wait`
- `apply_changes`
- `test_validate`
- `delivery_prepare`
- `delivery_attempt`
- `done`
- `blocked`
- `stalled`

## Watchers

These should be runtime-driven, not model-optional.

### 1. No-first-progress watcher

If a medium/long turn has produced no progress signal by its deadline, emit one.

### 2. Tool-wait watcher

If a process/tool is still active after a threshold, emit machine-generated status.

### 3. Reply-stranded watcher

If the agent finished substantive work but no user-visible reply was delivered, emit status or failure attribution.

### 4. Delivery watcher

Track whether the model produced a reply but Slack/gateway delivery failed.

### 5. Stalled-turn watcher

If no turn-state transition occurs for too long, mark the turn stalled and notify.

## Slack UX goals

Generated updates should be terse and operational, for example:

- `working: checking upgrade logs`
- `working: rebasing ec-main onto v2026.3.13`
- `working: resolving sessions_send conflicts`
- `working: running focused validation`
- `blocked: semantic conflict, need guidance`

## Steering surfaces

Candidate commands:

- `/turn-status`
- `/why-silent`
- `/turns`
- `/steer`
- `/nudge`

### `/turn-status` should include

- current phase
- duration class
- active tool/process
- steerability
- last meaningful progress time
- delivery state
- last error

## Implementation status

### Slice 1 — landed

Shipped on `ec-main` in `498f59a1c`:

- turn-state timeline
- silent-turn watcher
- `/turn-status`
- automatic medium/long-turn progress nudges

### Slice 2 — landed as a series

Shipped on `ec-main` across:

- `05571e149` — delivery attribution surfaced in runtime state and `/status`
- `987865f7c` — machine-generated reply-delivery failure notices
- `5f9754034` — suppressed replies distinguished from delivery failures
- `f8523c896` — `/why-silent`
- `1f104770f` — explicit `reply_stranded` finalization

Detailed plan/history:

- `docs/dev/slack-turn-slice-2-delivery-attribution-plan.md`

### Slice 3 — planned next

- steering hooks
- richer turn inspection
- stalled-turn watcher / recovery tooling
- detailed plan: `docs/dev/slack-turn-slice-3-steering-and-watchers-plan.md`

## Why this should be a first-class runtime feature

This cannot depend on the model remembering to narrate.

Human trust in long-running Slack turns improves only when the runtime itself can guarantee basic progress visibility.
