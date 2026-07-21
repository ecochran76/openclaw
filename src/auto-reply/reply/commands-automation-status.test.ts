import { afterEach, describe, expect, it } from "vitest";
import {
  createAutomationRunRecord,
  resetAutomationRegistryForTests,
} from "../../automation/registry.js";
import type { OpenClawConfig } from "../../config/config.js";

const { handleCommands } = await import("./commands.js");
const { buildCommandTestParams } = await import("./commands.test-harness.js");

afterEach(() => {
  resetAutomationRegistryForTests();
});

describe("/status automation summary", () => {
  it("shows the active automation run for the current session", async () => {
    createAutomationRunRecord({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:auto-1",
      spec: {
        goal: "Finish the agreed landing page polish plan.",
        label: "landing-page-polish",
        stop: { maxTurns: 6, maxTokens: 80_000, maxDurationSeconds: 1800 },
      },
      now: Date.now() - 20_000,
      runId: "auto_000001",
    });

    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/status", cfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("🤖 Automation: landing-page-polish · queued · 0/6 turns");
  });
});
