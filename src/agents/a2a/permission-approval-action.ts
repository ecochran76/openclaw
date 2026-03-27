import {
  readConfigFileSnapshotForWrite,
  writeConfigFile,
  type OpenClawConfig,
} from "../../config/config.js";
import {
  checkAgentToAgentAccess,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  type SessionAccessPermissionRequest,
} from "../tools/sessions-access.js";
import type { A2APermissionApprovalDecision } from "./permission-approval-reply.js";
import {
  getPendingA2AApproval,
  resolvePendingA2AApproval,
  type PendingA2AApproval,
} from "./permission-approvals.js";

export type ResolvePendingA2APermissionApprovalParams = {
  approvalId: string;
  decision: A2APermissionApprovalDecision;
  actorId?: string;
  nowMs?: number;
  baseDir?: string;
};

export type ResolvePendingA2APermissionApprovalResult =
  | {
      status: "approved";
      record: PendingA2AApproval;
      changedPaths: Array<
        "tools.agentToAgent.enabled" | "tools.agentToAgent.allow" | "tools.sessions.visibility"
      >;
    }
  | { status: "denied"; record: PendingA2AApproval }
  | { status: "expired"; record: PendingA2AApproval }
  | { status: "obsolete"; record: PendingA2AApproval }
  | { status: "already-resolved"; record: PendingA2AApproval }
  | { status: "not-found" }
  | { status: "error"; error: string };

type ChangedPath =
  | "tools.agentToAgent.enabled"
  | "tools.agentToAgent.allow"
  | "tools.sessions.visibility";

function formatAgentPair(record: PendingA2AApproval): string {
  return `\`${record.requesterAgentId} -> ${record.targetAgentId}\``;
}

function isPermissionRequestSatisfied(
  cfg: OpenClawConfig,
  request: SessionAccessPermissionRequest,
): boolean {
  if (request.reason === "session_visibility") {
    return resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: false }) === "all";
  }
  const access = checkAgentToAgentAccess({
    action: request.action,
    requesterAgentId: request.requesterAgentId,
    targetAgentId: request.targetAgentId,
    a2aPolicy: createAgentToAgentPolicy(cfg),
  });
  return access.allowed;
}

function dedupeTrimmedStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    deduped.push(trimmed);
  }
  return deduped;
}

function applyPendingApprovalPatch(
  cfg: OpenClawConfig,
  request: SessionAccessPermissionRequest,
): { nextConfig: OpenClawConfig; changedPaths: ChangedPath[] } {
  const tools = cfg.tools && typeof cfg.tools === "object" ? cfg.tools : {};

  if (request.reason === "agent_to_agent_disabled") {
    if (tools.agentToAgent?.enabled === true) {
      return { nextConfig: cfg, changedPaths: [] };
    }
    return {
      nextConfig: {
        ...cfg,
        tools: {
          ...tools,
          agentToAgent: {
            ...tools.agentToAgent,
            enabled: true,
          },
        },
      },
      changedPaths: ["tools.agentToAgent.enabled"],
    };
  }

  if (request.reason === "agent_to_agent_allow") {
    const currentAllow = Array.isArray(tools.agentToAgent?.allow)
      ? tools.agentToAgent.allow.map((entry) => String(entry ?? ""))
      : [];
    const missingAllowAgents = dedupeTrimmedStrings(request.missingAllowAgents ?? []);
    const nextAllow = dedupeTrimmedStrings([...currentAllow, ...missingAllowAgents]);
    if (nextAllow.length === currentAllow.length) {
      return { nextConfig: cfg, changedPaths: [] };
    }
    return {
      nextConfig: {
        ...cfg,
        tools: {
          ...tools,
          agentToAgent: {
            ...tools.agentToAgent,
            allow: nextAllow,
          },
        },
      },
      changedPaths: ["tools.agentToAgent.allow"],
    };
  }

  if (tools.sessions?.visibility === "all") {
    return { nextConfig: cfg, changedPaths: [] };
  }

  return {
    nextConfig: {
      ...cfg,
      tools: {
        ...tools,
        sessions: {
          ...tools.sessions,
          visibility: "all",
        },
      },
    },
    changedPaths: ["tools.sessions.visibility"],
  };
}

function buildConfigWriteError(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>["snapshot"],
): string {
  const firstIssue = snapshot.issues[0]?.message?.trim();
  return firstIssue
    ? `Config is invalid. Fix it before approving this request: ${firstIssue}`
    : "Config is invalid. Fix it before approving this request.";
}

