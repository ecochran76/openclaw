import type { BlockReplyContext, GetReplyOptions, ReplyPayload } from "../types.js";
import type { DeliveryObserver } from "./delivery-observer.js";

function normalizeWorkingLabel(label: string): string {
  const collapsed = label.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 80) {
    return collapsed;
  }
  return `${collapsed.slice(0, 77).trimEnd()}...`;
}

function formatPlanUpdateText(payload: { explanation?: string; steps?: string[] }): string {
  const explanation = payload.explanation?.replace(/\s+/g, " ").trim();
  const steps = (payload.steps ?? [])
    .map((step) => step.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const parts: string[] = [];
  if (explanation) {
    parts.push(explanation);
  }
  if (steps.length > 0) {
    parts.push(steps.map((step, index) => `${index + 1}. ${step}`).join("\n"));
  }
  return parts.join("\n\n").trim() || "Planning next steps.";
}

function formatApprovalProgressText(payload: {
  status?: string;
  command?: string;
  title?: string;
  message?: string;
}): string {
  const detail = payload.command?.trim() || payload.title?.trim() || payload.message?.trim();
  if (payload.status === "pending") {
    return detail ? `Working: awaiting approval: ${detail}` : "Working: awaiting approval";
  }
  return detail ? `Working: ${detail}` : "Working: approval update";
}

function summarizePatchLabel(payload: { summary?: string; title?: string }): string {
  const summary = payload.summary?.trim();
  if (summary) {
    return normalizeWorkingLabel(summary);
  }
  const title = payload.title?.trim();
  if (title) {
    return normalizeWorkingLabel(title);
  }
  return "";
}

export function createDispatchReplyResolverOptions(params: {
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  typingPolicy?: GetReplyOptions["typingPolicy"];
  suppressTyping?: boolean;
  observer: Pick<DeliveryObserver, "startRun" | "updateActiveTurn">;
  onToolResult: NonNullable<GetReplyOptions["onToolResult"]>;
  onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]>;
  shouldEmitVerboseProgress?: () => boolean;
}): GetReplyOptions {
  const shouldEmitVerboseProgress = () => params.shouldEmitVerboseProgress?.() === true;
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
    onPlanUpdate: async (payload) => {
      if (shouldEmitVerboseProgress()) {
        await params.onToolResult({ text: formatPlanUpdateText(payload) });
      }
      await params.replyOptions?.onPlanUpdate?.(payload);
    },
    onApprovalEvent: async (payload) => {
      if (shouldEmitVerboseProgress()) {
        await params.onToolResult({ text: formatApprovalProgressText(payload) });
      }
      await params.replyOptions?.onApprovalEvent?.(payload);
    },
    onPatchSummary: async (payload) => {
      if (shouldEmitVerboseProgress()) {
        const summary = summarizePatchLabel(payload);
        if (summary) {
          await params.onToolResult({ text: `Working: ${summary}` });
        }
      }
      await params.replyOptions?.onPatchSummary?.(payload);
    },
    onToolResult: async (payload) => {
      await params.onToolResult(payload);
    },
    onBlockReply: async (payload: ReplyPayload, context?: BlockReplyContext) => {
      await params.onBlockReply(payload, context);
    },
  };
}
