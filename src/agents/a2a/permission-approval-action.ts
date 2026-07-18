import type { OpenClawConfig } from "../../config/config.js";
import { transformConfigFileWithRetry } from "../../config/mutate.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityRowChecker,
  resolveEffectiveSessionToolsVisibility,
  type SessionAccessPermissionRequest,
  type SessionAccessResult,
} from "../tools/sessions-access.js";
import type { A2APermissionApprovalDecision } from "./permission-approval-reply.js";
import {
  authorizePendingA2AApprovalClaim,
  claimPendingA2AApproval,
  finishPendingA2AApprovalClaim,
  releasePendingA2AApprovalClaim,
  resolvePendingA2AApproval,
  type PendingA2AApprovalCommitAuthorization,
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

function checkPermissionRequestAccess(
  cfg: OpenClawConfig,
  request: SessionAccessPermissionRequest,
): SessionAccessResult {
  const requesterSessionKey =
    request.requesterSessionKey ?? `agent:${request.requesterAgentId}:main`;
  const targetSessionKey = request.targetSessionKey ?? `agent:${request.targetAgentId}:main`;
  return createSessionVisibilityRowChecker({
    action: request.action,
    requesterAgentId: request.requesterAgentId,
    requesterSessionKey,
    visibility: resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: false }),
    a2aPolicy: createAgentToAgentPolicy(cfg),
  }).check({
    key: targetSessionKey,
    agentId: request.targetAgentId,
  });
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

function permissionRequestGapMatches(
  current: SessionAccessPermissionRequest,
  pending: SessionAccessPermissionRequest,
): boolean {
  return (
    current.reason === pending.reason &&
    JSON.stringify(current.missingAllowAgents ?? []) ===
      JSON.stringify(pending.missingAllowAgents ?? [])
  );
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
      ? tools.agentToAgent.allow.map((entry) => entry)
      : [];
    const missingAllowAgents = dedupeTrimmedStrings(request.missingAllowAgents ?? []);
    const nextAllow = dedupeTrimmedStrings([...currentAllow, ...missingAllowAgents]);
    if (
      nextAllow.length === currentAllow.length &&
      nextAllow.every((entry, index) => entry === currentAllow[index])
    ) {
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

function mapTerminalRecord(record: PendingA2AApproval): ResolvePendingA2APermissionApprovalResult {
  if (record.state === "expired") {
    return { status: "expired", record };
  }
  return { status: "already-resolved", record };
}

class ObsoleteApprovalMutationError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ObsoleteApprovalMutationError";
  }
}

class ApprovalCommitAuthorizationError extends Error {
  constructor(readonly result: ResolvePendingA2APermissionApprovalResult) {
    super("A2A approval commit authorization is no longer valid");
    this.name = "ApprovalCommitAuthorizationError";
  }
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

  const claimed = await claimPendingA2AApproval({
    approvalId: params.approvalId,
    actorId: params.actorId,
    nowMs,
    baseDir: params.baseDir,
  });
  if (claimed.status === "not-found") {
    return { status: "not-found" };
  }
  if (claimed.status !== "claimed") {
    return mapTerminalRecord(claimed.record);
  }
  const pending = claimed.record;
  const releaseClaim = async () => {
    await releasePendingA2AApprovalClaim({
      approvalId: params.approvalId,
      claimId: claimed.claimId,
      baseDir: params.baseDir,
    });
  };

