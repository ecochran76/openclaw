# Embedded Custom Tools Empty Allowlist Regression

State: CLOSED
Created: 2026-04-23
Closed: 2026-04-23

## Summary

OpenClaw 2026.4.22 can inject OpenClaw/Pi custom tool schemas into the embedded agent prompt while passing an empty Pi SDK `tools` allowlist, so the model sees tools such as `exec` in the prompt but the callable tool registry is empty.

## Bug Report Draft

Bug type: Regression (worked before, now fails)

Beta release blocker: No

Summary: On OpenClaw 2026.4.22, an embedded `openai-codex/gpt-5.4` agent with `exec` enabled refused or failed to call `exec` because OpenClaw passed `tools: []` into `createAgentSession` while passing OpenClaw host tools as `customTools`.

Steps to reproduce:

1. Configure an agent with an OpenClaw host tool such as `exec`.
2. Run the agent through the embedded runner using `openai-codex/gpt-5.4`.
3. Ask the agent to call `exec` with a harmless command such as `pwd`.
4. Observe that the prompt report lists `exec`, but the agent says the tool is unavailable and no `toolCall` is emitted.

Expected behavior: If the prompt report lists `exec` and the agent policy enables it, the embedded agent session should register `exec` as a callable tool and emit a real `toolCall`.

Actual behavior: The model received prompt text describing `exec`, but the Pi SDK session was constructed with an empty `tools` allowlist, which filtered custom tools out of the callable registry. The agent replied with tool-unavailable text rather than emitting a tool call.

OpenClaw version: 2026.4.22 (`cb0532a`)

Operating system: Linux WSL2, kernel `6.6.87.2-microsoft-standard-WSL2`, Node `24.13.0`

Install method: npm global install

Model: `openai-codex/gpt-5.4`

Provider / routing chain: OpenClaw embedded runner -> `openai-codex` OAuth -> OpenAI Codex Responses API

Additional provider/model setup details: The affected agent had `tools.exec.security="full"` and `tools.exec.ask="off"`. The prompt report included `exec` under tools, but no real tool call was emitted before the live patch.

Logs, screenshots, and evidence:

```text
Pre-patch observed agent reply:
EXEC_PROBE_FAILED
Tool error: exec tool is not available in this session.

Root cause found in installed dist:
splitSdkTools(...) returned:
  builtInTools: []
  customTools: toToolDefinitions(tools)

Then the embedded runner called createAgentSession with:
  tools: builtInTools
  customTools: allCustomTools

In @mariozechner/pi-coding-agent, a provided tools array is an allowlist. Passing [] creates an empty allowlist and filters out custom tools.
```

Post-hotfix validation:

```text
Fresh probe result:
EXEC_PROBE_OK
/home/ecochran76/.openclaw/workspace-gpod

Original Slack-thread session result:
EXEC_PROBE_OK
/home/ecochran76/.openclaw/workspace-gpod

Both probes reported:
toolSummary.calls = 1
toolSummary.tools = ["exec"]
toolSummary.failures = 0
```

Impact and severity:

- Affected: embedded runner agents using OpenClaw host/custom tools.
- Severity: High for delegated operational agents because it blocks the agent from doing its own host-backed work.
- Frequency: Reproduced repeatedly before the live patch on the affected agent/session; fixed after the allowlist patch.
- Consequence: Agents ask humans to run commands or incorrectly report that tools are unavailable even when config and prompt reports show the tool.

Additional information:

- Historical local sessions from February/March 2026 showed the same agent emitting real `exec` tool calls, so this appears to be a regression from previously working behavior.
- A live-package hotfix was applied outside this repository to validate the fix. It changed the embedded runner to pass the OpenClaw custom tool names into the Pi SDK allowlist:

```ts
const sdkToolAllowlist = [...builtInTools, ...allCustomTools.map((tool) => tool.name)];
// ...
tools: sdkToolAllowlist,
customTools: allCustomTools,
```

- The same pattern was patched in the compaction runner with `customTools.map((tool) => tool.name)`.
- Installed dist files hotfixed locally:
  - `/home/ecochran76/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/dist/selection-KLjvl75I.js`
  - `/home/ecochran76/.nvm/versions/node/v24.13.0/lib/node_modules/openclaw/dist/compact-B2DKiN2q.js`
- Backups were left beside the installed files with suffix `.bak-20260423-gpod-tools`.

## Source Areas To Inspect

- Embedded runner source for `splitSdkTools` and `createAgentSession` option construction.
- Compaction runner source using the same `splitSdkTools` output.
- Tests around `customTools` plus non-omitted `tools` allowlist behavior.

## Acceptance Criteria

- Source fix lands in OpenClaw repo, not only installed dist. Done in `src/agents/pi-embedded-runner/tool-split.ts` and `src/agents/pi-embedded-runner/run/attempt.ts`.
- Regression test proves custom OpenClaw tools remain callable when `splitSdkTools` returns no built-in Pi tools. Done in `src/agents/pi-embedded-runner/tool-split.test.ts`.
- Embedded runner and compaction runner use equivalent allowlist behavior. Done by making `splitSdkTools` return the custom tool names as the Pi SDK allowlist; normal runs append hosted client tool names before session creation.
- Live patch can be retired after installing a built OpenClaw package containing the source fix. Pending live patch after validation.

## Resolution

The source fix updates `splitSdkTools` so OpenClaw custom tools are registered through `customTools` and included in Pi's explicit `tools` allowlist. Normal embedded turns also append OpenResponses hosted client tool names to the allowlist when those tools are present.

Validation:

```text
pnpm test src/agents/pi-embedded-runner/tool-split.test.ts extensions/slack/src/monitor/message-handler/dispatch.streaming.test.ts src/auto-reply/reply/delivery-observer.test.ts src/auto-reply/reply/dispatch-from-config.test.ts
```

Result: passed.
