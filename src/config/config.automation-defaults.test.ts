import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("automation defaults config", () => {
  it("accepts bounded automation defaults", () => {
    const parsed = OpenClawSchema.parse({
      agents: {
        defaults: {
          automation: {
            maxConcurrent: 1,
            defaultMaxTurns: 6,
            defaultMaxTokens: 80_000,
            defaultMaxDurationSeconds: 1_800,
            model: { primary: "openai/gpt-5" },
            thinking: "medium",
            announceTimeoutMs: 90_000,
          },
        },
      },
    });

    expect(parsed.agents?.defaults?.automation?.maxConcurrent).toBe(1);
    expect(parsed.agents?.defaults?.automation?.defaultMaxTurns).toBe(6);
    expect(parsed.agents?.defaults?.automation?.defaultMaxTokens).toBe(80_000);
    expect(parsed.agents?.defaults?.automation?.defaultMaxDurationSeconds).toBe(1_800);
    expect(parsed.agents?.defaults?.automation?.model).toEqual({ primary: "openai/gpt-5" });
    expect(parsed.agents?.defaults?.automation?.thinking).toBe("medium");
    expect(parsed.agents?.defaults?.automation?.announceTimeoutMs).toBe(90_000);
  });

  it("rejects non-positive automation caps", () => {
    const parsed = OpenClawSchema.safeParse({
      agents: {
        defaults: {
          automation: {
            maxConcurrent: 0,
            defaultMaxTurns: 0,
            defaultMaxTokens: -1,
            defaultMaxDurationSeconds: 0,
            announceTimeoutMs: 0,
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});
