import { describe, expect, it } from "vitest";
import {
  resolveAutomationConfig,
  resolveAutomationRunSpec,
  resolveAutomationStopSpec,
} from "./config.js";

describe("automation config resolver", () => {
  it("returns built-in defaults when config is absent", () => {
    expect(resolveAutomationConfig()).toEqual({
      maxConcurrent: 1,
      defaultMaxTurns: 6,
      defaultMaxTokens: 80_000,
      defaultMaxDurationSeconds: 1_800,
      model: undefined,
      thinking: undefined,
      announceTimeoutMs: 90_000,
    });
  });

  it("applies configured defaults and trims model and thinking", () => {
    const config = {
      agents: {
        defaults: {
          automation: {
            maxConcurrent: 2,
            defaultMaxTurns: 8,
            defaultMaxTokens: 120_000,
            defaultMaxDurationSeconds: 900,
            model: { primary: " openai/gpt-5 " },
            thinking: " medium ",
            announceTimeoutMs: 45_000,
          },
        },
      },
    };
    expect(resolveAutomationConfig(config)).toEqual({
      maxConcurrent: 2,
      defaultMaxTurns: 8,
      defaultMaxTokens: 120_000,
      defaultMaxDurationSeconds: 900,
      model: "openai/gpt-5",
      thinking: "medium",
      announceTimeoutMs: 45_000,
    });
  });

  it("resolves stop caps and run spec defaults without reading raw config downstream", () => {
    const config = {
      agents: {
        defaults: {
          automation: {
            defaultMaxTurns: 9,
            defaultMaxTokens: 50_000,
            defaultMaxDurationSeconds: 600,
            model: { primary: "openai/gpt-5" },
            thinking: "low",
          },
        },
      },
    };

    expect(resolveAutomationStopSpec(undefined, config)).toEqual({
      maxTurns: 9,
      maxTokens: 50_000,
      maxDurationSeconds: 600,
    });
    expect(
      resolveAutomationRunSpec({
        config,
        spec: { label: "  docs-audit  ", goal: "Audit docs.", stop: { maxTokens: 75_000 } },
      }),
    ).toEqual({
      label: "docs-audit",
      goal: "Audit docs.",
      model: "openai/gpt-5",
      thinking: "low",
      stop: {
        maxTurns: 9,
        maxTokens: 75_000,
        maxDurationSeconds: 600,
      },
      delivery: { mode: "announce" },
    });
  });
});
