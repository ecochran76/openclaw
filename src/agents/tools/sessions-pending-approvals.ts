import {
  createPendingA2AApproval,
  toPendingA2AApprovalReference,
  type PendingA2AApprovalReference,
  type PendingA2AApprovalToolName,
} from "../a2a/permission-approvals.js";
import type { SessionAccessPermissionRequest } from "./sessions-access.js";

function normalizeThreadId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export async function buildPendingSessionApprovalOutput(params: {
  permissionRequest?: SessionAccessPermissionRequest;
  requesterSessionKey?: string;
  originalToolName: PendingA2AApprovalToolName;
  originalArgs: Record<string, unknown>;
}): Promise<{ pendingApproval?: PendingA2AApprovalReference }> {
  if (!params.permissionRequest) {
    return {};
  }
  try {
    const record = await createPendingA2AApproval({
      permissionRequest: params.permissionRequest,
      originalToolName: params.originalToolName,
      originalArgs: params.originalArgs,
      sessionKey: params.requesterSessionKey,
      threadId: normalizeThreadId(params.originalArgs.threadId),
    });
    return { pendingApproval: toPendingA2AApprovalReference(record) };
  } catch {
    // Permission denials should still reach the agent even if the durable store is unavailable.
    return {};
  }
}
