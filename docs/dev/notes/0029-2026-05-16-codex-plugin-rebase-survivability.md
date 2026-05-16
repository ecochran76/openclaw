# Codex Plugin Rebase Survivability

Date: 2026-05-16

## Context

The rebase that moved from the Pi-era Codex integration to the newer Codex plugin architecture was unusually disruptive. The live system recovered after two separate repairs:

- Codex auth refresh had to unwrap JSON token wrapper objects before using refresh/access token strings.
- Slack progress indicators had to be repaired in the installed Slack plugin, not only in the core OpenClaw package.

The source tree looked mostly coherent before the live system was fully healthy. The missing piece was installed-runtime convergence.

## What Worked

- The local feature index and `scripts/ec-main-rebase-gate.sh` gave a useful preservation map after the rebase.
- Codex-specific auth repair landed in provider/plugin-owned surfaces instead of broadening generic auth orchestration.
- Slack progress behavior remained channel/plugin-owned after Slack was externalized.
- The live runtime became healthy only after installing a locally built `extensions/slack` tarball that matched the same `ec-main` checkout as the core live patch.

## Rebase-Survivability Review

Current custom modifications are generally in the right ownership layers:

- profiles/auth: core auth-profile selection plus provider-owned Codex/OpenAI adapters
- Slack/A2A: core session-routing invariants plus Slack-owned presentation and interaction handling
- Slack responsiveness: generic turn tracking in core, Slack-specific progress/draft behavior in the Slack plugin
- automation: feature-owned helpers under `src/automation/` with core session lifecycle left as a core invariant
- voice/telephony: mostly plugin-owned under `extensions/voice-call/`
- upgrade/live patch: operator-owned scripts, not plugin behavior

The remaining rebase-risk hotspots are:

- `src/auto-reply/reply/commands-reauth.ts`: large command surface; should continue splitting into provider-neutral orchestration and provider capability adapters.
- `extensions/slack/src/monitor/message-handler/dispatch.ts`: still upstream-hot; keep moving progress/startup trace shaping into Slack-owned helper modules when conflicts repeat.
- `src/agents/openclaw-tools.sessions.test.ts`: very large local A2A/session test file; split by behavior family when practical to make conflict review easier.
- `src/agents/pi-embedded-runner/run/attempt.ts`: large churn area; preserve runner compatibility helpers instead of reintroducing inline compatibility code.
- `scripts/patch-live-openclaw.sh`: now needs external-plugin awareness because core-only live patching can leave stale installed plugins behind.
- generated config baselines: keep regeneration commands explicit; do not hand-edit noisy generated drift during conflict repair.

## Durable Lesson

After upstream externalizes a runtime into a plugin, `ec-main` live patch success requires matching all active installed plugin runtimes to the same source generation as the core package. A healthy `openclaw --version` is not sufficient proof.

Minimum post-patch checks:

```bash
openclaw gateway status --deep --require-rpc
openclaw plugins inspect slack --runtime --json
rg -n "slack turn live trace|starting agent turn|agent turn completed" ~/.openclaw/extensions/slack -g '*.js'
```

## Recommended Follow-Up

Add plugin-aware handling to the live patch flow:

- detect enabled external plugins that are sourced from this checkout or shadow bundled plugin ids
- compare installed plugin version/source against the current checkout
- rebuild and install affected plugin tarballs during live patch when requested
- refresh the plugin registry after plugin installation
- report active-task drain behavior before gateway restart so systemd stop timeouts do not look like mysterious gateway failures
