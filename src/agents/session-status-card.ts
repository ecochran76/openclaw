import { buildStatusText } from "../auto-reply/reply/commands-status.js";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionModelIdentityRef } from "../gateway/session-utils.js";
import { buildTaskStatusSnapshotForRelatedSessionKeyForOwner } from "../tasks/task-owner-access.js";
import { formatTaskStatusDetail, formatTaskStatusTitle } from "../tasks/task-status.js";
import { resolveAgentDir } from "./agent-scope.js";
import { resolveModelAuthLabel } from "./model-auth-label.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";

function formatSessionTaskLine(params: {
  relatedSessionKey: string;
  callerOwnerKey: string;
}): string | undefined {
  const snapshot = buildTaskStatusSnapshotForRelatedSessionKeyForOwner({
    relatedSessionKey: params.relatedSessionKey,
    callerOwnerKey: params.callerOwnerKey,
  });
  const task = snapshot.focus;
  if (!task) {
    return undefined;
  }
  const headline =
    snapshot.activeCount > 0
      ? `${snapshot.activeCount} active`
      : snapshot.recentFailureCount > 0
        ? `${snapshot.recentFailureCount} recent failure${snapshot.recentFailureCount === 1 ? "" : "s"}`
        : `latest ${task.status.replaceAll("_", " ")}`;
  const title = formatTaskStatusTitle(task);
  const detail = formatTaskStatusDetail(task);
  const parts = [headline, task.runtime, title, detail].filter(Boolean);
  return parts.length ? `📌 Tasks: ${parts.join(" · ")}` : undefined;
}

export async function buildSessionStatusCard(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionEntry: SessionEntry;
  storePath: string;
  callerOwnerKey: string;
}) {
  const configured = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const agentDir = resolveAgentDir(params.cfg, params.agentId);
  const runtimeModelIdentity = resolveSessionModelIdentityRef(
    params.cfg,
    params.sessionEntry,
    params.agentId,
    `${configured.provider}/${configured.model}`,
  );
  const hasExplicitModelOverride = Boolean(
    params.sessionEntry.providerOverride?.trim() || params.sessionEntry.modelOverride?.trim(),
  );
  const runtimeProviderForCard = runtimeModelIdentity.provider?.trim();
  const runtimeModelForCard = runtimeModelIdentity.model.trim();
  const defaultProviderForCard = hasExplicitModelOverride
    ? configured.provider
    : (runtimeProviderForCard ?? "");
  const defaultModelForCard = hasExplicitModelOverride
    ? configured.model
    : runtimeModelForCard || configured.model;
  const primaryModelLabel = defaultProviderForCard
    ? `${defaultProviderForCard}/${defaultModelForCard}`
    : defaultModelForCard;
  const statusSessionEntry =
    !hasExplicitModelOverride && !runtimeProviderForCard && runtimeModelForCard
      ? { ...params.sessionEntry, providerOverride: "" }
      : params.sessionEntry;
  const providerOverrideForCard = statusSessionEntry.providerOverride?.trim();
  const providerForCard = providerOverrideForCard ?? defaultProviderForCard;
  const modelAuthLabel =
    resolveModelAuthLabel({
      provider: providerForCard,
      cfg: params.cfg,
      sessionEntry: statusSessionEntry,
      agentDir,
    }) ?? undefined;
  const isGroup =
    statusSessionEntry.chatType === "group" ||
    statusSessionEntry.chatType === "channel" ||
    params.sessionKey.includes(":group:") ||
    params.sessionKey.includes(":channel:");
  const taskLine = formatSessionTaskLine({
    relatedSessionKey: params.sessionKey,
    callerOwnerKey: params.callerOwnerKey,
  });
  const statusText = await buildStatusText({
    cfg: params.cfg,
    sessionEntry: statusSessionEntry,
    sessionKey: params.sessionKey,
    parentSessionKey: statusSessionEntry.parentSessionKey,
    sessionScope: params.cfg.session?.scope,
    storePath: params.storePath,
    statusChannel:
      statusSessionEntry.channel ??
      statusSessionEntry.lastChannel ??
      statusSessionEntry.origin?.provider ??
      "unknown",
    provider: providerForCard,
    model: defaultModelForCard,
    resolvedThinkLevel: statusSessionEntry.thinkingLevel as ThinkLevel | undefined,
    resolvedFastMode: statusSessionEntry.fastMode,
    resolvedVerboseLevel: (statusSessionEntry.verboseLevel ?? "off") as VerboseLevel,
    resolvedReasoningLevel: (statusSessionEntry.reasoningLevel ?? "off") as ReasoningLevel,
    resolvedElevatedLevel: statusSessionEntry.elevatedLevel as ElevatedLevel | undefined,
    resolveDefaultThinkingLevel: async () => params.cfg.agents?.defaults?.thinkingDefault,
    isGroup,
    defaultGroupActivation: () => "mention",
    taskLineOverride: taskLine,
    skipDefaultTaskLookup: true,
    primaryModelLabelOverride: primaryModelLabel,
    modelAuthOverride: providerForCard ? modelAuthLabel : undefined,
    activeModelAuthOverride: modelAuthLabel,
  });
  return {
    statusText:
      taskLine && !statusText.includes(taskLine) ? `${statusText}\n${taskLine}` : statusText,
  };
}
