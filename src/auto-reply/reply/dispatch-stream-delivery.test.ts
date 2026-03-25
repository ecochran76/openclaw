import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import { createDispatchStreamDeliveryCoordinator } from "./dispatch-stream-delivery.js";

function createObserver() {
  return {
    classifyPayloadVisibility: vi.fn(() => ({ visibility: "visible" as const })),
    updateActiveTurn: vi.fn(),
    startRun: vi.fn(),
    markReplyProduced: vi.fn(),
    recordDeliveryAttempt: vi.fn(),
    recordDeliverySuccess: vi.fn(),
    recordDeliveryFailure: vi.fn(),
    recordSuppressedReply: vi.fn(),
    finishRun: vi.fn(),
    buildUndeliveredReplyNotice: vi.fn(),
    markNoticeDelivered: vi.fn(),
  };
}

describe("createDispatchStreamDeliveryCoordinator", () => {
  it("suppresses tool summaries while preserving media-only payloads", async () => {
    const observer = createObserver();
    const sendToolResult = vi.fn(() => true);
    const coordinator = createDispatchStreamDeliveryCoordinator({
      cfg: {} as never,
      currentChannel: "telegram",
      accountId: "acc-1",
      shouldSendToolSummaries: false,
      observer,
      applyTts: async (_kind, payload) => payload,
      shouldRouteToOriginating: false,
      sendPayloadAsync: async () => true,
      dispatcher: {
        sendToolResult,
        sendBlockReply: vi.fn(() => true),
      },
    });

    await coordinator.deliverToolResult({ text: "tool summary only" });
    await coordinator.deliverToolResult({
      text: "NO_REPLY",
      mediaUrl: "https://example.com/tts.opus",
    });

    expect(sendToolResult).toHaveBeenCalledTimes(1);
    expect(sendToolResult).toHaveBeenCalledWith({
      text: undefined,
      mediaUrl: "https://example.com/tts.opus",
    });
  });

  it("preserves deterministic exec approval tool payloads even when summaries are suppressed", async () => {
    const observer = createObserver();
    const sendToolResult = vi.fn(() => true);
    const payload: ReplyPayload = {
      text: "Approval required",
      channelData: {
        execApproval: {
          approvalId: "id-1",
          approvalSlug: "id-1",
          allowedDecisions: ["allow-once"],
        },
      },
    };
    const coordinator = createDispatchStreamDeliveryCoordinator({
      cfg: {} as never,
      currentChannel: "telegram",
      accountId: "acc-1",
      shouldSendToolSummaries: false,
      observer,
      applyTts: async (_kind, incoming) => incoming,
      shouldRouteToOriginating: false,
      sendPayloadAsync: async () => true,
      dispatcher: {
        sendToolResult,
        sendBlockReply: vi.fn(() => true),
      },
    });

    await coordinator.deliverToolResult(payload);

    expect(sendToolResult).toHaveBeenCalledWith(payload);
  });

  it("accumulates block text while ignoring reasoning and compaction notices", async () => {
    const observer = createObserver();
    const sendBlockReply = vi.fn(() => true);
    const coordinator = createDispatchStreamDeliveryCoordinator({
      cfg: {} as never,
      currentChannel: "whatsapp",
      accountId: "acc-1",
      shouldSendToolSummaries: true,
      observer,
      applyTts: async (_kind, payload) => payload,
      shouldRouteToOriginating: false,
      sendPayloadAsync: async () => true,
      dispatcher: {
        sendToolResult: vi.fn(() => true),
        sendBlockReply,
      },
    });

    await coordinator.deliverBlockReply({ text: "Reasoning", isReasoning: true });
    await coordinator.deliverBlockReply({ text: "status", isCompactionNotice: true });
    await coordinator.deliverBlockReply({ text: "Hello" });
    await coordinator.deliverBlockReply({ text: "world" });

    expect(sendBlockReply).toHaveBeenCalledTimes(3);
    expect(coordinator.getBlockCount()).toBe(2);
    expect(coordinator.getAccumulatedBlockText()).toBe("Hello\nworld");
  });
});
