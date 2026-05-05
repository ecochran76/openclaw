# 0018 - 2026-05-04 - Lei OpenClaw Memory Write Surface Gap

State: OPEN
Created: 2026-05-04

## Context

The `company-bot` daily provenance drain now sends compact source packets to
Lei (`soylei-primary`) so Lei can classify memories and write source-cited
Graphiti records. The live drain successfully wrote Graphiti episodes in group
`soylei_company`, but Lei did not receive a concrete OpenClaw memory write tool.

## Evidence

- Live `soylei-primary` config included `tools.profile: messaging` with
  `alsoAllow` entries such as `group:memory` and Graphiti tools.
- Gateway/tool-profile logs reported unknown allowlist entries for
  `group:memory` and several Graphiti-style names, even though Graphiti was
  ultimately usable through the active MCP surface.
- `openclaw memory --help` exposed search/index/promote/remove-style commands,
  but no obvious CLI write command suitable for a daily-harvest agent turn.
- Lei truthfully reported OpenClaw memory write as unavailable during the
  provenance drain while Graphiti write jobs completed.

## Impact

Daily company-bot harvests can reliably seed Graphiti, but cannot prove compact
OpenClaw memory writes unless OpenClaw exposes a first-class write-capable memory
tool to the agent runtime. This makes `group:memory` ambiguous and can cause
agents to overstate memory persistence if prompts do not force truthful
availability reporting.

## Suggested Fix

- Define the supported OpenClaw memory write surface for agent turns.
- Make `group:memory` resolve to concrete read/write tool names or reject it
  with a clear validation error before runtime.
- Add a focused test that an agent with the memory group receives the expected
  write-capable memory tool.
- Add status/doctor output that distinguishes Graphiti memory tools from native
  OpenClaw memory tools.

## Current Workaround

`company-bot` and Lei now treat Graphiti group `soylei_company` as the required
daily provenance memory target. Native OpenClaw memory writes are best-effort and
must be reported as unavailable when no concrete write tool is present.
