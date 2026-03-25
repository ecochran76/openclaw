import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { createDispatchReplyResolverOptions } from "./dispatch-reply-resolver-options.js";

function createObserver() {
  return {
    startRun: vi.fn(),
    updateActiveTurn: vi.fn(),
  };
}

describe("createDispatchReplyResolverOptions", () => {
  it("updates tracked-turn state and forwards lifecycle callbacks", async () => {
    const observer = createObserver();
    const onAgentRunStart = vi.fn();
    const onReasoningStream = vi.fn(async () => {});
    const onAssistantMessageStart = vi.fn(async () => {});
    const onToolStart = vi.fn(async () => {});
    const onCompactionStart = vi.fn(async () => {});
    const onCompactionEnd = vi.fn(async () => {});

    const opts = createDispatchReplyResolverOptions({
      replyOptions: {
        onAgentRunStart,
        onReasoningStream,
        onAssistantMessageStart,
        onToolStart,
        onCompactionStart,
        onCompactionEnd,
      },
      typingPolicy: "user_message",
      suppressTyping: true,
      observer,
      onToolResult: vi.fn(async () => {}),
      onBlockReply: vi.fn(async () => {}),
    });

    opts.onAgentRunStart?.("run-1");
    await opts.onReasoningStream?.({ text: "thinking" });
    await opts.onAssistantMessageStart?.();
    await opts.onToolStart?.({ name: "bash", phase: "running" });
    await opts.onCompactionStart?.();
    await opts.onCompactionEnd?.();

    expect(opts.typingPolicy).toBe("user_message");
    expect(opts.suppressTyping).toBe(true);
    expect(observer.startRun).toHaveBeenCalledWith("run-1");
    expect(onAgentRunStart).toHaveBeenCalledWith("run-1");
    expect(onReasoningStream).toHaveBeenCalledWith({ text: "thinking" });
    expect(onAssistantMessageStart).toHaveBeenCalled();
    expect(onToolStart).toHaveBeenCalledWith({ name: "bash", phase: "running" });
    expect(onCompactionStart).toHaveBeenCalled();
    expect(onCompactionEnd).toHaveBeenCalled();
    expect(observer.updateActiveTurn.mock.calls).toEqual([
      [{ phase: "reasoning", markProgress: true }],
      [{ phase: "delivery_prepare", markProgress: true }],
      [{ phase: "tool_wait", activeTool: "bash", markProgress: true }],
      [{ phase: "compaction", activeTool: undefined, markProgress: true }],
      [{ phase: "reasoning", activeTool: undefined, markProgress: true }],
    ]);
  });

  it("delegates tool results and block replies through injected handlers", async () => {
    const observer = createObserver();
    const calls: string[] = [];
    const onToolResult = vi.fn(async (payload: ReplyPayload) => {
      calls.push(`tool:${payload.text ?? ""}`);
    });
    const onBlockReply = vi.fn(async (payload: ReplyPayload, context) => {
      calls.push(`block:${payload.text ?? ""}:${context?.timeoutMs ?? 0}`);
    });
    const beforeBlockReply = vi.fn((payload: ReplyPayload) => {
      calls.push(`before:${payload.text ?? ""}`);
    });

    const opts = createDispatchReplyResolverOptions({
      observer,
      onToolResult,
      onBlockReply,
      beforeBlockReply,
    });

    await opts.onToolResult?.({ text: "tool payload" });
    await opts.onBlockReply?.({ text: "block payload" }, { timeoutMs: 25 });

    expect(onToolResult).toHaveBeenCalledWith({ text: "tool payload" });
    expect(beforeBlockReply).toHaveBeenCalledWith({ text: "block payload" });
    expect(onBlockReply).toHaveBeenCalledWith({ text: "block payload" }, { timeoutMs: 25 });
    expect(calls).toEqual(["tool:tool payload", "before:block payload", "block:block payload:25"]);
  });
});
