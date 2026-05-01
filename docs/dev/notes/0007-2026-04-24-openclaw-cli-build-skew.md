# OpenClaw CLI Build Skew

State: OPEN
Created: 2026-04-24

## 2026-05-01 Review

This note is partially acted on but remains open as an operator lesson:

- `scripts/patch-live-openclaw.sh` now patches both observed global npm install
  targets (`v24.13.0` and `v24.14.0`) during live patch, which reduces the
  practical CLI/gateway skew that triggered the incident.
- Gateway status output reports the live service command path, config path, and
  Node-managed service location, which makes current skew easier to spot.
- The stronger acceptance criteria still stand: stale or wrong-path CLIs should
  make build-hash/schema compatibility mismatch impossible to miss, and
  per-agent heartbeats still need a clearer first-class inspection surface.

## Summary

The interactive shell was resolving `openclaw` through the active Node `v24.14.0`
global install, while the running gateway service was using the OpenClaw package
installed under Node `v24.13.0`.

This produced misleading heartbeat debugging signals:

- the old interactive CLI warned that the config was written by a newer
  OpenClaw version
- `openclaw cron list` returned no jobs, which was interpreted as missing the
  Odollo heartbeat job
- direct `openclaw agent --agent odollo-soylei ...` still worked because the
  agent and gateway config were otherwise valid

The immediate operator fix was to realign the active shell CLI to the same build
used by the gateway:

```text
OpenClaw 2026.4.23 (98a27c3)
```

## Environment

- Config repo: `/home/ecochran76/.openclaw`
- Config writer: `2026.4.23`
- Gateway process:
  `/home/ecochran76/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/dist/index.js`
- Gateway build: `OpenClaw 2026.4.23 (98a27c3)`
- Previous shell CLI path:
  `/home/ecochran76/.nvm/versions/node/v24.14.0/bin/openclaw`
- Previous shell CLI build: `OpenClaw 2026.4.15-beta.1 (1cfba61)`

## Build Skew Found

Installing `openclaw@2026.4.23` from npm under Node `v24.14.0` did not produce
the same behavior as the gateway package already installed under Node `v24.13.0`.

Observed registry install:

```text
OpenClaw 2026.4.23 (a979721)
```

That package rejected the current config with:

```text
session.agentToAgent: Unrecognized key: "relay"
```

The gateway-local package with the same version string accepts and runs the
current config:

```text
OpenClaw 2026.4.23 (98a27c3)
Config valid: ~/.openclaw/openclaw.json
```

This means the package version alone is not sufficient to identify config schema
compatibility. The build hash materially matters, and two packages using the
same `2026.4.23` version string exposed different schema support.

## Cron vs Heartbeat Clarification

`openclaw cron list` returning `No cron jobs.` is expected for the observed
Odollo SoyLei heartbeat. The heartbeat is configured under the agent definition:

```json
{
  "id": "odollo-soylei",
  "heartbeat": {
    "every": "30m"
  }
}
```

It is surfaced by `openclaw status` as a heartbeat, not as a cron job.

## Recommended Fixes

- Make CLI/gateway version mismatch explicit in `openclaw status --deep`,
  including package path, Node version, semantic version, and build hash.
- Make config validation errors include both the CLI build hash and the config
  writer build hash when available.
- Prevent publishing different schema behavior under the same version string, or
  include a schema compatibility identifier independent of package version.
- Consider adding `openclaw heartbeat list` or similar, so operators do not use
  `cron list` to infer per-agent heartbeat registration.

## Acceptance Criteria

- A stale or wrong-path CLI clearly reports that it is not the same build as the
  running gateway.
- `openclaw@2026.4.23` from the public install source validates the same config
  schema as the gateway package with version `2026.4.23`, or the version/build
  mismatch is impossible to miss.
- Per-agent heartbeats have a first-class list/inspect command distinct from
  cron jobs.
