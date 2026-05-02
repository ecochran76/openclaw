# 0014 - 2026-05-02 - Odollo imcli MCP Re-Smoke And Gateway Import Blocker

State: RESOLVED
Created: 2026-05-02
Reviewed: 2026-05-02

## Summary

Odollo re-smoked the `imcli` MCP path after `imcli` was upgraded to `0.1.24`.
The `imcli` MCP protocol issue is fixed: direct MCP stdio probes and OpenClaw
installed-runtime materialization both succeed.

The remaining blocker is in OpenClaw's live gateway agent dispatch path. A
gateway-dispatched `odollo-soylei` agent smoke failed before agent execution
with a missing dynamic import from the globally installed OpenClaw package. The
CLI then fell back to the embedded runner, and that fallback successfully used
`imcli__list_accounts`.

## Evidence

`imcli` runtime checks:

```text
imcli --version
0.1.24
```

```text
imcli service status --json
success=true, data.ok=true
```

```text
imcli doctor --tenant default --json
success=true, data.ok=true
```

Direct MCP protocol checks:

- `Content-Length` framed initialize plus `tools/list` succeeded.
- Newline-delimited initialize plus `tools/list` succeeded.
- The same configured command and cwd as OpenClaw were used:
  `/home/ecochran76/.local/share/pnpm/imcli --tenant default mcp`
  with cwd `/home/ecochran76/workspace.local/imcli`.

OpenClaw installed-runtime materialization against the exact current
`~/.openclaw/openclaw.json` succeeded:

```text
materialized 69
imcli_count 50
graphiti_count 19
first_imcli imcli__adapter_migration_readiness,imcli__adapter_migration_readiness_report,imcli__auth_handoff_status,imcli__backfill_whatsapp_history,imcli__cancel_auth_handoff,imcli__canonical_messages,imcli__configure_live_sync,imcli__create_account,imcli__create_selected_result_report,imcli__create_tenant
```

## Gateway Failure

After a controlled gateway restart, a live `openclaw agent --agent
odollo-soylei ...` smoke failed through the gateway path:

```text
EMBEDDED FALLBACK: Gateway agent failed; running embedded agent: GatewayClientRequestError: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/ecochran76/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/dist/transcript-resolve.runtime-Djgr04ZR.js' imported from /home/ecochran76/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/dist/agent-command-CvybDRXZ.js
```

Gateway logs also showed a related lazy import failure:

```text
[model-catalog] Failed to load model catalog: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/ecochran76/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/dist/provider-runtime-B3qmO6yf.js' imported from /home/ecochran76/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/dist/provider-runtime.runtime-BRJDRgFx.js
```

The missing files appeared on disk after startup settled, but subsequent agent
dispatch still failed through the gateway path and fell back to embedded mode.

## Fallback Smoke Result

The embedded fallback runner successfully materialized and used the `imcli`
tool:

```text
IMCLI_MCP_OK google-messages-main, sms-primary, whatsapp-on-demand-test, whatsapp-primary
```

The fallback run's tool summary reported:

```text
tools: imcli__list_accounts
failures: 0
```

This proves the `imcli` MCP server, OpenClaw MCP materialization logic, and
agent-facing tool call are working outside the live gateway agent dispatch
path.

## OpenClaw Review Update - 2026-05-02

After live patching OpenClaw to `2026.4.30 (5d35b0c)`, the original global
package lazy-import blocker was not reproduced:

- `openclaw gateway status --deep --require-rpc` passed.
- The previously missing installed files existed under the global package:
  `dist/transcript-resolve.runtime-Djgr04ZR.js` and
  `dist/provider-runtime-B3qmO6yf.js`.
- Recent gateway logs did not show fresh `ERR_MODULE_NOT_FOUND` entries for
  those chunks.

The current blocker is now tool exposure, not `imcli` service readiness or the
original missing-chunk import failure.

`imcli` direct readiness is healthy on the current install:

```text
imcli --version
0.1.25
```

```text
imcli service status --json
success=true, data.ok=true
```

```text
imcli doctor --tenant default --json
success=true, data.ok=true
```

A direct MCP stdio probe using the configured command and cwd succeeded after
the normal MCP handshake (`initialize`, `notifications/initialized`,
`tools/list`). The tool list includes `list_accounts`.

A live `odollo-soylei` agent smoke completed without the old missing-module
fallback error, but the agent did not receive the `imcli` tool:

```text
IMCLI_MCP_UNAVAILABLE, imcli__list_accounts tool is not available in this session
```

