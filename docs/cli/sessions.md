---
summary: "CLI reference for `openclaw sessions` (list stored sessions + usage)"
read_when:
  - You want to list stored sessions and see recent activity
title: "Sessions"
---

# `openclaw sessions`

List stored conversation sessions.

Session lists are not channel/provider liveness checks. They show persisted
conversation rows from session stores. A quiet Discord, Slack, Telegram, or
other channel can reconnect successfully without creating a new session row
until a message is processed. Use `openclaw channels status --probe`,
`openclaw status --deep`, or `openclaw health --verbose` when you need live
channel connectivity.

`openclaw sessions` and Gateway `sessions.list` responses are bounded by
default so large long-lived stores cannot monopolize the CLI process or Gateway
event loop. The CLI returns the newest 100 sessions by default; pass
`--limit <n>` for a smaller/larger window or `--limit all` when you intentionally
need the full store. JSON responses include `totalCount`, `limitApplied`, and
`hasMore` when callers need to show that more rows exist.

RPC clients can pass `configuredAgentsOnly: true` to keep the broad combined
discovery source but return only rows for agents currently present in config.
Control UI uses that mode by default so deleted or disk-only agent stores do
not reappear in the Sessions view.

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --limit 25
openclaw sessions --verbose
openclaw sessions --json
```

Scope selection:

- default: configured default agent store
- `--verbose`: verbose logging
- `--agent <id>`: one configured agent store
- `--all-agents`: aggregate all configured agent stores
- `--store <path>`: explicit store path (cannot be combined with `--agent` or `--all-agents`)
- `--limit <n|all>`: max rows to output (default `100`; `all` restores full output)

Tail human-readable trajectory progress for stored sessions:

```bash
openclaw sessions tail
openclaw sessions tail --follow
openclaw sessions tail --session-key "agent:main:telegram:direct:123" --tail 25
openclaw sessions --agent work tail --follow
openclaw sessions --all-agents tail --follow
```

`openclaw sessions tail` renders recent trajectory JSONL events as compact progress lines. Without `--session-key`, it tails running sessions first, then the latest stored session. `--tail <count>` controls how many existing events print before follow mode; the default is `80`, and `0` starts at the current end. `--follow` keeps watching the selected trajectory files, including relocated files referenced by `<session>.trajectory-path.json`.

The progress view is intentionally conservative: prompt text, tool arguments, and tool result bodies are not printed. Tool calls show the tool name with `{...redacted...}`; tool results show status such as `ok`, `error`, or `done`; model completion lines show provider/model and terminal status.

Export a trajectory bundle for a stored session:

```bash
openclaw sessions export-trajectory --session-key "agent:main:telegram:direct:123" --workspace .
openclaw sessions export-trajectory --session-key "agent:main:telegram:direct:123" --output bug-123 --json
```

This is the command path used by the `/export-trajectory` slash command after
the owner approves the exec request. The output directory is always resolved
inside `.openclaw/trajectory-exports/` under the selected workspace.

`openclaw sessions --all-agents` reads configured agent stores. Gateway and ACP
session discovery are broader: they also include disk-only stores found under
the default `agents/` root or a templated `session.store` root. Those
discovered stores must resolve to regular `sessions.json` files inside the
agent root; symlinks and out-of-root paths are skipped.

JSON examples:

`openclaw sessions --all-agents --json`:

```json
{
  "path": null,
  "stores": [
    { "agentId": "main", "path": "/home/user/.openclaw/agents/main/sessions/sessions.json" },
    { "agentId": "work", "path": "/home/user/.openclaw/agents/work/sessions/sessions.json" }
  ],
  "allAgents": true,
  "count": 2,
  "totalCount": 2,
  "limitApplied": 100,
  "hasMore": false,
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "gpt-5" },
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-6" }
  ]
}
```

## Cleanup maintenance

Run maintenance now (instead of waiting for the next write cycle):

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --agent work --dry-run
openclaw sessions cleanup --all-agents --dry-run
openclaw sessions cleanup --enforce
openclaw sessions cleanup --enforce --active-key "agent:main:telegram:direct:123"
openclaw sessions cleanup --dry-run --fix-dm-scope
openclaw sessions cleanup --agent work --dry-run --max-entries 50
openclaw sessions cleanup --agent work --dry-run --prune-after 7d
openclaw sessions cleanup --agent work --dry-run --archive-artifacts
openclaw sessions cleanup --agent work --enforce --archive-artifacts --artifact-categories orphan-temp-store,orphan-trajectory
openclaw sessions --agent work archive list
openclaw sessions --agent work archive show --run <run-id>
openclaw sessions --agent work archive prune --run <run-id> --dry-run
openclaw sessions --agent work archive prune --run <run-id> --enforce
openclaw sessions report --agent work
openclaw sessions report --all-agents --json
openclaw sessions cleanup --json
```

