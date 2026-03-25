import { describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../types.js";
import {
  maybeSendSyntheticBlockTtsFinal,
  sendDispatchFinalPayload,
} from "./dispatch-final-delivery.js";

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

describe("dispatch-final-delivery", () => {
  it("applies TTS and routes final payloads through observed delivery", async () => {
    const observer = createObserver();
    const updateTrackedTurnState = vi.fn();
    const routeDeliver = vi.fn(async (payload: ReplyPayload) => ({
      ok: true as const,
      error: undefined,
      sent: payload,
    }));

    const result = await sendDispatchFinalPayload({
      payload: { text: "hello" },
      applyTts: async (payload) => ({
        ...payload,
        mediaUrl: "https://example.com/tts.opus",
        audioAsVoice: true,
      }),
      observer,
      updateTrackedTurnState,
      route: {
        enabled: true,
        deliver: routeDeliver,
        logMessage: "dispatch-from-config: route-reply (final) failed",
      },
      dispatch: {
        sendFinalReply: vi.fn(() => true),
      },
    });

    expect(result).toEqual({ queuedFinal: true, routedFinalCount: 1 });
    expect(updateTrackedTurnState).toHaveBeenCalledWith({
      phase: "delivery_prepare",
      markVisible: true,
      markProgress: true,
    });
    expect(routeDeliver).toHaveBeenCalledWith({
      text: "hello",
      mediaUrl: "https://example.com/tts.opus",
      audioAsVoice: true,
    });
    expect(observer.recordDeliverySuccess).toHaveBeenCalledWith("final_sent");
  });

  it("sends TTS-only synthetic finals after block streaming completes", async () => {
    const observer = createObserver();
    const routeDeliver = vi.fn(async (payload: ReplyPayload) => ({
      ok: true as const,
      error: undefined,
      sent: payload,
    }));

    const result = await maybeSendSyntheticBlockTtsFinal({
      ttsMode: "final",
      repliesLength: 0,
      blockCount: 2,
      accumulatedBlockText: "hello\nworld",
      synthesizeFinalTts: async () => ({
        mediaUrl: "https://example.com/tts-synth.opus",
        audioAsVoice: true,
      }),
      observer,
      route: {
        enabled: true,
        deliver: routeDeliver,
        logMessage: "dispatch-from-config: route-reply (tts-only) failed",
      },
      dispatch: {
        sendFinalReply: vi.fn(() => true),
      },
    });

    expect(result).toEqual({ queuedFinal: true, routedFinalCount: 1 });
    expect(routeDeliver).toHaveBeenCalledWith({
      mediaUrl: "https://example.com/tts-synth.opus",
      audioAsVoice: true,
    });
  });

  it("no-ops synthetic TTS finals when no final audio is produced", async () => {
    const observer = createObserver();
    const sendFinalReply = vi.fn(() => true);

    const result = await maybeSendSyntheticBlockTtsFinal({
      ttsMode: "final",
      repliesLength: 0,
      blockCount: 1,
      accumulatedBlockText: "hello",
      synthesizeFinalTts: async () => ({ text: "hello" }),
      observer,
      dispatch: {
        sendFinalReply,
      },
    });

    expect(result).toEqual({ queuedFinal: false, routedFinalCount: 0 });
    expect(sendFinalReply).not.toHaveBeenCalled();
  });
});
