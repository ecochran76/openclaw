# Live Patch Doctor Codex Route Rewrite

Date: 2026-05-09

## Summary

Running the live patch helper after the Slack visible-reply fix successfully
built and installed OpenClaw, but its post-install doctor step rewrote
`openai-codex/gpt-5.5` runtime routes to `openai/gpt-5.5`.

This side effect was not part of the requested Slack delivery fix and conflicts
with OAuth-backed Codex routing used by local Odollo/OpenClaw agents.

## Evidence

The live patch command was:

```bash
scripts/patch-live-openclaw.sh --expect-branch ec-main --require-expected-branch
```

During the helper's doctor phase, output included route repairs such as:

```text
agents.list.odollo-soylei.model.primary: openai-codex/gpt-5.5 -> openai/gpt-5.5
agents.list.odollo-saber.model.primary: openai-codex/gpt-5.5 -> openai/gpt-5.5
```

It also reported:

```text
Repaired Codex session routes: moved 177 sessions across 13 stores to openai/* with agentRuntime "pi".
```

## Immediate Recovery

Runtime config was restored from:

```text
~/.openclaw/openclaw.json.bak
```

Session stores were backed up and entries matching the unintended
`modelProvider: "openai"`, `model: "gpt-5.5"`, `agentRuntimeOverride: "pi"`
rewrite were restored to `modelProvider: "openai-codex"`.

The gateway was restarted and `openclaw gateway status --deep --require-rpc`
passed after recovery.

## Follow-Up

- Fix the doctor/repair path so valid `openai-codex/*` OAuth model routes are
  not rewritten to `openai/*`. Implemented: doctor now only repairs retired
  `openai-codex/gpt-5.1*`, `openai-codex/gpt-5.2*`, and
  `openai-codex/gpt-5.3*` refs.
- Ensure `scripts/patch-live-openclaw.sh` does not run a destructive or broad
  config/session rewrite as part of routine live patching. Implemented through
  the narrowed doctor repair predicate; the patch helper can still run doctor,
  but current `openai-codex/gpt-5.4*` and `openai-codex/gpt-5.5*` PI OAuth
  routes are no longer classified as stale.
- Add a regression test around valid `openai-codex/gpt-5.5` config and session
  entries surviving doctor/patch flows. Implemented in
  `codex-route-warnings.test.ts`.
