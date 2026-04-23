# Status Deep Node ESM Assertion

State: OPEN
Created: 2026-04-23

## Summary

`openclaw status --deep` can fail before producing status output because the CLI hits a Node.js internal ESM/CJS module assertion during startup.

## Bug Report Draft

Bug type: Runtime crash / operational validation blocker

Beta release blocker: No

Summary: On OpenClaw 2026.4.22, `openclaw config validate` and `openclaw channels list` can succeed while `openclaw status --deep` fails during CLI startup with `ERR_INTERNAL_ASSERTION: Unexpected status of a module that is imported again after being required. Status = 0`.

Steps to reproduce:

1. Use the OpenClaw user config at `/home/ecochran76/.openclaw/openclaw.json`.
2. Run `openclaw status --deep`.
3. Observe that the CLI fails before completing the deep health probe.

Expected behavior: `openclaw status --deep` should complete the health probe or emit a normal actionable OpenClaw diagnostic without crashing the CLI startup path.

Actual behavior:

```text
[openclaw] Failed to start CLI: Error [ERR_INTERNAL_ASSERTION]: Unexpected status of a module that is imported again after being required. Status = 0
This is caused by either a bug in Node.js or incorrect usage of Node.js internals.
Please open an issue with this stack trace at https://github.com/nodejs/node/issues

    at assert.fail (node:internal/assert:17:9)
    at ModuleJobSync.run (node:internal/modules/esm/module_job:494:12)
    at onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:660:42)
    at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
```

OpenClaw version: 2026.4.22

Operating system: Linux WSL2, Node 24.13.0

Install method: npm global install

Additional evidence:

Gateway logs show recurring health refresh failures with the same assertion while the gateway otherwise detects and hot-reloads dynamic config changes:

```text
2026-04-23T17:55:40.265-05:00 [reload] config change detected; evaluating reload (session.agentToAgent.relay.mode)
2026-04-23T17:55:40.335-05:00 [reload] config change applied (dynamic reads: session.agentToAgent.relay.mode)
2026-04-23T17:55:55.743-05:00 [health] refresh failed: Unexpected status of a module that is imported again after being required. Status = 0
```

Impact and severity:

- Affected: runtime validation and health reporting.
- Severity: Medium. Basic config validation can still pass, but the canonical operational smoke test is blocked.
- Frequency: Reproduced on April 23, 2026 while validating A2A relay configuration.
- Consequence: Operators cannot rely on `openclaw status --deep` to distinguish config regressions from unrelated runtime health failures.

## Source Areas To Inspect

- CLI startup path for `status --deep`.
- Health refresh implementation shared by gateway and CLI.
- Any mixed `require()` and dynamic/static `import()` paths around modules loaded during status probing.
- Node 24.13.0 compatibility assumptions in bundled output.

## Acceptance Criteria

- `openclaw status --deep` no longer crashes on startup under Node 24.13.0.
- Health refresh failures are isolated so they do not prevent unrelated status sections from rendering.
- If a Node runtime incompatibility is unavoidable, OpenClaw emits a clear version compatibility diagnostic.
- Add a regression test or smoke fixture covering the mixed module-loading path that currently triggers the assertion.
