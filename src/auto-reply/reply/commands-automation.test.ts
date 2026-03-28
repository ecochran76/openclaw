import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";

const hoisted = vi.hoisted(() => ({
  createAutomationToolMock: vi.fn(),
  executeMock: vi.fn(),
}));

vi.mock("../../agents/tools/automation-tool.js", () => ({
  createAutomationTool: (...args: unknown[]) => hoisted.createAutomationToolMock(...args),
}));

const { handleCommands } = await import("./commands.js");
const { buildCommandTestParams } = await import("./commands.test-harness.js");

const baseCfg = {
  commands: { text: true },
  channels: { whatsapp: { allowFrom: ["*"] } },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;

describe("/automation command", () => {
  beforeEach(() => {
    hoisted.createAutomationToolMock.mockReset();
    hoisted.executeMock.mockReset();
    hoisted.createAutomationToolMock.mockReturnValue({
      execute: hoisted.executeMock,
    });
  });

  it("shows usage when run goal is missing", async () => {
    const params = buildCommandTestParams("/automation run", baseCfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/automation run <goal>");
    expect(hoisted.executeMock).not.toHaveBeenCalled();
  });

  it("suggests a concrete command for natural-language automation setup requests", async () => {
    const params = buildCommandTestParams(
      "Please set up an /automation run that will take you through the end of the plan, max 5 turns",
      baseCfg,
    );
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Suggested command:");
    expect(result.reply?.text).toContain(
      "/automation run take you through the end of the plan --turns 5",
    );
    expect(hoisted.executeMock).not.toHaveBeenCalled();
  });

  it("does not hijack plain discussion that mentions /automation", async () => {
    const params = buildCommandTestParams("The /automation docs are a bit dense.", baseCfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(true);
    expect(result.reply).toBeUndefined();
    expect(hoisted.executeMock).not.toHaveBeenCalled();
  });

  it("parses run flags and formats a start acknowledgement", async () => {
    hoisted.executeMock.mockResolvedValue({
      details: {
        status: "accepted",
        runId: "auto_000001",
        text: "ignored compact text",
      },
      content: [{ type: "text", text: "ignored compact text" }],
    });

    const params = buildCommandTestParams(
      "/automation run finish landing page polish --label landing-page --model codex-default --thinking high --turns 4 --tokens 9000 --duration 15m",
      baseCfg,
      {
        OriginatingChannel: "slack",
        OriginatingTo: "channel:C123",
        MessageThreadId: "1773798053.276449",
      },
    );
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("🤖 Automation started");
    expect(result.reply?.text).toContain("Run: auto_000001 (landing-page)");
    expect(result.reply?.text).toContain("Goal: finish landing page polish");
    expect(result.reply?.text).toContain("Bounds: turns 4 · tokens 9k · duration 15m 0s");
    expect(hoisted.executeMock).toHaveBeenCalledWith(expect.any(String), {
      action: "run",
      goal: "finish landing page polish",
      label: "landing-page",
      model: "codex-default",
      thinking: "high",
      maxTurns: 4,
      maxTokens: 9000,
      maxDurationSeconds: 900,
    });
  });

  it("passes selector and message through for steer", async () => {
    hoisted.executeMock.mockResolvedValue({
      details: {
        status: "ok",
        text: "🤖 Automation status\nPending steer: focus on tests first",
      },
      content: [
        {
          type: "text",
          text: "🤖 Automation status\nPending steer: focus on tests first",
        },
      ],
    });

    const params = buildCommandTestParams("/automation steer #2 focus on tests first", baseCfg);
    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Pending steer: focus on tests first");
    expect(hoisted.executeMock).toHaveBeenCalledWith(expect.any(String), {
      action: "steer",
      selector: "#2",
      message: "focus on tests first",
    });
  });
});
