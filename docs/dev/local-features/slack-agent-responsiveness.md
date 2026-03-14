# Local Feature — Slack Agent Responsiveness

## Summary

This feature area is about making long-running Slack turns visible, steerable, and diagnosable.

The core belief is simple:

> If mid-turn steering is possible, mid-turn visibility is required.

## Status

- design and planning stage
- not yet implemented as a full runtime feature
- see `docs/dev/slack-turn-visibility-and-steering.md`

## Problem statement

Slack users currently cannot reliably tell the difference between:

- a short turn that is still running
- a long turn with no narration
- a tool/process wait
- a delivery failure
- a stranded reply
- a stalled session

That ambiguity makes steering weaker than it should be.

## Scope

- duration classes for turns
- deterministic progress signaling
- silent-turn watchers
- reply-stranded / delivery watchers
- turn-status / why-silent / steering surfaces
- delivery attribution between model, gateway, and Slack transport layers

## Why this exists

This need became obvious during the rebase/upgrade repair work: long operations were technically progressing, but without reliable machine-generated visibility, a human in Slack had to guess whether silence meant progress or failure.

## Proposed first slice

- turn-state timeline
- one silent-turn watcher
- `/turn-status`
- automatic medium/long-turn progress nudges

## User-visible success criteria

- medium/long turns emit at least one deterministic progress update
- stalled work becomes distinguishable from merely slow work
- user can inspect current phase and steerability
- delivery failures stop looking identical to model silence

## Related docs

- `docs/dev/slack-turn-visibility-and-steering.md`
- `docs/dev/local-feature-index.md`