`openclaw sessions cleanup` uses `session.maintenance` settings from config. For standard agent stores, `agents.list[].sessionMaintenance` merges over the global policy so service agents can use tighter retention without affecting interactive chats:

- Scope note: `openclaw sessions cleanup` maintains session stores, transcripts, and trajectory sidecars. It does not prune cron run history, which is managed by `cron.runLog.keepLines` in [Cron configuration](/automation/cron-jobs#configuration) and explained in [Cron maintenance](/automation/cron-jobs#maintenance).
- Cleanup also prunes unreferenced primary transcripts, compaction checkpoints, and trajectory sidecars older than `session.maintenance.pruneAfter`; files still referenced by `sessions.json` are preserved.
- Cleanup reports short-lived gateway model-run probe cleanup separately as `modelRunPruned`. This only matches strict explicit keys shaped like `agent:*:explicit:model-run-<uuid>`. The fixed retention is `24h`, but it is pressure-gated: it only removes stale probe rows when session-entry maintenance/cap pressure is reached. When it runs, model-run cleanup happens before global stale cleanup and capping.

- `--dry-run`: preview how many entries would be pruned/capped without writing.
  - In text mode, dry-run prints a per-session action table (`Action`, `Key`, `Age`, `Model`, `Flags`) plus a summary grouped by session label so you can see what would be kept vs removed.
- `--enforce`: apply maintenance even when `session.maintenance.mode` is `warn`.
- `--fix-missing`: remove entries whose transcript files are missing or header-only/empty, even if they would not normally age/count out yet.
- `--fix-dm-scope`: when `session.dmScope` is `main`, retire stale peer-keyed direct-DM rows left behind by earlier `per-peer`, `per-channel-peer`, or `per-account-channel-peer` routing. Use `--dry-run` first; applying the cleanup removes those rows from `sessions.json` and preserves their transcripts as deleted archives.
- `--active-key <key>`: protect a specific active key from disk-budget eviction. Durable external conversation pointers, such as group sessions and thread-scoped chat sessions, are also kept by age/count/disk-budget maintenance.
- `--max-entries <n>`: override `session.maintenance.maxEntries` for this one cleanup run.
- `--prune-after <duration>`: override `session.maintenance.pruneAfter` for this one cleanup run. Examples: `7d`, `12h`, `30m`.
- `--max-disk-bytes <size>`: override `session.maintenance.maxDiskBytes` for this one cleanup run. Examples: `50mb`, `1gb`.
- `--high-water-bytes <size>`: override `session.maintenance.highWaterBytes` for this one cleanup run.
- `--archive-artifacts`: move selected orphan/archive files into `.artifact-cleanup-archive/<run>/files/` and write a manifest before and after the move.
- `--artifact-categories <list>`: comma-separated artifact categories to archive. Supported values are `orphan-temp-store`, `orphan-trajectory`, and `archive`; the default is all three.
- `--max-artifacts <n>`: cap the number of artifact files archived in one run. The default for `--archive-artifacts` is `100`.
- `--agent <id>`: run cleanup for one configured agent store.
- `--all-agents`: run cleanup for all configured agent stores.
- `--store <path>`: run against a specific `sessions.json` file.
- `--json`: print a JSON summary. With `--all-agents`, output includes one summary per store.

When a Gateway is reachable, non-dry-run cleanup for configured agent stores is
sent through the Gateway so it shares the same session-store writer as runtime
traffic. Use `--store <path>` for explicit offline repair of a store file.

`openclaw sessions cleanup --all-agents --dry-run --json`:

```json
{
  "allAgents": true,
  "mode": "warn",
  "dryRun": true,
  "stores": [
    {
      "agentId": "main",
      "storePath": "/home/user/.openclaw/agents/main/sessions/sessions.json",
      "beforeCount": 120,
      "afterCount": 80,
      "missing": 0,
      "dmScopeRetired": 0,
      "pruned": 40,
      "capped": 0
    },
    {
      "agentId": "work",
      "storePath": "/home/user/.openclaw/agents/work/sessions/sessions.json",
      "beforeCount": 18,
      "afterCount": 18,
      "missing": 0,
      "dmScopeRetired": 0,
      "pruned": 0,
      "capped": 0
    }
  ]
}
```

## Artifact Archive Management

`openclaw sessions cleanup --archive-artifacts` writes archive runs under
`.artifact-cleanup-archive/` beside the selected session store. That directory
is ignored by git so repo-local maintenance runs do not stage generated archive
payloads by default.

```bash
openclaw sessions --agent work archive list
openclaw sessions --agent work archive show --run <run-id>
openclaw sessions --agent work archive prune --run <run-id> --dry-run
openclaw sessions --agent work archive prune --run <run-id> --enforce
openclaw sessions --agent work archive prune --older-than 30d --dry-run
```

`archive prune` requires either `--run` or `--older-than`. It defaults to
dry-run mode; pass `--enforce` to delete selected archive runs.
Use `sessions` parent scope flags before `archive`, for example
`openclaw sessions --json --agent work archive list`.

For recurring service-agent hygiene, review archive manifests first and then
set `agents.list[].sessionMaintenance.artifactArchiveRetention` to a bounded
duration such as `7d`. That lets normal session maintenance prune old
manifest-backed archive runs without applying the policy globally.

## Artifact Reports

Use `openclaw sessions report` before enabling aggressive cleanup policies. It
is read-only and classifies files in the target sessions directory by hot store,
referenced transcript, referenced trajectory, orphan transcript, orphan
trajectory, checkpoint, stale temp store, archive, and other categories.

```bash
openclaw sessions report --agent work
openclaw sessions report --agent work --largest 20
openclaw sessions report --all-agents --json
```

The report is intended to make disk-pressure cleanup decisions explicit before
an operator runs a mutating cleanup command. In particular, use it to inspect
large orphan trajectory files and archived transcript files before adding
`maxDiskBytes` or `highWaterBytes` to `session.maintenance` or
`agents.list[].sessionMaintenance`.

For service agents, prefer this order:

1. Run `openclaw sessions report --agent <id> --json`.
2. Preview artifact archiving with `openclaw sessions cleanup --agent <id> --dry-run --archive-artifacts --json`.
3. Apply a bounded archive pass with `openclaw sessions cleanup --agent <id> --enforce --archive-artifacts --max-artifacts <n>`.
4. Re-run `openclaw sessions report --agent <id> --json` before enabling disk-budget cleanup.

## Compact a session

Reclaim context budget for a wedged or oversized session. `openclaw sessions compact <key>` is the first-class wrapper around the `sessions.compact` gateway RPC and requires a running gateway.

```bash
openclaw sessions compact "agent:main:main"
openclaw sessions compact "agent:main:main" --max-lines 200
openclaw sessions compact "agent:work:main" --agent work --json
```

- Without `--max-lines`, the gateway LLM-summarizes the transcript. This can be slow, so the default `--timeout` is `180000` ms.
- With `--max-lines <n>`, it truncates to the last `n` transcript lines and archives the prior transcript as a `.bak` sidecar.
- `--agent <id>`: agent that owns the session; required for `global` keys.
- `--url` / `--token` / `--password`: gateway connection overrides.
- `--timeout <ms>`: RPC timeout in milliseconds.
- `--json`: print the raw RPC payload.

The command exits non-zero when the gateway reports a failed compaction or is unreachable, so crons and scripts never mistake a silent no-op for success.

> Note: `openclaw agent --message '/compact ...'` is **not** a compaction path. Slash commands from the CLI are rejected by the authorized-sender check; that invocation exits non-zero with guidance pointing here instead of silently no-opping.

### sessions.compact RPC

`openclaw gateway call sessions.compact --params '<json>'` accepts:

| Field      | Type        | Required | Description                                                |
| ---------- | ----------- | -------- | ---------------------------------------------------------- |
| `key`      | string      | yes      | Session key to compact (for example `agent:main:main`).    |
| `agentId`  | string      | no       | Agent id that owns the session (for `global` keys).        |
| `maxLines` | integer ≥ 1 | no       | Truncate to the last N lines instead of LLM summarization. |

Example LLM-summarize response:

```json
{
  "ok": true,
  "key": "agent:main:main",
  "compacted": true,
  "result": { "tokensBefore": 243868, "tokensAfter": 34941 }
}
```

Example truncate response (`--max-lines 200`):

```json
{
  "ok": true,
  "key": "agent:main:main",
  "compacted": true,
  "archived": "/home/user/.openclaw/agents/main/sessions/transcripts/<id>.jsonl.bak",
  "kept": 200
}
```

## Related

- Session config: [Configuration reference](/gateway/config-agents#session)
- [CLI reference](/cli)
- [Session management](/concepts/session)