function mapTerminalRecord(record: PendingA2AApproval): ResolvePendingA2APermissionApprovalResult {
  if (record.state === "expired") {
    return { status: "expired", record };
  }
  return { status: "already-resolved", record };
}

export async function resolvePendingA2APermissionApproval(
  params: ResolvePendingA2APermissionApprovalParams,
): Promise<ResolvePendingA2APermissionApprovalResult> {
  const nowMs = params.nowMs ?? Date.now();

  if (params.decision === "deny") {
    const denied = await resolvePendingA2AApproval({
      approvalId: params.approvalId,
      decision: "deny",
      actorId: params.actorId,
      nowMs,
      baseDir: params.baseDir,
    });
    if (denied.status === "not-found") {
      return { status: "not-found" };
    }
    if (denied.status === "resolved") {
      return { status: "denied", record: denied.record };
    }
    return mapTerminalRecord(denied.record);
  }

  const pending = await getPendingA2AApproval({
    approvalId: params.approvalId,
    nowMs,
    baseDir: params.baseDir,
  });
  if (!pending) {
    return { status: "not-found" };
  }
  if (pending.state !== "pending") {
    return mapTerminalRecord(pending);
  }

  const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    return { status: "error", error: buildConfigWriteError(snapshot) };
  }

  const currentConfig = snapshot.config;
  if (isPermissionRequestSatisfied(currentConfig, pending.permissionRequest)) {
    const obsolete = await resolvePendingA2AApproval({
      approvalId: params.approvalId,
      decision: "obsolete",
      actorId: params.actorId,
      reason: "config already satisfies this request",
      nowMs,
      baseDir: params.baseDir,
    });
    if (obsolete.status === "not-found") {
      return { status: "not-found" };
    }
    return obsolete.status === "resolved"
      ? { status: "obsolete", record: obsolete.record }
      : mapTerminalRecord(obsolete.record);
  }

  const patch = applyPendingApprovalPatch(currentConfig, pending.permissionRequest);
  if (patch.changedPaths.length === 0) {
    const obsolete = await resolvePendingA2AApproval({
      approvalId: params.approvalId,
      decision: "obsolete",
      actorId: params.actorId,
      reason: "no narrow config change remained to apply",
      nowMs,
      baseDir: params.baseDir,
    });
    if (obsolete.status === "not-found") {
      return { status: "not-found" };
    }
    return obsolete.status === "resolved"
      ? { status: "obsolete", record: obsolete.record }
      : mapTerminalRecord(obsolete.record);
  }

  try {
    await writeConfigFile(patch.nextConfig, writeOptions);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      error: `Could not write config for this approval: ${detail}`,
    };
  }

  const approved = await resolvePendingA2AApproval({
    approvalId: params.approvalId,
    decision: "approve",
    actorId: params.actorId,
    nowMs,
    baseDir: params.baseDir,
  });
  if (approved.status === "not-found") {
    return { status: "not-found" };
  }
  if (approved.status === "resolved") {
    return {
      status: "approved",
      record: approved.record,
      changedPaths: patch.changedPaths,
    };
  }
  return mapTerminalRecord(approved.record);
}

export function buildA2APermissionApprovalResolvedText(
  result: ResolvePendingA2APermissionApprovalResult,
): string {
  if (result.status === "approved") {
    const changedPaths = result.changedPaths.map((path) => `\`${path}\``).join(", ");
    return `Permission approved for ${formatAgentPair(result.record)}. Updated ${changedPaths}. Retry the request.`;
  }
  if (result.status === "denied") {
    return `Permission denied for ${formatAgentPair(result.record)}. No config changes were made.`;
  }
  if (result.status === "expired") {
    return `This approval request for ${formatAgentPair(result.record)} expired. Ask the agent to retry.`;
  }
  if (result.status === "obsolete") {
    return `This approval request for ${formatAgentPair(result.record)} is obsolete. The required config is already in place. Retry the request if needed.`;
  }
  if (result.status === "already-resolved") {
    if (result.record.state === "approved") {
      return `This approval request for ${formatAgentPair(result.record)} was already approved. Retry the request if needed.`;
    }
    if (result.record.state === "denied") {
      return `This approval request for ${formatAgentPair(result.record)} was already denied.`;
    }
    if (result.record.state === "obsolete") {
      return `This approval request for ${formatAgentPair(result.record)} is already obsolete. Retry the request if needed.`;
    }
    return `This approval request for ${formatAgentPair(result.record)} already expired. Ask the agent to retry.`;
  }
  if (result.status === "error") {
    return result.error;
  }
  return "This approval request is no longer available. Ask the agent to retry.";
}
