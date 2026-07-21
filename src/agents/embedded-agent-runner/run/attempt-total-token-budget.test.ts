import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  AgentTotalTokenBudgetExceededError,
  applyAgentTotalTokenBudget,
  wrapStreamFnWithTotalTokenBudget,
} from "./attempt-total-token-budget.js";

describe("applyAgentTotalTokenBudget", () => {
  it("reserves system, history, prompt, and tool-definition input before output", () => {
    const result = applyAgentTotalTokenBudget({
      streamParams: { maxTokens: 10_000, maxTotalTokens: 2_000 },
      messages: [{ role: "user", content: "prior context" }],
      systemPrompt: "system policy ".repeat(100),
      prompt: "worker request ".repeat(100),
      tools: [{ name: "exec", description: "Run a command", parameters: { type: "object" } }],
      toolNames: new Set(["exec"]),
    });

    expect(result.maxTotalTokens).toBe(2_000);
    expect(result.maxTokens).toBeGreaterThan(0);
    expect(result.maxTokens).toBeLessThan(2_000);
  });

  it("debits one shared budget across tool-loop model dispatches", async () => {
    const observedMaxTokens: number[] = [];
    const streamFn = wrapStreamFnWithTotalTokenBudget(
      ((_model, _context, options) => {
        observedMaxTokens.push(options?.maxTokens ?? 0);
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() =>
          stream.push({
            type: "done",
            reason: "stop",
            message: {
              role: "assistant",
              content: [],
              api: "openai-responses",
              provider: "openai",
              model: "test",
              stopReason: "stop",
              timestamp: Date.now(),
              usage: {
                input: 1_000,
                output: 1_000,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
            },
          }),
        );
        return stream;
      }) as never,
      4_000,
    );
    const context = { systemPrompt: "system", messages: [] } as never;

    await (await streamFn({} as never, context, { maxTokens: 2_000 })).result();
    await (await streamFn({} as never, context, { maxTokens: 2_000 })).result();

    expect(observedMaxTokens[0]).toBe(2_000);
    expect(observedMaxTokens[1]).toBeLessThanOrEqual(2_000);
    expect(observedMaxTokens[1]).toBeGreaterThan(0);
    expect(() => streamFn({} as never, context, { maxTokens: 2_000 })).toThrow(
      AgentTotalTokenBudgetExceededError,
    );
  });

  it("rejects a request whose complete estimated input exhausts the total cap", () => {
    expect(() =>
      applyAgentTotalTokenBudget({
        streamParams: { maxTokens: 100, maxTotalTokens: 20 },
        messages: [],
        systemPrompt: "large system prompt ".repeat(100),
        prompt: "worker request",
        tools: [],
        toolNames: new Set(),
      }),
    ).toThrow(AgentTotalTokenBudgetExceededError);
  });
});