The run's reported callable tools included core tools and Graphiti tools, but
not `imcli__list_accounts`. The agent tool policy allows `imcli__*`, and
`mcp.servers.imcli` is configured, so the remaining OpenClaw-side question is
why configured MCP tools are not being materialized into this agent session.

Config observations from the same review:

- `agents.list[].id=odollo-soylei` has `tools.profile: coding` and
  `tools.alsoAllow` includes `imcli__*`.
- `mcp.servers.imcli` points at `/home/ecochran76/.local/share/pnpm/imcli
--tenant default mcp` with cwd `/home/ecochran76/workspace.local/imcli`.
- `plugins.allow` is restrictive and currently includes `slack`, `openai`,
  `tokenjuice`, and `memory-core`; it does not include a visible MCP/bundle MCP
  plugin id.
- Gateway logs still show intermittent `bundle-mcp` startup failures for
  `imcli` with `McpError: MCP error -32000: Connection closed`, even though the
  direct MCP protocol probe succeeds.

## Assessment

- Treat `imcli` MCP as fixed.
- Treat the original live OpenClaw global-package import/runtime readiness
  blocker as stale unless it reappears in a fresh smoke.
- Treat live OpenClaw MCP tool exposure for `odollo-soylei` as fixed by local
  runtime config as of the 2026-05-02 follow-up below.
- The remaining failure looks like bundle MCP activation/materialization or MCP
  handshake timing in OpenClaw, not an Odollo workflow issue and not an `imcli`
  service/protocol issue.
- The gateway can become healthy enough for `openclaw health` and Slack startup
  while still failing to expose a configured MCP server's tools to a target
  agent.

## Resolution Update - 2026-05-02

Root cause was service-environment Node skew, not `imcli` protocol handling or
OpenClaw bundle MCP policy.

The user systemd gateway service starts OpenClaw with `/usr/bin/node`, but the
gateway service `PATH` also caused the `/home/ecochran76/.local/share/pnpm/imcli`
shim to resolve `node` as `/usr/bin/node` v25.8.0. `imcli`'s local
`better-sqlite3` native module was built for Node ABI 137, while Node v25.8.0
requires ABI 141, so the MCP child exited immediately. OpenClaw surfaced that as:

```text
bundle-mcp: failed to start server "imcli" ... McpError: MCP error -32000: Connection closed
```

Reproducing the configured launch with the gateway service `PATH` produced:

```text
better_sqlite3.node was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 141.
```

The local runtime fix was to pin `mcp.servers.imcli.env.PATH` in
`~/.openclaw/openclaw.json` so the `imcli` shim resolves Node from
`/home/ecochran76/.nvm/versions/node/v24.13.0/bin` before `/usr/bin`.

Validation after restart:

```text
openclaw config validate
openclaw gateway restart
openclaw gateway status --deep --require-rpc
openclaw agent --agent odollo-soylei --session-key agent:odollo-soylei:imcli-smoke-fixed ...
```

The live agent smoke completed without fallback and reported:

```text
IMCLI_MCP_OK account keys: google-messages-main, sms-primary, whatsapp-on-demand-test, whatsapp-primary
toolSummary: imcli__list_accounts, failures: 0
```

Residual product hardening opportunity: OpenClaw should expose child stderr for
stdio MCP startup failures in operator diagnostics. The runtime behavior was
correct to drop the failing MCP server, but `Connection closed` hid the native
module ABI mismatch until the configured child launch was reproduced manually.

## Recommended Fix Direction

- Add a deterministic OpenClaw-side smoke that proves a configured stdio MCP
  server is exposed as prefixed agent tools for a specific agent allowlist.
- Audit bundle MCP activation when `plugins.allow` is restrictive and
  `mcp.servers.*` is configured.
- Audit bundle MCP stdio handshake timing; the direct probe succeeds, but
  gateway logs still report connection-closed startup failures.
- Keep or add a package acceptance/gateway startup smoke that proves
  agent-dispatch lazy imports are available before reporting the gateway as
  agent-ready, because that was the original failure mode.
- Prefer a live gateway smoke that runs `odollo-soylei` with `imcli__list_accounts`
  and completes without `fallbackFrom: "gateway"`.
- Require the same smoke to verify `imcli__list_accounts` appears in the
  callable tool list and is callable from the agent.
- If runtime dependency staging can mutate package files after service start,
  make startup wait for that staging or move it before the gateway can accept
  agent RPC.

## Validation From Odollo Side

Odollo recorded the paired note at:

```text
/home/ecochran76/workspace.local/odollo/doc/dev/notes/openclaw-latency-testing-handoff-2026-05-02.md
```

Validation completed in the Odollo worktree:

```text
git diff --check
openclaw config validate
```

Both passed.
