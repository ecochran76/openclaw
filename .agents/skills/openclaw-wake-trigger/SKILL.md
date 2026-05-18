---
name: openclaw-wake-trigger
description: Set bounded wake triggers so an OpenClaw agent can yield while waiting for long-running work, then resume the same session when success, failure, or timeout occurs.
---

# OpenClaw Wake Trigger

Use this when an agent needs to wait for an external condition before it can
finish a user request, especially in Slack threads where a long model turn would
otherwise stall or time out.

## Required Pattern

1. Start the long-running work in a deterministic script or background process.
2. Create a wake trigger with explicit success and failure predicates.
3. Tell the user what is being watched and that the agent will resume when the
   trigger fires.
4. End the current turn. Do not keep polling inside the model turn.

## Command

Use the installed script when present:

```bash
node ~/.openclaw/workspace/scripts/wake-trigger.mjs set \
  --name soylei-dev-sync \
  --agent soylei-website \
  --session-key agent:soylei-website:slack:channel:c06l8dvbwqp:thread:1779054888.591249 \
  --success-cmd 'test -f /tmp/soylei-dev-sync.done' \
  --failure-cmd 'test -f /tmp/soylei-dev-sync.failed' \
  --timeout-minutes 45 \
  --max-attempts 1 \
  --max-automated-resumes 1 \
  --reply-channel slack \
  --reply-account soylei \
  --reply-to C06L8DVBWQP \
  --active-reaction alarm_clock \
  --reaction-message-id 1779054888.591249 \
  --human-ack-reaction warning \
  --deliver \
  --on-success 'The live-to-dev sync completed. Continue validation in this thread and report the result.' \
  --on-failure 'The live-to-dev sync failed. Inspect the diagnostic file and report the next safe recovery step.' \
  --on-timeout 'The live-to-dev sync did not finish before the wake trigger timeout. Check the background job and report current state.'
```

Run pending triggers:

```bash
node ~/.openclaw/workspace/scripts/wake-trigger.mjs check
```

Install or refresh the recurring checker:

```bash
node /home/ecochran76/workspace.local/openclaw.git/scripts/install-wake-trigger-checker.mjs \
  --script ~/.openclaw/workspace/scripts/wake-trigger.mjs \
  --env-file ~/credentials/API-keys.env \
  --apply \
  --enable
```

The checker is a systemd user timer, not a long-lived watch process. It wakes
every few minutes, evaluates durable trigger records, and exits.
The timer service must load the same OpenClaw gateway auth environment that
interactive commands use; on this workstation that is
`~/credentials/API-keys.env`.

### Active Reactions

For Slack-backed triggers, set a visible reaction on the user message while the
trigger is active:

```bash
--active-reaction alarm_clock \
--reaction-message-id 1779054888.591249 \
--reaction-target C06L8DVBWQP \
--reaction-channel slack
```

`--reaction-target` defaults to `--reply-to`, and `--reaction-channel` defaults
to `--reply-channel`. The checker removes the active reaction when the trigger
is delivered, exhausted, cancelled, or moved to `requires_human_ack`. If
`--human-ack-reaction` is set, the checker replaces the active reaction with
that reaction when human acknowledgement is required.

Reaction add/remove is best-effort. A reaction failure is recorded on the trigger
as `lastReactionError`, but it must not block trigger creation, checking, or
resume delivery.

Inspect triggers:

```bash
node ~/.openclaw/workspace/scripts/wake-trigger.mjs list
node ~/.openclaw/workspace/scripts/wake-trigger.mjs show --id <trigger-id>
```

Remove a trigger:

```bash
node ~/.openclaw/workspace/scripts/wake-trigger.mjs rm --id <trigger-id>
```

If the installed script is missing, use the source checkout path:
`node /home/ecochran76/workspace.local/openclaw.git/scripts/wake-trigger.mjs`.

## Dynamic Limits

The user can set limits for the current session:

```bash
node ~/.openclaw/workspace/scripts/wake-trigger.mjs defaults set \
  --scope session \
  --session-key agent:soylei-website:slack:channel:c06l8dvbwqp:thread:1779054888.591249 \
  --max-automated-resumes 2 \
  --timeout-minutes 45 \
  --max-attempts 1
```

The user can set permanent global defaults for future triggers:

```bash
node ~/.openclaw/workspace/scripts/wake-trigger.mjs defaults set \
  --scope global \
  --max-automated-resumes 1 \
  --timeout-minutes 60 \
  --max-attempts 1
```

Show effective defaults:

```bash
node ~/.openclaw/workspace/scripts/wake-trigger.mjs defaults show \
  --session-key agent:soylei-website:slack:channel:c06l8dvbwqp:thread:1779054888.591249
```

If a trigger reaches `requires_human_ack`, a human/operator must acknowledge the
session before further automatic wake resumes. Do not run this command
autonomously to bypass the guard; it represents human permission to continue:

```bash
node ~/.openclaw/workspace/scripts/wake-trigger.mjs ack \
  --session-key agent:soylei-website:slack:channel:c06l8dvbwqp:thread:1779054888.591249
```

## Guardrails

- Always set `--max-attempts`. Use `1` unless there is a concrete reason to
  retry failed resume delivery.
- Keep `--max-automated-resumes` low. Use `1` unless the user explicitly allows
  a multi-step autonomous continuation chain.
- Always set `--timeout-minutes` so the user gets a failure-style resume instead
  of silence.
- For Slack turns, prefer `--active-reaction alarm_clock` with the inbound
  message ts so the user can see that a bounded wake trigger is armed. Do not
  use OpenClaw's normal hourglass reaction for wake triggers.
- Prefer file predicates written by deterministic scripts over broad shell
  greps.
- Do not set a trigger that runs an unbounded, mutating, or destructive
  predicate.
- Use `--dry-run` with `check` when validating a new trigger design.

## Good Predicate Shape

```bash
--success-cmd 'test -f /path/to/job.done'
--failure-cmd 'test -f /path/to/job.failed'
```

If the watched script can write JSON, make it emit explicit state files:

```bash
--success-cmd 'jq -e ".status == \"complete\"" /path/to/status.json'
--failure-cmd 'jq -e ".status == \"failed\"" /path/to/status.json'
```

## Yield Message Template

After setting a trigger, tell the user:

```text
I started the background sync and registered a bounded wake trigger. I am ending
this turn now; OpenClaw will resume me in this same thread when the sync
finishes, fails, or times out.
```

## Failure Semantics

The trigger checker marks records terminal after a successful resume. If resume
delivery fails, it records `resume_failed`, increments attempts, and only retries
while below `maxAttempts` and after `cooldownSeconds`.

## Human-Ack Semantics

`maxAutomatedResumes` is counted by session key, not by trigger id. This prevents
an agent from creating trigger after trigger and waking itself indefinitely. Once
the session reaches the configured limit, later ready triggers move to
`requires_human_ack` and do not resume the agent until `ack` resets the session
counter.
