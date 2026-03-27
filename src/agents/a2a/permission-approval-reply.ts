import type { ReplyPayload } from "../../auto-reply/types.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { SessionAccessPermissionRequest } from "../tools/sessions-access.js";

export type A2APermissionApprovalDecision = "approve" | "deny";

export type A2APermissionApprovalAction = {
  approvalId: string;
  decision: A2APermissionApprovalDecision;
};

export type A2APermissionApprovalReplyMetadata = {
  approvalId: string;
  requesterAgentId: string;
  targetAgentId: string;
  reason: SessionAccessPermissionRequest["reason"];
  action: SessionAccessPermissionRequest["action"];
  expiresAt?: number;
};

export type BuildA2APermissionApprovalPendingReplyPayloadParams = {
  approvalId: string;
  permissionRequest: SessionAccessPermissionRequest;
  expiresAt?: number;
  nowMs?: number;
  sessionKey?: string;
};

const A2A_PERMISSION_APPROVAL_CUSTOM_ID_PREFIX = "a2aapproval";

function encodeCustomIdValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCustomIdValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function formatAgentPair(request: SessionAccessPermissionRequest): string {
  return `\`${request.requesterAgentId} -> ${request.targetAgentId}\``;
}

function resolvePermissionPathLabel(reason: SessionAccessPermissionRequest["reason"]): string {
  if (reason === "agent_to_agent_disabled") {
    return "tools.agentToAgent.enabled";
  }
  if (reason === "agent_to_agent_allow") {
    return "tools.agentToAgent.allow";
  }
  return "tools.sessions.visibility";
}

function buildPatchSummary(request: SessionAccessPermissionRequest): string {
  if (request.reason === "agent_to_agent_disabled") {
    return "Set `tools.agentToAgent.enabled=true`.";
  }
  if (request.reason === "agent_to_agent_allow") {
    const missing = (request.missingAllowAgents ?? []).filter(Boolean);
    if (missing.length === 0) {
      return "Update `tools.agentToAgent.allow` for this agent pair.";
    }
    if (missing.length === 1) {
      return `Add \`${missing[0]}\` to \`tools.agentToAgent.allow\`.`;
    }
    return `Add ${missing.map((agentId) => `\`${agentId}\``).join(", ")} to \`tools.agentToAgent.allow\`.`;
  }
  return "Set `tools.sessions.visibility=all`.";
}

function buildPendingApprovalText(
  params: BuildA2APermissionApprovalPendingReplyPayloadParams,
): string {
  const gate = resolvePermissionPathLabel(params.permissionRequest.reason);
  const lines: string[] = [];
  lines.push(
    `Permission required: ${formatAgentPair(params.permissionRequest)} is blocked by \`${gate}\`.`,
  );
  const missing = (params.permissionRequest.missingAllowAgents ?? []).filter(Boolean);
  if (missing.length > 0) {
    lines.push(`Missing allow entries: ${missing.map((agentId) => `\`${agentId}\``).join(", ")}.`);
  }
  lines.push(buildPatchSummary(params.permissionRequest));
  lines.push("Approve the narrow config change, then retry the request.");
  if (typeof params.expiresAt === "number" && Number.isFinite(params.expiresAt)) {
    const expiresInSeconds = Math.max(
      0,
      Math.round((params.expiresAt - (params.nowMs ?? Date.now())) / 1000),
    );
    lines.push(`Expires in: ${expiresInSeconds}s.`);
  }
  return lines.join("\n\n");
}

function shouldRenderInteractiveButtons(sessionKey?: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  return (parsed?.rest ?? "").startsWith("slack:");
}

export function buildA2APermissionApprovalCustomId(
  approvalId: string,
  decision: A2APermissionApprovalDecision,
): string {
  const decisionCode = decision === "approve" ? "a" : "d";
  return `${A2A_PERMISSION_APPROVAL_CUSTOM_ID_PREFIX}:${encodeCustomIdValue(approvalId)}:${decisionCode}`;
}

export function parseA2APermissionApprovalCustomId(
  value: string,
): A2APermissionApprovalAction | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(`${A2A_PERMISSION_APPROVAL_CUSTOM_ID_PREFIX}:`)) {
    return null;
  }
  const body = trimmed.slice(`${A2A_PERMISSION_APPROVAL_CUSTOM_ID_PREFIX}:`.length);
  const separator = body.lastIndexOf(":");
  if (separator <= 0 || separator === body.length - 1) {
    return null;
  }
  const rawApprovalId = body.slice(0, separator).trim();
  const rawDecisionCode = body
    .slice(separator + 1)
    .trim()
    .toLowerCase();
  if (!rawApprovalId) {
    return null;
  }
  const decision = rawDecisionCode === "a" ? "approve" : rawDecisionCode === "d" ? "deny" : null;
  if (!decision) {
    return null;
  }
  return {
    approvalId: decodeCustomIdValue(rawApprovalId),
    decision,
  };
}

export function buildA2APermissionApprovalPendingReplyPayload(
  params: BuildA2APermissionApprovalPendingReplyPayloadParams,
): ReplyPayload {
  const text = buildPendingApprovalText(params);
  const interactive = shouldRenderInteractiveButtons(params.sessionKey)
    ? {
        blocks: [
          { type: "text" as const, text },
          {
            type: "buttons" as const,
            buttons: [
              {
                label: "Approve",
                value: buildA2APermissionApprovalCustomId(params.approvalId, "approve"),
                style: "success" as const,
              },
              {
                label: "Deny",
                value: buildA2APermissionApprovalCustomId(params.approvalId, "deny"),
                style: "danger" as const,
              },
            ],
          },
        ],
      }
    : undefined;

  return {
    text,
    interactive,
    channelData: {
      a2aApproval: {
        approvalId: params.approvalId,
        requesterAgentId: params.permissionRequest.requesterAgentId,
        targetAgentId: params.permissionRequest.targetAgentId,
        reason: params.permissionRequest.reason,
        action: params.permissionRequest.action,
        ...(typeof params.expiresAt === "number" && Number.isFinite(params.expiresAt)
          ? { expiresAt: params.expiresAt }
          : {}),
      },
    },
  };
}

export function getA2APermissionApprovalReplyMetadata(
  payload: ReplyPayload,
): A2APermissionApprovalReplyMetadata | null {
  const channelData = payload.channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return null;
  }
  const a2aApproval = channelData.a2aApproval;
  if (!a2aApproval || typeof a2aApproval !== "object" || Array.isArray(a2aApproval)) {
    return null;
  }
  const record = a2aApproval as Record<string, unknown>;
  const approvalId = readTrimmedString(record.approvalId);
  const requesterAgentId = readTrimmedString(record.requesterAgentId);
  const targetAgentId = readTrimmedString(record.targetAgentId);
  const reason =
    record.reason === "agent_to_agent_disabled" ||
    record.reason === "agent_to_agent_allow" ||
    record.reason === "session_visibility"
      ? record.reason
      : null;
  const action =
    record.action === "send" ||
    record.action === "history" ||
    record.action === "list" ||
    record.action === "status"
      ? record.action
      : null;
  if (!approvalId || !requesterAgentId || !targetAgentId || !reason || !action) {
    return null;
  }
  return {
    approvalId,
    requesterAgentId,
    targetAgentId,
    reason,
    action,
    expiresAt:
      typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
        ? record.expiresAt
        : undefined,
  };
}
