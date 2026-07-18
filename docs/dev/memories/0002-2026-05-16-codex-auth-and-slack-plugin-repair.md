# Codex Auth And Slack Plugin Repair

Date: 2026-05-16

Use this memory when `ec-main` appears healthy in source but the live gateway has broken Codex auth, `/reauth`, Slack progress indicators, or Slack response visibility after an upstream rebase.

## Successful Fixes

- Codex OAuth refresh tokens may be wrapped in JSON token objects after the Pi-to-Codex-plugin transition. Preserve the OpenAI Codex auth bridge behavior that unwraps token wrapper objects before using refresh/access token strings.
- Codex auth refresh must fail fast when notification-driven auth refresh stalls or returns terminal auth errors. Do not let Slack turns hang silently behind a blocked Codex app-server auth refresh.
- Slack progress/streaming indicators can fail even when the core package is current if Slack is installed as an external plugin and the installed plugin copy is stale.
- In the 2026-05-16 repair, core was `2026.5.16` but the live Slack plugin was still `@openclaw/slack@2026.5.12`. Building `extensions/slack`, installing the package-local tarball, refreshing the plugin registry, and restarting the gateway restored the progress instrumentation.
- SoyLei account config had explicitly disabled progress output with `streaming.progress.label=false` and `toolProgress=false`. For visible progress, use `streaming.mode=progress`, `nativeTransport=true`, `progress.label=auto`, `progress.toolProgress=true`, and `progress.commandText=status`.

## Verification Pattern

Check all three layers before assuming source is wrong:

```bash
openclaw --version
openclaw gateway status --deep --require-rpc
openclaw plugins inspect slack --runtime --json
```

For Slack progress specifically, verify the installed plugin runtime contains the progress trace strings:

```bash
rg -n "slack turn live trace|starting agent turn|agent turn completed" ~/.openclaw/extensions/slack -g '*.js'
```

Then run focused coverage:

```bash
pnpm test extensions/slack/src/monitor/message-handler/dispatch.preview-fallback.test.ts -- -t 'progress|draft|toolProgress'
```

## Rebase Lesson

After upstream externalizes a formerly bundled runtime into a plugin, live patching the core tarball is not sufficient. Rebuild and install the affected external plugin from the same `ec-main` checkout, or the gateway may run mixed-generation core and plugin code.
