import { estimateTokensFromChars } from "../../../utils/cjk-chars.js";
import type { AgentStreamParams } from "../../command/shared-types.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { StreamFn } from "../../runtime/index.js";
import { normalizeUsage, type UsageLike } from "../../usage.js";
import { estimateLlmBoundaryTokenPressure } from "./preemptive-compaction.js";

export class AgentTotalTokenBudgetExceededError extends Error {
  constructor() {
    super("estimated agent input exhausts the request total-token budget");
    this.name = "AgentTotalTokenBudgetExceededError";
  }
}

function estimateSerializedToolTokens(tools: readonly unknown[], toolNames: ReadonlySet<string>) {
  let serialized = "";
  try {
    serialized = JSON.stringify({ tools, toolNames: [...toolNames].toSorted() }) ?? "";
  } catch {
    // Tool definitions should be JSON-shaped. If a plugin violates that contract,
    // reserve their names and let the provider's normal context guard handle the rest.
    serialized = JSON.stringify({ toolNames: [...toolNames].toSorted() });
  }
  return estimateTokensFromChars(serialized.length);
}

export function applyAgentTotalTokenBudget(params: {
  streamParams: AgentStreamParams;
  messages: AgentMessage[];
  systemPrompt: string;
  prompt: string;
  tools: readonly unknown[];
  toolNames: ReadonlySet<string>;
}): AgentStreamParams {
  const { maxTotalTokens, ...providerParams } = params.streamParams;
  if (maxTotalTokens === undefined) {
    return providerParams;
  }
  const totalBudget = Math.max(0, Math.trunc(maxTotalTokens));
  const estimatedInputTokens =
    estimateLlmBoundaryTokenPressure({
      messages: params.messages,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
    }) + estimateSerializedToolTokens(params.tools, params.toolNames);
  const availableOutputTokens = totalBudget - estimatedInputTokens;
  if (availableOutputTokens < 1) {
    throw new AgentTotalTokenBudgetExceededError();
  }
  return {
    ...providerParams,
    maxTotalTokens: totalBudget,
    maxTokens: Math.min(
      availableOutputTokens,
      providerParams.maxTokens === undefined
        ? availableOutputTokens
        : Math.max(1, Math.trunc(providerParams.maxTokens)),
    ),
  };
}

function readResultUsage(value: unknown): number | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = normalizeUsage((value as { usage?: UsageLike }).usage);
  return usage?.total;
}

function observeBudgetSettlement<T extends object>(
  stream: T,
  settle: (result: unknown) => void,
): T {
  const resultFn = "result" in stream && typeof stream.result === "function" ? stream.result : null;
  const observedResult = resultFn
    ? (...args: unknown[]) =>
        Promise.resolve(resultFn.apply(stream, args)).then((result) => {
          settle(result);
          return result;
        })
    : undefined;
  const iteratorFactory = stream[Symbol.asyncIterator as keyof T];
  if (typeof iteratorFactory !== "function") {
    return stream;
  }
  const observedIterator = async function* () {
    for await (const event of stream as AsyncIterable<unknown>) {
      if (event && typeof event === "object") {
        const terminal = event as { type?: unknown; message?: unknown; error?: unknown };
        if (terminal.type === "done" || terminal.type === "error") {
          settle(terminal.type === "done" ? terminal.message : terminal.error);
        }
      }
      yield event;
    }
  };
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === Symbol.asyncIterator) {
        return observedIterator;
      }
      if (property === "result" && observedResult) {
        return observedResult;
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function wrapStreamFnWithTotalTokenBudget(
  streamFn: StreamFn,
  maxTotalTokens: number,
): StreamFn {
  let remainingTokens = Math.max(0, Math.trunc(maxTotalTokens));
  return ((model, context, options) => {
    const estimatedInputTokens =
      estimateLlmBoundaryTokenPressure({
        messages: context.messages as AgentMessage[],
        systemPrompt: context.systemPrompt ?? "",
        prompt: "",
      }) +
      estimateSerializedToolTokens(
        context.tools ?? [],
        new Set((context.tools ?? []).map((tool) => tool.name)),
      );
    const availableOutputTokens = remainingTokens - estimatedInputTokens;
    if (availableOutputTokens < 1) {
      throw new AgentTotalTokenBudgetExceededError();
    }
    const maxTokens = Math.min(
      availableOutputTokens,
      options?.maxTokens === undefined
        ? availableOutputTokens
        : Math.max(1, Math.trunc(options.maxTokens)),
    );
    let settled = false;
    const settle = (result: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      remainingTokens = Math.max(
        0,
        remainingTokens - (readResultUsage(result) ?? estimatedInputTokens + maxTokens),
      );
    };
    const result = streamFn(model, context, { ...options, maxTokens });
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      return Promise.resolve(result).then((stream) => observeBudgetSettlement(stream, settle));
    }
    return observeBudgetSettlement(result, settle);
  }) as StreamFn;
}
