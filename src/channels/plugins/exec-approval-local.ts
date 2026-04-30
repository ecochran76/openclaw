import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasActiveApprovalNativeRouteRuntime } from "../../infra/approval-native-route-coordinator.js";
import { getChannelPlugin, normalizeChannelId } from "./registry.js";

function hasExecApprovalPrompt(payload: ReplyPayload): boolean {
  return Boolean(
    payload.channelData &&
    typeof payload.channelData === "object" &&
    !Array.isArray(payload.channelData) &&
    payload.channelData.execApproval &&
    typeof payload.channelData.execApproval === "object" &&
    !Array.isArray(payload.channelData.execApproval),
  );
}

export function shouldSuppressLocalExecApprovalPrompt(params: {
  channel?: string | null;
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  const channel = params.channel
    ? (normalizeChannelId(params.channel) ?? normalizeLowercaseStringOrEmpty(params.channel))
    : null;
  if (!channel) {
    return false;
  }
  const nativeRouteActive = hasActiveApprovalNativeRouteRuntime({
    channel,
    accountId: params.accountId,
    approvalKind: "exec",
  });
  const pluginDecision = getChannelPlugin(channel)?.outbound?.shouldSuppressLocalPayloadPrompt?.({
    cfg: params.cfg,
    accountId: params.accountId,
    payload: params.payload,
    hint: {
      kind: "approval-pending",
      approvalKind: "exec",
      nativeRouteActive,
    },
  });
  return pluginDecision === true || (nativeRouteActive && hasExecApprovalPrompt(params.payload));
}
