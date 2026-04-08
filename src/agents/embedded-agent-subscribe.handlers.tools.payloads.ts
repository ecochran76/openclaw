import {
  buildExecApprovalPendingReplyPayload,
  buildExecApprovalUnavailableReplyPayload,
} from "../infra/exec-approval-reply.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import { buildA2APermissionApprovalPendingReplyPayload } from "./a2a/permission-approval-reply.js";
import type { SessionAccessPermissionRequest } from "./tools/sessions-access.js";

type ToolResultRecord = Record<string, unknown>;

export type ExecApprovalPendingDetails = {
  approvalId: string;
  approvalSlug: string;
  expiresAtMs?: number;
  allowedDecisions?: readonly ExecApprovalDecision[];
  host: "gateway" | "node";
  command: string;
  cwd?: string;
  nodeId?: string;
  warningText?: string;
};

export type ExecApprovalUnavailableDetails = {
  reason: "initiating-platform-disabled" | "initiating-platform-unsupported" | "no-approval-route";
  warningText?: string;
  channel?: string;
  channelLabel?: string;
  accountId?: string;
  sentApproverDms?: boolean;
};

export type A2AApprovalPendingDetails = {
  approvalId: string;
  expiresAt?: number;
  permissionRequest: SessionAccessPermissionRequest;
};

function readToolResultDetailsRecord(result: unknown): ToolResultRecord | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const details = (result as { details?: unknown }).details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? (details as ToolResultRecord)
    : undefined;
}

export function readExecApprovalPendingDetails(result: unknown): ExecApprovalPendingDetails | null {
  const details = readToolResultDetailsRecord(result);
  if (!details || details.status !== "approval-pending") {
    return null;
  }
  const approvalId = typeof details.approvalId === "string" ? details.approvalId.trim() : "";
  const approvalSlug = typeof details.approvalSlug === "string" ? details.approvalSlug.trim() : "";
  const command = typeof details.command === "string" ? details.command : "";
  const host = details.host === "node" ? "node" : details.host === "gateway" ? "gateway" : null;
  if (!approvalId || !approvalSlug || !command || !host) {
    return null;
  }
  return {
    approvalId,
    approvalSlug,
    expiresAtMs: typeof details.expiresAtMs === "number" ? details.expiresAtMs : undefined,
    allowedDecisions: Array.isArray(details.allowedDecisions)
      ? details.allowedDecisions.filter(
          (decision): decision is ExecApprovalDecision =>
            decision === "allow-once" || decision === "allow-always" || decision === "deny",
        )
      : undefined,
    host,
    command,
    cwd: typeof details.cwd === "string" ? details.cwd : undefined,
    nodeId: typeof details.nodeId === "string" ? details.nodeId : undefined,
    warningText: typeof details.warningText === "string" ? details.warningText : undefined,
  };
}

export function readExecApprovalUnavailableDetails(
  result: unknown,
): ExecApprovalUnavailableDetails | null {
  const details = readToolResultDetailsRecord(result);
  if (!details || details.status !== "approval-unavailable") {
    return null;
  }
  const reason =
    details.reason === "initiating-platform-disabled" ||
    details.reason === "initiating-platform-unsupported" ||
    details.reason === "no-approval-route"
      ? details.reason
      : null;
  if (!reason) {
    return null;
  }
  return {
    reason,
    warningText: typeof details.warningText === "string" ? details.warningText : undefined,
    channel: typeof details.channel === "string" ? details.channel : undefined,
    channelLabel: typeof details.channelLabel === "string" ? details.channelLabel : undefined,
    accountId: typeof details.accountId === "string" ? details.accountId : undefined,
    sentApproverDms: details.sentApproverDms === true,
  };
}