  let changedPaths: ChangedPath[];
  let commitAuthorization: PendingA2AApprovalCommitAuthorization | undefined;
  try {
    const mutation = await transformConfigFileWithRetry<{ changedPaths: ChangedPath[] }>({
      transform: (currentConfig, context) => {
        if (!context.snapshot.valid) {
          const firstIssue = context.snapshot.issues[0]?.message?.trim();
          throw new Error(
            firstIssue
              ? `Config is invalid. Fix it before approving this request: ${firstIssue}`
              : "Config is invalid. Fix it before approving this request.",
          );
        }
        const currentAccess = checkPermissionRequestAccess(
          currentConfig,
          pending.permissionRequest,
        );
        if (currentAccess.allowed) {
          throw new ObsoleteApprovalMutationError("config already satisfies this request");
        }
        if (
          !currentAccess.permissionRequest ||
          !permissionRequestGapMatches(currentAccess.permissionRequest, pending.permissionRequest)
        ) {
          throw new ObsoleteApprovalMutationError(
            "access requirements changed; request a fresh approval",
          );
        }

        const patch = applyPendingApprovalPatch(currentConfig, pending.permissionRequest);
        if (patch.changedPaths.length === 0) {
          throw new ObsoleteApprovalMutationError("no narrow config change remained to apply");
        }
        // An approval owns exactly one config gate. Applying it may expose the
        // next independent gate; that follow-up must receive its own approval.
        return {
          nextConfig: patch.nextConfig,
          result: { changedPaths: patch.changedPaths },
        };
      },
      writeOptions: {
        // The mutation lock preserves concurrent config edits. Reauthorize at its final async
        // commit gate so expiry or another actor cannot revoke this privileged write mid-plan.
        preCommitRuntimePreflight: async () => {
          const authorized = await authorizePendingA2AApprovalClaim({
            approvalId: params.approvalId,
            claimId: claimed.claimId,
            nowMs: Date.now(),
            baseDir: params.baseDir,
          });
          if (authorized.status === "not-found") {
            throw new ApprovalCommitAuthorizationError({ status: "not-found" });
          }
          if (authorized.status !== "authorized") {
            throw new ApprovalCommitAuthorizationError(mapTerminalRecord(authorized.record));
          }
          commitAuthorization = authorized.commitAuthorization;
        },
      },
    });
    changedPaths = mutation.result?.changedPaths ?? [];
  } catch (error) {
    if (error instanceof ObsoleteApprovalMutationError) {
      const obsolete = await finishPendingA2AApprovalClaim({
        approvalId: params.approvalId,
        claimId: claimed.claimId,
        decision: "obsolete",
        actorId: params.actorId,
        reason: error.reason,
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
    if (error instanceof ApprovalCommitAuthorizationError) {
      return error.result;
    }
    await releaseClaim();
    const detail = error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      error: `Could not write config for this approval: ${detail}`,
    };
  }

  const approved = await finishPendingA2AApprovalClaim({
    approvalId: params.approvalId,
    claimId: claimed.claimId,
    decision: "approve",
    commitAuthorization,
    actorId: params.actorId,
    nowMs: Date.now(),
    baseDir: params.baseDir,
  });
  if (approved.status === "not-found") {
    return { status: "not-found" };
  }
  if (approved.status === "authorization-required") {
    await releaseClaim();
    return {
      status: "error",
      error:
        "Could not finalize this approval because its commit authorization expired. Retry the approval.",
    };
  }
  if (approved.status === "resolved") {
    return {
      status: "approved",
      record: approved.record,
      changedPaths,
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
    if (result.record.obsoleteReason?.includes("request a fresh approval")) {
      return `This approval request for ${formatAgentPair(result.record)} is obsolete because access requirements changed. Ask the agent to retry and request a fresh approval.`;
    }
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
      if (result.record.obsoleteReason?.includes("request a fresh approval")) {
        return `This approval request for ${formatAgentPair(result.record)} is already obsolete because access requirements changed. Ask the agent to retry and request a fresh approval.`;
      }
      return `This approval request for ${formatAgentPair(result.record)} is already obsolete. Retry the request if needed.`;
    }
    if (result.record.state === "applying") {
      return `This approval request for ${formatAgentPair(result.record)} is already being applied.`;
    }
    return `This approval request for ${formatAgentPair(result.record)} already expired. Ask the agent to retry.`;
  }
  if (result.status === "error") {
    return result.error;
  }
  return "This approval request is no longer available. Ask the agent to retry.";
}
