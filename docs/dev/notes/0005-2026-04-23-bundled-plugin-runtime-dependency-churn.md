# Bundled Plugin Runtime Dependency Churn

State: OPEN
Created: 2026-04-23

## 2026-05-01 Review

This note remains useful as an open field record, but parts have been acted on
locally:

- `fix(gateway): lighten liveness probes` changed deep gateway probes to use a
  cheap read RPC (`system-presence`) instead of the heavier status/config
  bundle, reducing the chance that liveness checks materialize expensive status
  surfaces during startup.
- Gateway-bindable plugin registry reuse now avoids repeated plugin/tool
  materialization on hot paths when a gateway-startup registry is already
  active.
- The remaining product issue is broader than those mitigations: bundled
  runtime dependency staging still needs a stronger packaging/startup contract
  so provider/plugin dependency installation cannot wedge Slack Socket Mode or
  lose inbound events.

## Summary

OpenClaw 2026.4.23 gateway and Slack channel startup cycled repeatedly while bundled plugin runtime dependencies were missing or being installed into the global package tree at runtime.

## Bug Report Draft

Bug type: Packaging / runtime dependency bootstrap failure

Beta release blocker: No

Summary: The gateway stayed under systemd supervision, but Slack channel startup repeatedly failed because bundled extension imports resolved to missing runtime files. Later gateway restarts showed transient plugin registration failures for Slack and other bundled plugins while runtime dependency installation was in progress.

Steps to reproduce:

1. Run OpenClaw 2026.4.23 from the global npm install under Node 24.13.0.
2. Start `openclaw-gateway.service`.
3. Enable Slack and bundled plugin loading.
4. Observe channel and gateway logs during startup and runtime dependency installation.

Expected behavior:

- A globally installed OpenClaw package should contain or reliably resolve bundled plugin runtime dependencies before channel startup.
- Slack should not repeatedly exit because the bundled plugin-sdk shim is missing.
- Runtime dependency installation should be atomic or isolated so concurrent plugin startup cannot see partial dependency trees.
- Gateway restarts should not be required to converge from missing bundled dependency files to a healthy Slack channel.

Actual behavior observed:

Slack channel restarted repeatedly for more than an hour:

```text
[slack] [default] channel exited: Cannot find module '/home/ecochran76/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/dist/extensions/node_modules/openclaw/plugin-sdk/text-runtime.js' imported from /home/ecochran76/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/dist/extensions/slack/send-BjtzUy1x.js
[slack] [default] auto-restart attempt 1/10 in 5s
```

After a gateway restart, bundled dependency installation partly converged but Slack/plugin registration still hit missing modules and non-atomic install state:

```text
[plugins] slack installed bundled runtime deps: @slack/bolt@^4.7.0, @slack/web-api@^7.15.1, https-proxy-agent@^9.0.0, typebox@1.1.28
[plugins] slack failed during register from .../dist/extensions/slack/index.js: Error: Cannot find module '/home/ecochran76/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/node_modules/typebox/build/index.mjs'
[channels] failed to load bundled channel slack: Cannot find module '/home/ecochran76/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/node_modules/typebox/build/index.mjs'
[gateway] [plugins] failed to install bundled runtime deps: Error: ENOTEMPTY, Directory not empty: .../dist/extensions/node_modules/openclaw/plugin-sdk
```

Current convergence after restart:

```text
2026-04-23T22:21:17.901-05:00 [gateway] ready (3 plugins: browser, sherpa-local-tts, slack; 4.0s)
2026-04-23T22:21:33.400-05:00 [slack] socket mode connected
```

OpenClaw version: 2026.4.23 (`98a27c3`)

Operating system: Linux WSL2, Node 24.13.0

Install method: npm global install

Impact and severity:

- Affected: gateway startup, Slack delivery, and channel stability.
- Severity: High for Slack-operated deployments because the channel can be unavailable while the gateway appears partially running.
- Frequency: Repeated Slack channel exits were observed between roughly 19:51 and 21:49 CDT on April 23, 2026; full gateway restarts followed while dependency/bootstrap state converged.
- Consequence: Agent routing, A2A relay visibility, and Slack command delivery can appear intermittently broken even when `openclaw.json` is valid.

## Source Areas To Inspect

- Bundled extension dependency installer.
- Plugin SDK shim/package generation under `dist/extensions/node_modules/openclaw/plugin-sdk`.
- Slack extension imports that resolve through the extension-local `openclaw/plugin-sdk/*` path.
- Race handling around concurrent plugin dependency installs and gateway/channel startup.
- Global npm install layout assumptions for `typebox` and other bundled extension dependencies.

## Acceptance Criteria

- Fresh global install of OpenClaw 2026.4.x starts Slack without missing `openclaw/plugin-sdk/text-runtime.js`.
- Runtime dependency installation is idempotent and atomic; no `ENOTEMPTY` failures from concurrent installs.
- Plugin registration waits for required bundled dependency installation before import/register.
- Missing bundled dependencies produce one actionable startup diagnostic, not repeated channel auto-restart loops.
- A regression smoke test covers Slack bundled plugin startup from a clean global install directory.

## 2026-04-28 Field Update: Runtime Staging Wedges Slack Event Loop

OpenClaw 2026.4.27 on the same WSL2/global npm deployment reproduced the broader runtime dependency churn as a live Slack outage.

Observed sequence:

1. User messages in `#oc-main-agent` reached Slack history, including `/status` at `2026-04-29T03:49:47Z` and `2026-04-29T03:56:00Z`.
2. Gateway health initially reported Slack configured/connected, but Slack did not produce agent replies.
3. Gateway logs showed provider plugin dependency staging inside the live gateway process, followed by event-loop stalls and Slack socket timeouts.
4. Disabling `anthropic` moved the failure to `google`; disabling nonessential provider plugins moved it to `openai`.
5. Restarting after dependency staging sometimes restored Slack socket mode, but the next provider runtime staging step could wedge the gateway again.