export function readA2APermissionApprovalDetails(
  result: unknown,
): A2AApprovalPendingDetails | null {
  const details = readToolResultDetailsRecord(result);
  if (!details || details.status !== "forbidden") {
    return null;
  }
  const pendingApproval =
    details.pendingApproval && typeof details.pendingApproval === "object"
      ? (details.pendingApproval as Record<string, unknown>)
      : null;
  const permissionRequest =
    details.permissionRequest && typeof details.permissionRequest === "object"
      ? (details.permissionRequest as Record<string, unknown>)
      : null;
  if (!pendingApproval || !permissionRequest) {
    return null;
  }
  const approvalId =
    typeof pendingApproval.approvalId === "string" ? pendingApproval.approvalId.trim() : "";
  const state = typeof pendingApproval.state === "string" ? pendingApproval.state.trim() : "";
  const reason =
    permissionRequest.reason === "agent_to_agent_disabled" ||
    permissionRequest.reason === "agent_to_agent_allow" ||
    permissionRequest.reason === "session_visibility"
      ? permissionRequest.reason
      : null;
  const action =
    permissionRequest.action === "send" ||
    permissionRequest.action === "history" ||
    permissionRequest.action === "list" ||
    permissionRequest.action === "status"
      ? permissionRequest.action
      : null;
  const requesterAgentId =
    typeof permissionRequest.requesterAgentId === "string"
      ? permissionRequest.requesterAgentId.trim()
      : "";
  const targetAgentId =
    typeof permissionRequest.targetAgentId === "string"
      ? permissionRequest.targetAgentId.trim()
      : "";
  const suggestedChanges = Array.isArray(permissionRequest.suggestedChanges)
    ? permissionRequest.suggestedChanges
        .map((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return null;
          }
          const record = entry as Record<string, unknown>;
          const path =
            record.path === "tools.agentToAgent.enabled" ||
            record.path === "tools.agentToAgent.allow" ||
            record.path === "tools.sessions.visibility"
              ? record.path
              : null;
          if (!path) {
            return null;
          }
          const value = record.value;
          if (typeof value !== "boolean" && typeof value !== "string" && !Array.isArray(value)) {
            return null;
          }
          return {
            path,
            value: value as boolean | string | string[],
          };
        })
        .filter(
          (
            entry,
          ): entry is {
            path:
              | "tools.agentToAgent.enabled"
              | "tools.agentToAgent.allow"
              | "tools.sessions.visibility";
            value: boolean | string | string[];
          } => Boolean(entry),
        )
    : [];
  if (
    !approvalId ||
    state !== "pending" ||
    !reason ||
    !action ||
    !requesterAgentId ||
    !targetAgentId ||
    suggestedChanges.length === 0 ||
    permissionRequest.retryable !== true
  ) {
    return null;
  }
  const missingAllowAgents = Array.isArray(permissionRequest.missingAllowAgents)
    ? permissionRequest.missingAllowAgents.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      )
    : undefined;
  return {
    approvalId,
    expiresAt:
      typeof pendingApproval.expiresAt === "number" && Number.isFinite(pendingApproval.expiresAt)
        ? pendingApproval.expiresAt
        : undefined,
    permissionRequest: {
      kind: "config_permission_request",
      reason,
      action,
      requesterAgentId,
      targetAgentId,
      retryable: true,
      askUser:
        typeof permissionRequest.askUser === "string"
          ? permissionRequest.askUser
          : "Ask the user to approve this agent-to-agent permission change and retry.",
      suggestedChanges,
      ...(missingAllowAgents?.length ? { missingAllowAgents } : {}),
    },
  };
}

export function buildExecApprovalReplyPayload(params: {
  details: ExecApprovalPendingDetails;
}): ReturnType<typeof buildExecApprovalPendingReplyPayload> {
  return buildExecApprovalPendingReplyPayload({
    approvalId: params.details.approvalId,
    approvalSlug: params.details.approvalSlug,
    allowedDecisions: params.details.allowedDecisions,
    command: params.details.command,
    cwd: params.details.cwd,
    host: params.details.host,
    nodeId: params.details.nodeId,
    expiresAtMs: params.details.expiresAtMs,
    warningText: params.details.warningText,
  });
}

export function buildExecApprovalUnavailableReply(params: {
  details: ExecApprovalUnavailableDetails;
}): ReturnType<typeof buildExecApprovalUnavailableReplyPayload> {
  return buildExecApprovalUnavailableReplyPayload({
    reason: params.details.reason,
    warningText: params.details.warningText,
    channel: params.details.channel,
    channelLabel: params.details.channelLabel,
    accountId: params.details.accountId,
    sentApproverDms: params.details.sentApproverDms,
  });
}

export function buildA2AApprovalReplyPayload(params: {
  details: A2AApprovalPendingDetails;
  sessionKey?: string;
}): ReturnType<typeof buildA2APermissionApprovalPendingReplyPayload> {
  return buildA2APermissionApprovalPendingReplyPayload({
    approvalId: params.details.approvalId,
    permissionRequest: params.details.permissionRequest,
    expiresAt: params.details.expiresAt,
    sessionKey: params.sessionKey,
  });
}
