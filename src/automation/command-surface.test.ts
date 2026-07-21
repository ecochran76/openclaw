import { describe, expect, it } from "vitest";
import {
  buildAcceptedAutomationRunReply,
  buildAutomationCommandSuggestionReply,
  buildAutomationUsageText,
  buildSuggestedAutomationCommand,
  extractAutomationToolText,
  parseAutomationRunArgs,
  sliceAutomationCommandTail,
} from "./command-surface.js";

describe("automation command surface", () => {
  it.each([
    ["--turns", "2oops"],
    ["--tokens", "80_000"],
    ["--tokens", "1.5"],
  ])("rejects malformed %s bounds", (flag, value) => {
    expect(parseAutomationRunArgs(["run", "cleanup", flag, value])).toEqual({
      ok: false,
      errorText: "🤖 Automation\nBounds must be positive integers.",
    });
  });

  it("returns usage when a bound flag has no value", () => {
    expect(parseAutomationRunArgs(["run", "cleanup", "--turns"])).toEqual({
      ok: false,
      errorText: buildAutomationUsageText(),
    });
  });

  it.each(["--label", "--model", "--thinking"])(
    "returns usage when %s has no non-flag value",
    (flag) => {
      expect(parseAutomationRunArgs(["run", "cleanup", flag])).toEqual({
        ok: false,
        errorText: buildAutomationUsageText(),
      });
      expect(parseAutomationRunArgs(["run", "cleanup", flag, "--turns", "2"])).toEqual({
        ok: false,
        errorText: buildAutomationUsageText(),
      });
    },
  );
  it("formats usage for the chat command", () => {
    const usage = buildAutomationUsageText();

    expect(usage).toContain("/automation run <goal>");
    expect(usage).toContain("/automation status [id|#]");
    expect(usage).toContain("/automation steer <id|#> <message>");
  });

  it("suggests a concrete run command from natural-language setup requests", () => {
    const command = buildSuggestedAutomationCommand(
      "Please set up an /automation run that will take you through the end of the plan, max 5 turns, max 12000 tokens, for 20m",
    );

    expect(command).toBe(
      "/automation run take you through the end of the plan --turns 5 --tokens 12000 --duration 20m",
    );
    expect(buildAutomationCommandSuggestionReply(command ?? "")).toContain("Suggested command:");
  });

  it("does not suggest commands for plain discussion", () => {
    expect(buildSuggestedAutomationCommand("The /automation docs are dense.")).toBeNull();
    expect(buildSuggestedAutomationCommand("/automation run something")).toBeNull();
  });

  it("slices automation command tails", () => {
    expect(sliceAutomationCommandTail("/automation")).toBe("");
    expect(sliceAutomationCommandTail("/automation: status")).toBe("status");
    expect(sliceAutomationCommandTail("/automation run finish")).toBe("run finish");
    expect(sliceAutomationCommandTail("/status")).toBeNull();
  });

  it("parses run flags and durations", () => {
    expect(
      parseAutomationRunArgs([
        "run",
        "finish",
        "polish",
        "--label",
        "landing-page",
        "--model",
        "codex-default",
        "--thinking",
        "high",
        "--turns",
        "4",
        "--tokens",
        "9000",
        "--duration",
        "15m",
      ]),
    ).toEqual({
      ok: true,
      goal: "finish polish",
      label: "landing-page",
      model: "codex-default",
      thinking: "high",
      maxTurns: 4,
      maxTokens: 9000,
      maxDurationSeconds: 900,
    });
  });

  it("rejects missing goals, invalid bounds, and invalid durations", () => {
    expect(parseAutomationRunArgs(["run"])).toMatchObject({ ok: false });
    expect(parseAutomationRunArgs(["run", "finish", "--turns", "0"])).toEqual({
      ok: false,
      errorText: "🤖 Automation\nBounds must be positive integers.",
    });
    expect(parseAutomationRunArgs(["run", "finish", "--duration", "nope"])).toEqual({
      ok: false,
      errorText: "🤖 Automation\nInvalid duration: nope",
    });
  });

  it("formats accepted run acknowledgements", () => {
    expect(
      buildAcceptedAutomationRunReply({
        runId: "auto_000001",
        goal: "finish polish",
        label: "landing-page",
        maxTurns: 4,
        maxTokens: 9000,
        maxDurationSeconds: 900,
      }),
    ).toContain("Bounds: turns 4 · tokens 9k · duration 15m 0s");
  });

  it("extracts text from tool result details and content blocks", () => {
    expect(extractAutomationToolText({ details: { text: " detail text " } })).toBe("detail text");
    expect(
      extractAutomationToolText({ details: { status: "error", error: " bad selector " } }),
    ).toBe("bad selector");
    expect(extractAutomationToolText({ content: [{ type: "text", text: "block text" }] })).toBe(
      "block text",
    );
    expect(extractAutomationToolText(null)).toBe("✅ Done.");
  });
});
