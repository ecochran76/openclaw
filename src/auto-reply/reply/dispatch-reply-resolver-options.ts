import type { BlockReplyContext, GetReplyOptions, ReplyPayload } from "../types.js";
import type { DeliveryObserver } from "./delivery-observer.js";

export function createDispatchReplyResolverOptions(params: {
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  typingPolicy?: GetReplyOptions["typingPolicy"];
  suppressTyping?: boolean;
  observer: Pick<DeliveryObserver, "startRun" | "updateActiveTurn">;
  onToolResult: NonNullable<GetReplyOptions["onToolResult"]>;
  onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]>;
}): GetReplyOptions {
  return {
    ...params.replyOptions,
    typingPolicy: params.typingPolicy,
    suppressTyping: params.suppressTyping,
    onAgentRunStart: (runId: string) => {
      params.observer.startRun(runId);
      params.replyOptions?.onAgentRunStart?.(runId);
    },
    onReasoningStream: async (payload) => {
      params.observer.updateActiveTurn({ phase: "reasoning", markProgress: true });
      await params.replyOptions?.onReasoningStream?.(payload);
    },
    onAssistantMessageStart: async () => {
      params.observer.updateActiveTurn({ phase: "delivery_prepare", markProgress: true });
      await params.replyOptions?.onAssistantMessageStart?.();
    },
    onToolStart: async (payload) => {
      params.observer.updateActiveTurn({
        phase: "tool_wait",
        activeTool: payload.name,
        markProgress: true,
      });
      await params.replyOptions?.onToolStart?.(payload);
    },
    onCompactionStart: async () => {
      params.observer.updateActiveTurn({
        phase: "compaction",
        activeTool: undefined,
        markProgress: true,
      });
      await params.replyOptions?.onCompactionStart?.();
    },
    onCompactionEnd: async () => {
      params.observer.updateActiveTurn({
        phase: "reasoning",
        activeTool: undefined,
        markProgress: true,
      });
      await params.replyOptions?.onCompactionEnd?.();
    },
    onToolResult: async (payload) => {
      await params.onToolResult(payload);
    },
    onBlockReply: async (payload: ReplyPayload, context?: BlockReplyContext) => {
      await params.onBlockReply(payload, context);
    },
  };
}