Representative logs:

```text
2026-04-28T22:56:01.645-05:00 [plugins] anthropic staging bundled runtime deps (1 missing, 13 install specs): @mariozechner/pi-ai@0.70.5
2026-04-28T22:56:21.512-05:00 [diagnostic] liveness warning: reasons=event_loop_delay interval=32s eventLoopDelayMaxMs=20266.9 eventLoopUtilization=0.634 active=1 queued=1
2026-04-28T22:56:21.623-05:00 [slack] socket disconnected (disconnect). retry 1/12 in 2s
```

```text
2026-04-28T22:59:00.437-05:00 [plugins] google staging bundled runtime deps (2 missing, 14 install specs): @google/genai@^1.50.1, @mariozechner/pi-ai@0.70.5
2026-04-28T22:59:16.425-05:00 [slack] socket disconnected (disconnect). retry 1/12 in 2s
```

```text
2026-04-28T23:02:13.688-05:00 [plugins] openai staging bundled runtime deps (1 missing, 13 install specs): @mariozechner/pi-ai@0.70.5
2026-04-28T23:02:26.270-05:00 [diagnostic] liveness warning: reasons=event_loop_delay interval=31s eventLoopDelayMaxMs=14143.2 eventLoopUtilization=0.799 active=1 queued=1
```

Additional impact:

- `openclaw channels status --deep` can report Slack connected shortly before the event loop wedges; this is not sufficient evidence of channel responsiveness.
- The gateway HTTP health endpoint can time out after staging completes, leaving the systemd service `active` but operationally non-responsive.
- A live Slack operator sees silent failure: inbound Slack messages are visible via `openclaw message read`, but no agent reply is delivered.

Field mitigation used in the user config:

- Disable nonessential provider plugins in `plugins.allow` and `plugins.entries.*.enabled`.
- Restart `openclaw-gateway.service` after dependency staging has completed.
- Avoid live agent probes that trigger additional provider-plugin staging until the installer is fixed.

Updated acceptance criteria:

- Runtime dependency staging must never block the gateway event loop long enough to miss Slack pings/pongs.
- Provider runtime dependency staging must be preflighted before Slack socket startup, isolated in a worker/child process, or made non-blocking from the gateway event loop.
- `openclaw status --deep` or channel health should detect a wedged event loop / stale Slack socket state instead of reporting Slack as OK based on stale connection state.
- A regression test should simulate delayed provider dependency installation while Slack socket mode is connected and assert that pings/pongs and inbound dispatch remain responsive.

## 2026-04-29 Field Update: Multi-Tenant Slack Event Miss During Agent Tool Startup

OpenClaw 2026.4.27 reproduced the same event-loop/socket failure mode in a two-Slack-tenant setup. The SoyLei `#website` channel was correctly configured for the `soylei-website` agent and the user message was visible in Slack history, but the inbound event never entered the agent session while the gateway was cycling Slack socket startup.

Observed sequence:

1. SoyLei `#website` message at `2026-04-29T22:28:29.234Z`: `<@U0B0BS18D70> tell us about what you can do with Canva`.
2. The message came from an allowlisted user, directly mentioned the SoyLei bot, and matched the configured `soylei-website` binding.
3. The prior `soylei-website` session only contained the earlier `17:25` CDT abilities prompt; the Canva prompt was absent from the session JSONL.
4. Gateway logs during the missed message window showed Slack socket disconnect/retry churn and startup steps taking about 10-11 seconds.
5. After restarting the gateway, both Slack tenants reconnected, but the replayed agent turn triggered a large event-loop delay and Slack ping/pong warnings before reconnecting.
6. The replayed turn eventually completed and delivered to SoyLei `#website`, proving the binding and policy were valid.

Representative logs:

```text
2026-04-29T17:28:15.751-05:00 [slack] socket mode failed to start. retry 5/12 in 25s (undefined)
2026-04-29T17:28:47.060-05:00 [slack] socket disconnected (disconnect). retry 1/12 in 2s
2026-04-29T17:28:51.239-05:00 [slack] socket mode failed to start. retry 6/12 in 30s (undefined)
```

```text
2026-04-29T17:35:41.197-05:00 [diagnostic] liveness warning: reasons=event_loop_delay interval=116s eventLoopDelayP99Ms=44.8 eventLoopDelayMaxMs=98717.1 eventLoopUtilization=0.925 active=0 waiting=0 queued=0
[WARN] socket-mode:SlackWebSocket:6 A ping wasn't received from the server before the timeout of 30000ms!
[WARN] socket-mode:SlackWebSocket:6 A pong wasn't received from the server before the timeout of 15000ms!
```

Additional impact:

- A valid mentioned Slack message can be silently dropped at the OpenClaw ingress/session layer during socket reconnect churn; reading Slack history later shows the message, but no task or session event exists.
- Multi-tenant Slack makes the health state easy to misread because one account may report connected while the other is still retrying or recovering.
- Agent turns that materialize a large bundled tool surface, including Canva and Slack Mirror MCP tools, can still stall the gateway enough to lose Slack pings even after the earlier provider allowlist mitigation.

Updated acceptance criteria:

- Inbound Slack events should be acknowledged, persisted, or recoverably replayed before long-running agent/tool startup can block dispatch.
- Multi-tenant Slack health should report each account's socket state, recent reconnects, and last inbound event age rather than only a rollup.
- `openclaw status --deep` should surface recent event-loop delay and ping/pong timeout warnings as degraded channel health.
- Agent tool materialization should not run on the same event-loop path that must keep Slack Socket Mode alive.
