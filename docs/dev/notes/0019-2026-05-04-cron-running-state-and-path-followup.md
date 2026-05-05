# 0019 - 2026-05-04 - Cron Running State And Path Follow-Up

State: OPEN
Created: 2026-05-04

## Context

While validating the SoyLei daily provenance harvest cron, a manual
`openclaw cron run` exposed two runtime hardening issues.

## Evidence

- The cron job `a53a4de9-a0c0-4b97-9ecd-c60265f911f6` accepted a manual run
  and recorded a successful completion for run timestamp `1777956084022`.
- The cron agent had a narrower process environment than an interactive shell.
  A nested Python wrapper that called `openclaw agent` by name failed with
  `FileNotFoundError: [Errno 2] No such file or directory: 'openclaw'`.
- A later manual enqueue returned `{ "ok": true, "enqueued": true }`, launched
  nested agent work, then hit a Codex network error near finalization.
- After the nested process exited and no matching local process remained,
  `openclaw cron show ... --json` still reported
  `state.runningAtMs: 1777956481302`.
- The newer run did not appear at the top of `openclaw cron runs --id ...`,
  while gateway logs showed nested packet work executing.

## Impact

Operators can see a cron job as still running even after the underlying process
is gone, and manual reruns can be accepted while the visible state remains
ambiguous. This makes timer validation noisy and may hide whether the last
manual run actually finalized, failed, or only partially executed.

## Suggested Fix

- Ensure cron finalization clears `runningAtMs` on all exit paths, including
  nested agent network errors and manual-run enqueue paths.
- Add a cron doctor/status check that detects `runningAtMs` without an active
  run/session/process and offers a safe repair.
- Consider exposing a `cron repair-state <id>` or similar operator command
  instead of requiring direct JSON edits or a gateway restart.
- Document the environment contract for cron agents. If invoking the OpenClaw
  CLI from cron-agent tools is supported, provide a stable `OPENCLAW_BIN` or
  include the installed CLI directory in PATH.

## Local Workaround

`company-bot` now resolves the OpenClaw binary to an absolute path before
starting nested Lei drain turns, and the daily harvest runner takes a file lock
inside the daily artifact directory so concurrent runs do not corrupt the same
transcript.
