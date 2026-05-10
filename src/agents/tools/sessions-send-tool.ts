/**
 * sessions_send built-in tool.
 *
 * Sends messages to visible sessions, starts embedded runs, and optionally announces replies.
 */
import crypto from "node:crypto";
import { isRequesterParentOfBackgroundAcpSession } from "@openclaw/acp-core/session-interaction-mode";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { parseSessionThreadInfoFast } from "../../config/sessions/thread-info.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import {
  annotateInterSessionPromptText,
  hasInterSessionUserProvenance,
} from "../../sessions/input-provenance.js";
import { isCronRunSessionKey, parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { SESSION_LABEL_MAX_LENGTH } from "../../sessions/session-label.js";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import {
  type GatewayMessageChannel,
  INTERNAL_MESSAGE_CHANNEL,
} from "../../utils/message-channel.js";
import { attemptIngressEcho } from "../a2a/ingress-echo.js";
import { listAgentIds } from "../agent-scope.js";
import {
  type EmbeddedAgentQueueMessageOptions,
  type EmbeddedAgentQueueMessageOutcome,
  formatEmbeddedAgentQueueFailureSummary,
  queueEmbeddedAgentMessageWithOutcomeAsync,
  resolveActiveEmbeddedRunSessionId,
} from "../embedded-agent-runner/runs.js";
import { resolveNestedAgentLaneForSession } from "../lanes.js";
import {
  type AgentWaitResult,
  readLatestAssistantReplySnapshot,
  waitForAgentRunAndReadUpdatedAssistantReply,
} from "../run-wait.js";
import { loadSessionEntryByKey } from "../subagent-announce-delivery.js";
import {
  describeSessionsSendTool,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
} from "../tool-description-presets.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNumberParam,
  readNonNegativeIntegerParam,
  readStringArrayParam,
  readStringOrNumberParam,
  readStringParam,
} from "./common.js";
import { resolveAnnounceTarget } from "./sessions-announce-target.js";
import {
  createSessionVisibilityGuard,
  createAgentToAgentPolicy,
  resolveEffectiveSessionToolsVisibility,
  resolveSessionReference,
  resolveSessionToolContext,
  resolveVisibleSessionReference,
} from "./sessions-helpers.js";
import { prepareSessionsSendA2AFlow } from "./sessions-send-a2a-prepare.js";
import {
  buildAgentToAgentMessageContext,
  clampA2ATimeoutSeconds,
  clampPingPongTurns,
  resolveIngressEchoPolicy,
  resolvePingPongTurns,
  resolveRelayPolicy,
} from "./sessions-send-helpers.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

function parseNaturalSessionSelector(value?: string): {
  agentId?: string;
  search?: string;
  searchFields?: string[];
  selection?: "most-recent" | "least-recent";
  threadPolicy?: "prefer-thread";
} | null {
  const raw = value?.trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();

  const managedByMatch = normalized.match(/\bmanaged by\s+([a-z0-9][a-z0-9_-]*)\b/i);
  const selection = lower.includes("most recent")
    ? "most-recent"
    : lower.includes("least recent")
      ? "least-recent"
      : undefined;

  let search = normalized;
  if (managedByMatch) {
    search = search.replace(managedByMatch[0], " ").replace(/\s+/g, " ").trim();
  }
  search = search
    .replace(/^the\s+/i, "")
    .replace(/^(most|least)\s+recent\s+/i, "")
    .replace(/\bsession\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const wantsDerivedTitle = /\ba2a\b|\bfeature\b|\bdev\b/i.test(search);
  const shouldTreatAsNaturalSelector =
    Boolean(managedByMatch) || Boolean(selection) || /\bmanaged by\b/i.test(lower);
  if (!shouldTreatAsNaturalSelector || !search) {
    return null;
  }

  return {
    agentId: managedByMatch?.[1] ? normalizeAgentId(managedByMatch[1]) : undefined,
    search,
    searchFields: wantsDerivedTitle ? ["derivedTitle"] : undefined,
    selection,
    threadPolicy: "prefer-thread",
  };
}

const SessionsSendToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: SESSION_LABEL_MAX_LENGTH })),
  agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  channel: Type.Optional(Type.String({ minLength: 1 })),
  to: Type.Optional(Type.String({ minLength: 1 })),
  accountId: Type.Optional(Type.String({ minLength: 1 })),
  threadId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Number()])),
  threadPolicy: Type.Optional(
    Type.Union([
      Type.Literal("exact"),
      Type.Literal("prefer-thread"),
      Type.Literal("most-recent"),
      Type.Literal("channel-root"),
    ]),
  ),
  allowChannelRootFallback: Type.Optional(Type.Boolean()),
  activeMinutes: Type.Optional(Type.Number({ minimum: 1 })),
  search: Type.Optional(Type.String()),
  searchFields: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  selection: Type.Optional(Type.Union([Type.Literal("most-recent"), Type.Literal("least-recent")])),
  message: Type.String(),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
  maxPingPongTurns: Type.Optional(Type.Number({ minimum: 0, maximum: 5 })),
  a2aTimeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 300 })),
});

type GatewayCaller = typeof callGateway;
const SESSIONS_SEND_REPLY_HISTORY_LIMIT = 50;
const SESSIONS_SEND_MESSAGE_ALIASES = ["SendMessage", "content", "text"] as const;

function normalizeSessionsSendArguments(args: unknown): Record<string, unknown> {
  const params =
    args && typeof args === "object" && !Array.isArray(args)
      ? { ...(args as Record<string, unknown>) }
      : {};

  if (typeof params.message !== "string" || !params.message.trim()) {
    for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
      const value = readStringParam(params, alias);
      if (value) {
        params.message = stripFormattedReasoningMessage(value);
        break;
      }
    }
  }

  for (const alias of SESSIONS_SEND_MESSAGE_ALIASES) {
    delete params[alias];
  }
  return params;
}

function resolveConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mainKey: string;
}): string | undefined {
  const agentId = normalizeAgentId(params.agentId);
  if (!listAgentIds(params.cfg).includes(agentId)) {
    return undefined;
  }
  return toAgentStoreSessionKey({
    agentId,
    requestKey: "main",
    mainKey: params.mainKey,
  });
}

function isConfiguredAgentMainSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  mainKey: string;
}): boolean {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  return (
    params.sessionKey ===
    resolveConfiguredAgentMainSessionKey({
      cfg: params.cfg,
      agentId,
      mainKey: params.mainKey,
    })
  );
}

async function ensureConfiguredAgentMainSession(params: {
  cfg: OpenClawConfig;
  callGateway: GatewayCaller;
  sessionKey: string;
  mainKey: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (
    !isConfiguredAgentMainSessionKey({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      mainKey: params.mainKey,
    })
  ) {
    return { ok: true };
  }

  try {
    await params.callGateway({
      method: "sessions.resolve",
      params: { key: params.sessionKey },
      timeoutMs: 10_000,
    });
    return { ok: true };
  } catch {
    try {
      await params.callGateway({
        method: "sessions.create",
        params: {
          key: params.sessionKey,
          agentId: resolveAgentIdFromSessionKey(params.sessionKey),
        },
        timeoutMs: 10_000,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatErrorMessage(err) };
    }
  }
}

type SessionsSendRouteEntry = Pick<SessionEntry, "acp" | "parentSessionKey" | "spawnedBy">;

function isRequesterParentOfNativeSubagentSession(params: {
  entry: SessionsSendRouteEntry | null | undefined;
  acpMeta?: unknown;
  requesterSessionKey: string | null | undefined;
  targetSessionKey: string;
}): boolean {
  if (
    !params.entry ||
    params.acpMeta ||
    params.entry.acp ||
    !isSubagentSessionKey(params.targetSessionKey)
  ) {
    return false;
  }
  const requester = normalizeOptionalString(params.requesterSessionKey);
  if (!requester) {
    return false;
  }
  const spawnedBy = normalizeOptionalString(params.entry.spawnedBy);
  const parentSessionKey = normalizeOptionalString(params.entry.parentSessionKey);
  return requester === spawnedBy || requester === parentSessionKey;
}

function isTerminalAgentWaitTimeout(result: AgentWaitResult): boolean {
  return result.endedAt !== undefined || Boolean(result.stopReason || result.livenessState);
}

function isPendingErrorAgentWaitTimeout(result: AgentWaitResult): boolean {
  return (
    result.pendingError === true && typeof result.error === "string" && result.error.trim() !== ""
  );
}

function isRunScopedAgentSessionKey(sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(normalizeOptionalString(sessionKey));
  return Boolean(parsed && /(?:^|:)run:[^:]+(?::|$)/.test(parsed.rest));
}

function resolveCronRunScopedFallbackSessionKey(sessionKey: string): string | undefined {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey || !isCronRunSessionKey(normalizedSessionKey)) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(normalizedSessionKey);
  if (!parsed) {
    return undefined;
  }
  const runMarker = ":run:";
  const runMarkerIndex = parsed.rest.lastIndexOf(runMarker);
  if (runMarkerIndex <= 0) {
    return undefined;
  }
  const runId = parsed.rest.slice(runMarkerIndex + runMarker.length);
  if (!runId || runId.includes(":")) {
    return undefined;
  }
  const fallbackRest = parsed.rest.slice(0, runMarkerIndex);
  if (!fallbackRest) {
    return undefined;
  }
  return `agent:${parsed.agentId}:${fallbackRest}`;
}

function shouldFallbackCronRunScopedActiveDelivery(
  outcome: EmbeddedAgentQueueMessageOutcome,
): boolean {
  return (
    !outcome.queued && (outcome.reason === "not_streaming" || outcome.reason === "no_active_run")
  );
}

async function startAgentRun(params: {
  callGateway: GatewayCaller;
  extraResult?: Record<string, unknown>;
  runId: string;
  sendParams: Record<string, unknown>;
  sessionKey: string;
  deliveryTimeoutMs?: number;
  allowActiveRunQueueDelivery?: boolean;
}): Promise<
  | {
      ok: true;
      runId: string;
      activeRunQueue?: boolean;
      a2aSessionKey?: string;
      a2aDisplayKey?: string;
    }
  | { ok: false; result: ReturnType<typeof jsonResult> }
> {
  try {
    const activeRunSessionId =
      params.allowActiveRunQueueDelivery && isRunScopedAgentSessionKey(params.sessionKey)
        ? resolveActiveEmbeddedRunSessionId(params.sessionKey)
        : undefined;
    const messageText =
      typeof params.sendParams.message === "string" ? params.sendParams.message : undefined;
    if (activeRunSessionId && messageText) {
      const sourceReplyDeliveryMode =
        params.sendParams.sourceReplyDeliveryMode === "automatic" ||
        params.sendParams.sourceReplyDeliveryMode === "message_tool_only"
          ? params.sendParams.sourceReplyDeliveryMode
          : undefined;
      const queueOptions: EmbeddedAgentQueueMessageOptions = {
        steeringMode: "all",
        debounceMs: 0,
        deliveryTimeoutMs: params.deliveryTimeoutMs,
        waitForTranscriptCommit: true,
        ...(sourceReplyDeliveryMode ? { sourceReplyDeliveryMode } : {}),
      };
      let queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
        activeRunSessionId,
        messageText,
        queueOptions,
      );
      if (!queueOutcome.queued && queueOutcome.reason === "transcript_commit_wait_unsupported") {
        const bestEffortQueueOptions = { ...queueOptions };
        delete bestEffortQueueOptions.waitForTranscriptCommit;
        queueOutcome = await queueEmbeddedAgentMessageWithOutcomeAsync(
          activeRunSessionId,
          messageText,
          bestEffortQueueOptions,
        );
      }
      if (queueOutcome.queued) {
        return { ok: true, runId: params.runId, activeRunQueue: true };
      }
      const fallbackSessionKey = resolveCronRunScopedFallbackSessionKey(params.sessionKey);
      if (fallbackSessionKey && shouldFallbackCronRunScopedActiveDelivery(queueOutcome)) {
        const response = await params.callGateway<{ runId: string }>({
          method: "agent",
          params: {
            ...params.sendParams,
            sessionKey: fallbackSessionKey,
            idempotencyKey: crypto.randomUUID(),
          },
          timeoutMs: 10_000,
        });
        return {
          ok: true,
          runId:
            typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
          a2aSessionKey: fallbackSessionKey,
          a2aDisplayKey: fallbackSessionKey,
        };
      }
      const queueSummary =
        formatEmbeddedAgentQueueFailureSummary(queueOutcome) ?? "active run queue rejected";
      throw new Error(queueSummary);
    }
    const response = await params.callGateway<{ runId: string }>({
      method: "agent",
      params: params.sendParams,
      timeoutMs: 10_000,
    });
    return {
      ok: true,
      runId: typeof response?.runId === "string" && response.runId ? response.runId : params.runId,
    };
  } catch (err) {
    const messageText =
      err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return {
      ok: false,
      result: jsonResult({
        runId: params.runId,
        status: "error",
        error: messageText,
        sessionKey: params.sessionKey,
        ...params.extraResult,
      }),
    };
  }
}

export function createSessionsSendTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  callGateway?: GatewayCaller;
}): AnyAgentTool {
  return {
    label: "Session Send",
    name: "sessions_send",
    displaySummary: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    description: describeSessionsSendTool(),
    parameters: SessionsSendToolSchema,
    prepareArguments: normalizeSessionsSendArguments,
    execute: async (_toolCallId, args) => {
      const params = normalizeSessionsSendArguments(args);
      const gatewayCall = opts?.callGateway ?? callGateway;
      const message = readStringParam(params, "message", { required: true });
      const { cfg, mainKey, alias, effectiveRequesterKey, restrictToSpawned } =
        resolveSessionToolContext(opts);

      const a2aPolicy = createAgentToAgentPolicy(cfg);
      const sessionVisibility = resolveEffectiveSessionToolsVisibility({
        cfg,
        sandboxed: opts?.sandboxed === true,
      });

      const sessionKeyParam = readStringParam(params, "sessionKey");
      const naturalSessionSelector = parseNaturalSessionSelector(sessionKeyParam);
      const labelParam = readStringParam(params, "label")?.trim() || undefined;
      const requestedAgentIdParam = readStringParam(params, "agentId")?.trim() || undefined;
      const selectorChannelParam = readStringParam(params, "channel")?.trim() || undefined;
      const selectorToParam = readStringParam(params, "to")?.trim() || undefined;
      const selectorAccountIdParam = readStringParam(params, "accountId")?.trim() || undefined;
      const selectorThreadIdParam = readStringOrNumberParam(params, "threadId");
      const selectorThreadPolicyParam =
        readStringParam(params, "threadPolicy")?.trim() || undefined;
      const selectorSearchParam = readStringParam(params, "search")?.trim() || undefined;
      const selectorSearchFieldsParam = readStringArrayParam(params, "searchFields")
        ?.map((value) => value.trim())
        .filter(Boolean);
      const selectorSelectionParam = readStringParam(params, "selection")?.trim() || undefined;
      const selectorActiveMinutesParam = readNumberParam(params, "activeMinutes", {
        integer: true,
      });
      const selectorAllowChannelRootFallback =
        typeof params.allowChannelRootFallback === "boolean"
          ? params.allowChannelRootFallback
          : undefined;
      const hasSelectorParams = Boolean(
        selectorChannelParam ||
        selectorToParam ||
        selectorAccountIdParam ||
        selectorThreadIdParam ||
        selectorThreadPolicyParam ||
        selectorSearchParam ||
        (selectorSearchFieldsParam?.length ?? 0) > 0 ||
        selectorSelectionParam ||
        selectorActiveMinutesParam !== undefined ||
        selectorAllowChannelRootFallback === true,
      );
      const hasNaturalSelector = Boolean(
        naturalSessionSelector && !hasSelectorParams && !labelParam,
      );
      const hasAgentIdOnlySelector = Boolean(
        requestedAgentIdParam &&
        !sessionKeyParam &&
        !labelParam &&
        !hasSelectorParams &&
        !hasNaturalSelector,
      );
      const hasSelectorTarget = hasSelectorParams || hasNaturalSelector || hasAgentIdOnlySelector;
      const targetModeCount = [
        Boolean(sessionKeyParam && !hasNaturalSelector),
        Boolean(labelParam),
        hasSelectorTarget,
      ].filter(Boolean).length;
      if (targetModeCount > 1) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Provide either sessionKey, label, or selector fields (not multiple).",
        });
      }

      const requesterResolutionAgentId = resolveAgentIdFromSessionKey(effectiveRequesterKey);
      const requestedAgentId = requestedAgentIdParam
        ? normalizeAgentId(requestedAgentIdParam)
        : undefined;
      const effectiveRequestedAgentId = requestedAgentId ?? naturalSessionSelector?.agentId;
      if ((labelParam || hasSelectorTarget) && restrictToSpawned && effectiveRequestedAgentId) {
        if (effectiveRequestedAgentId !== requesterResolutionAgentId) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "forbidden",
            error: "Sandboxed sessions_send target resolution is limited to this agent",
          });
        }
      }
      if (
        (labelParam || hasSelectorTarget) &&
        requesterResolutionAgentId &&
        effectiveRequestedAgentId
      ) {
        if (effectiveRequestedAgentId !== requesterResolutionAgentId) {
          if (!a2aPolicy.enabled) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
            });
          }
          if (!a2aPolicy.isAllowed(requesterResolutionAgentId, effectiveRequestedAgentId)) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Agent-to-agent messaging denied by tools.agentToAgent.allow.",
            });
          }
        }
      }

      const effectiveSelectorSearch = selectorSearchParam ?? naturalSessionSelector?.search;
      const effectiveSelectorSearchFields = selectorSearchFieldsParam?.length
        ? selectorSearchFieldsParam
        : naturalSessionSelector?.searchFields;
      const effectiveSelectorSelection =
        selectorSelectionParam ?? naturalSessionSelector?.selection;
      const effectiveSelectorThreadPolicy =
        selectorThreadPolicyParam ?? naturalSessionSelector?.threadPolicy;

      let sessionKey = hasNaturalSelector ? undefined : sessionKeyParam;
      let resolvedTarget:
        | {
            sessionKey: string;
            agentId?: string;
            deliveryContext?: {
              channel?: string;
              to?: string;
              accountId?: string;
              threadId?: string;
            };
            resolution?: {
              matchedBy?: string;
              threadPolicy?: string;
              selection?: string;
              fallbackUsed?: boolean;
              search?: string;
              searchFields?: string[];
            };
          }
        | undefined;
      if (!sessionKey && (labelParam || hasSelectorTarget)) {
        const resolveParams: Record<string, unknown> = {
          ...(labelParam ? { label: labelParam } : {}),
          ...(effectiveRequestedAgentId ? { agentId: effectiveRequestedAgentId } : {}),
          ...(selectorChannelParam ? { channel: selectorChannelParam } : {}),
          ...(selectorToParam ? { to: selectorToParam } : {}),
          ...(selectorAccountIdParam ? { accountId: selectorAccountIdParam } : {}),
          ...(selectorThreadIdParam ? { threadId: selectorThreadIdParam } : {}),
          ...(effectiveSelectorThreadPolicy ? { threadPolicy: effectiveSelectorThreadPolicy } : {}),
          ...(effectiveSelectorSearch ? { search: effectiveSelectorSearch } : {}),
          ...(effectiveSelectorSearchFields?.length
            ? { searchFields: effectiveSelectorSearchFields }
            : {}),
          ...(effectiveSelectorSelection ? { selection: effectiveSelectorSelection } : {}),
          ...(selectorActiveMinutesParam !== undefined
            ? { activeMinutes: selectorActiveMinutesParam }
            : {}),
          ...(selectorAllowChannelRootFallback === true ? { allowChannelRootFallback: true } : {}),
          ...(restrictToSpawned ? { spawnedBy: effectiveRequesterKey } : {}),
        };
        let resolvedKey;
        try {
          const resolved = (await gatewayCall({
            method: "sessions.resolve",
            params: resolveParams,
            timeoutMs: 10_000,
          })) as {
            key?: string;
            agentId?: string;
            deliveryContext?: {
              channel?: string;
              to?: string;
              accountId?: string;
              threadId?: string;
            };
            resolution?: {
              matchedBy?: string;
              threadPolicy?: string;
              selection?: string;
              fallbackUsed?: boolean;
              search?: string;
              searchFields?: string[];
            };
          };
          resolvedKey = typeof resolved?.key === "string" ? resolved.key.trim() : "";
          if (resolvedKey) {
            resolvedTarget = {
              sessionKey: resolvedKey,
              agentId: typeof resolved?.agentId === "string" ? resolved.agentId : undefined,
              deliveryContext:
                resolved?.deliveryContext && typeof resolved.deliveryContext === "object"
                  ? resolved.deliveryContext
                  : undefined,
              resolution:
                resolved?.resolution && typeof resolved.resolution === "object"
                  ? resolved.resolution
                  : undefined,
            };
          }
        } catch (err) {
          const msg = formatErrorMessage(err);
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error:
              msg ||
              (labelParam
                ? `No session found with label: ${labelParam}`
                : "No session matched selector filters."),
          });
        }

        if (!resolvedKey) {
          if (restrictToSpawned) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error: "Session not visible from this sandboxed agent session.",
            });
          }
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: labelParam
              ? `No session found with label: ${labelParam}`
              : "No session matched selector filters.",
          });
        }
        sessionKey = resolvedKey;
      }

      if (!sessionKey) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error: "Either sessionKey, label, or selector fields are required",
        });
      }
      const resolvedSession = await resolveSessionReference({
        sessionKey,
        alias,
        mainKey,
        requesterInternalKey: effectiveRequesterKey,
        restrictToSpawned,
      });
      if (!resolvedSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: resolvedSession.status,
          error: resolvedSession.error,
        });
      }
      const visibleSession = await resolveVisibleSessionReference({
        resolvedSession,
        requesterSessionKey: effectiveRequesterKey,
        restrictToSpawned,
        visibilitySessionKey: sessionKey,
      });
      const unresolvedDisplayKey = sessionKey;
      if (!visibleSession.ok) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: visibleSession.status,
          error: visibleSession.error,
          sessionKey: unresolvedDisplayKey,
        });
      }
      // Normalize sessionKey/sessionId input into a canonical session key.
      let resolvedKey = visibleSession.key;
      const displayKey = visibleSession.displayKey;
      const resolvedTargetDisplay = resolvedTarget
        ? { ...resolvedTarget, sessionKey: displayKey }
        : undefined;
      const resolvedThreadInfo = parseSessionThreadInfoFast(resolvedKey);
      if (
        resolvedThreadInfo.threadId &&
        resolvedTarget?.deliveryContext &&
        resolvedThreadInfo.baseSessionKey
      ) {
        resolvedKey = resolvedThreadInfo.baseSessionKey;
      }
      const timeoutSeconds = readNonNegativeIntegerParam(params, "timeoutSeconds") ?? 30;
      const timeoutMs =
        finiteSecondsToTimerSafeMilliseconds(timeoutSeconds, {
          floorSeconds: true,
        }) ?? 0;
      const announceTimeoutMs = timeoutSeconds === 0 ? 30_000 : timeoutMs;
      const maxPingPongTurns = clampPingPongTurns(
        typeof params.maxPingPongTurns === "number" ? params.maxPingPongTurns : undefined,
        resolvePingPongTurns(cfg),
      );
      const a2aTimeoutMs =
        clampA2ATimeoutSeconds(
          typeof params.a2aTimeoutSeconds === "number" ? params.a2aTimeoutSeconds : undefined,
        ) * 1000;
      const a2aStepTimeoutMs =
        timeoutSeconds === 0 ? a2aTimeoutMs : Math.min(announceTimeoutMs, a2aTimeoutMs);
      const idempotencyKey = crypto.randomUUID();
      let runId: string = idempotencyKey;
      if (parseSessionThreadInfoFast(resolvedKey).threadId) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error:
            "sessions_send cannot target a thread session for inter-agent coordination. Use the parent channel session key instead.",
          sessionKey: unresolvedDisplayKey,
        });
      }
      const visibilityGuard = await createSessionVisibilityGuard({
        action: "send",
        requesterSessionKey: effectiveRequesterKey,
        visibility: sessionVisibility,
        a2aPolicy,
      });
      const access = visibilityGuard.check(resolvedKey);
      if (!access.allowed) {
        const accessDeniedDisplayKey = resolvedSession.resolvedViaSessionId
          ? unresolvedDisplayKey
          : displayKey;
        return jsonResult({
          runId: crypto.randomUUID(),
          status: access.status,
          error: access.error,
          sessionKey: accessDeniedDisplayKey,
          resolvedTarget: resolvedTargetDisplay,
        });
      }

      const requesterSessionKey = opts?.agentSessionKey;
      const requesterChannel = opts?.agentChannel;
      const sameSessionA2A = requesterSessionKey === resolvedKey;

      if (!sameSessionA2A) {
        const ensuredSession = await ensureConfiguredAgentMainSession({
          cfg,
          callGateway: gatewayCall,
          sessionKey: resolvedKey,
          mainKey,
        });
        if (!ensuredSession.ok) {
          return jsonResult({
            runId: crypto.randomUUID(),
            status: "error",
            error: ensuredSession.error,
            sessionKey: displayKey,
          });
        }
      }

      // Capture the pre-run assistant snapshot before starting the nested run.
      // Fast in-process test doubles and short-circuit agent paths can finish
      // before we reach the post-run read, which would otherwise make the new
      // reply look like the baseline and hide it from the caller.
      // Fire-and-forget same-session sends still need this baseline because the
      // A2A follow-up may deliver directly to the source channel.
      const baselineReply =
        timeoutSeconds !== 0
          ? await readLatestAssistantReplySnapshot({
              sessionKey: resolvedKey,
              limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
              callGateway: gatewayCall,
            })
          : sameSessionA2A
            ? await readLatestAssistantReplySnapshot({
                sessionKey: resolvedKey,
                limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
                callGateway: gatewayCall,
              }).catch(() => undefined)
            : undefined;
      const ingressEchoPolicy = resolveIngressEchoPolicy(cfg);
      const ingressEchoExecution = await attemptIngressEcho(
        {
          policy: ingressEchoPolicy,
          sessionKey: resolvedKey,
          displayKey,
          message,
          requesterSessionKey: opts?.agentSessionKey,
          requesterChannel: opts?.agentChannel,
        },
        {
          callGateway: gatewayCall,
          resolveAnnounceTarget,
        },
      );
      const ingressEcho: Record<string, unknown> = ingressEchoExecution.ingressEcho;
      if (ingressEchoExecution.requiredFailure) {
        return jsonResult({
          runId: crypto.randomUUID(),
          status: "error",
          error:
            typeof ingressEchoExecution.ingressEcho.error === "string"
              ? ingressEchoExecution.ingressEcho.error
              : "Ingress echo delivery failed.",
          sessionKey: displayKey,
          resolvedTarget: resolvedTargetDisplay,
          ingressEcho,
        });
      }

      const allowNestedSessionsSend =
        cfg.session?.agentToAgent?.guard?.allowNestedSessionsSend === true;
      if (!allowNestedSessionsSend && opts?.agentSessionKey) {
        try {
          const currentHistory = (await gatewayCall({
            method: "chat.history",
            params: { sessionKey: opts.agentSessionKey, limit: 20 },
            timeoutMs: 10_000,
          })) as { messages?: Array<Record<string, unknown>> };
          const messages = Array.isArray(currentHistory?.messages) ? currentHistory.messages : [];
          const latestUser = [...messages].toReversed().find((entry) => entry?.role === "user");
          const provenance = latestUser?.provenance as Record<string, unknown> | undefined;
          if (
            hasInterSessionUserProvenance(latestUser as { role?: unknown; provenance?: unknown }) &&
            provenance?.sourceTool === "sessions_send"
          ) {
            return jsonResult({
              runId: crypto.randomUUID(),
              status: "forbidden",
              error:
                "Nested sessions_send relay blocked by session.agentToAgent.guard.allowNestedSessionsSend=false.",
              sessionKey: displayKey,
              resolvedTarget: resolvedTargetDisplay,
              ingressEcho,
            });
          }
        } catch {
          // Best effort guard; if current session history is unavailable, preserve prior behavior.
        }
      }

      const agentMessageContext = buildAgentToAgentMessageContext({
        requesterSessionKey: opts?.agentSessionKey,
        requesterChannel: opts?.agentChannel,
        targetSessionKey: displayKey,
      });
      const inputProvenance = {
        kind: "inter_session" as const,
        sourceSessionKey: opts?.agentSessionKey,
        sourceChannel: opts?.agentChannel,
        sourceTool: "sessions_send",
      };
      const sendParams = {
        message: annotateInterSessionPromptText(message, inputProvenance),
        sessionKey: resolvedKey,
        idempotencyKey,
        deliver: false,
        sourceReplyDeliveryMode: "message_tool_only" as const,
        channel: INTERNAL_MESSAGE_CHANNEL,
        lane: resolveNestedAgentLaneForSession(resolvedKey),
        extraSystemPrompt: agentMessageContext,
        inputProvenance,
      };
      const relayPolicy = resolveRelayPolicy(cfg);
      const { flowParams, defaultRelay } = await prepareSessionsSendA2AFlow(
        {
          targetSessionKey: resolvedKey,
          displayKey,
          message,
          announceTimeoutMs: a2aStepTimeoutMs,
          maxPingPongTurns,
          timeoutSeconds,
          relayPolicy,
          requesterSessionKey,
          requesterChannel,
        },
        {
          callGateway: gatewayCall,
          resolveAnnounceTarget,
        },
      );
      // Skip the A2A ping-pong + announce flow when the current caller is the
      // parent of a parent-owned child session it spawned itself and another
      // parent-visible result path already exists.
      //
      // ACP background sessions report through the internal task completion
      // path. Waited native subagent sends return the child reply inline. In
      // both cases treating the child as a peer agent wakes the parent with
      // the child's reply, can generate another user-facing response, and can
      // forward that response back to the child as a new message — producing a
      // ping-pong loop (bounded by maxPingPongTurns, but visible as duplicate
      // conversation output).
      //
      // The skip is gated on requester ownership, not just target type: an
      // unrelated sender that can see the same target (e.g. under
      // `tools.sessions.visibility=all`) must still go through the normal A2A
      // path so it actually receives a follow-up delivery.
      const targetSessionEntry = loadSessionEntryByKey(resolvedKey);
      const targetAcpMeta = readAcpSessionMeta({ sessionKey: resolvedKey });
      const targetSessionEntryWithAcp =
        targetAcpMeta && targetSessionEntry
          ? { ...targetSessionEntry, acp: targetAcpMeta }
          : targetSessionEntry;
      const skipAcpA2AFlow = isRequesterParentOfBackgroundAcpSession(
        targetSessionEntryWithAcp,
        effectiveRequesterKey,
      );
      const skipNativeParentA2AFlow =
        timeoutSeconds !== 0 &&
        isRequesterParentOfNativeSubagentSession({
          entry: targetSessionEntry,
          acpMeta: targetAcpMeta,
          requesterSessionKey: effectiveRequesterKey,
          targetSessionKey: resolvedKey,
        });
      const skipA2AFlow = skipAcpA2AFlow || skipNativeParentA2AFlow;
      // When the A2A flow is skipped, no follow-up announcement will fire and
      // the reply (when present) is returned inline via the `reply` field.
      // Reflect that in the metadata so the parent LLM does not wait for a
      // second result that will never arrive.
      const delivery = skipA2AFlow
        ? ({ status: "skipped", mode: "announce" } as const)
        : ({ status: "pending", mode: "announce" } as const);
      const effectiveDefaultRelay = skipA2AFlow
        ? ({ ...defaultRelay, status: "not_applicable" } as const)
        : defaultRelay;
      const startA2AFlow = async (
        roundOneReply?: string,
        waitRunId?: string,
        flowTargetSessionKey = resolvedKey,
        flowDisplayKey = displayKey,
      ) => {
        if (skipA2AFlow) {
          return { relay: effectiveDefaultRelay };
        }
        const effectiveFlowParams =
          flowTargetSessionKey === resolvedKey && flowDisplayKey === displayKey
            ? flowParams
            : (
                await prepareSessionsSendA2AFlow(
                  {
                    targetSessionKey: flowTargetSessionKey,
                    displayKey: flowDisplayKey,
                    message,
                    announceTimeoutMs: a2aStepTimeoutMs,
                    maxPingPongTurns,
                    timeoutSeconds,
                    relayPolicy,
                    requesterSessionKey,
                    requesterChannel,
                  },
                  {
                    callGateway: gatewayCall,
                    resolveAnnounceTarget,
                  },
                )
              ).flowParams;
        return (
          (await runSessionsSendA2AFlow({
            ...effectiveFlowParams,
            baseline: baselineReply,
            roundOneReply,
            waitRunId,
          })) ?? { relay: effectiveDefaultRelay }
        );
      };

      if (timeoutSeconds === 0) {
        const start = await startAgentRun({
          callGateway: gatewayCall,
          runId,
          sendParams,
          sessionKey: displayKey,
          deliveryTimeoutMs: announceTimeoutMs,
          allowActiveRunQueueDelivery: true,
          extraResult: {
            resolvedTarget: resolvedTargetDisplay,
            ingressEcho,
          },
        });
        if (!start.ok) {
          return start.result;
        }
        runId = start.runId;
        if (!start.activeRunQueue) {
          void startA2AFlow(undefined, runId, start.a2aSessionKey, start.a2aDisplayKey);
        }
        return jsonResult({
          runId,
          status: "accepted",
          sessionKey: displayKey,
          resolvedTarget: resolvedTargetDisplay,
          delivery,
          ingressEcho,
          relay: effectiveDefaultRelay,
        });
      }

      const start = await startAgentRun({
        callGateway: gatewayCall,
        runId,
        sendParams,
        sessionKey: displayKey,
        deliveryTimeoutMs: announceTimeoutMs,
        extraResult: {
          resolvedTarget: resolvedTargetDisplay,
          ingressEcho,
        },
      });
      if (!start.ok) {
        return start.result;
      }
      runId = start.runId;
      const result = await waitForAgentRunAndReadUpdatedAssistantReply({
        runId,
        sessionKey: resolvedKey,
        timeoutMs,
        limit: SESSIONS_SEND_REPLY_HISTORY_LIMIT,
        baseline: baselineReply,
        callGateway: gatewayCall,
      });

      if (result.status === "timeout") {
        if (isPendingErrorAgentWaitTimeout(result)) {
          void startA2AFlow(undefined, runId);
          return jsonResult({
            runId,
            status: "timeout",
            error: result.error,
            sentBeforeError: true,
            sessionKey: displayKey,
            delivery,
          });
        }
        if (!isTerminalAgentWaitTimeout(result)) {
          void startA2AFlow(undefined, runId);
          return jsonResult({
            runId,
            status: "accepted",
            sessionKey: displayKey,
            resolvedTarget: resolvedTargetDisplay,
            delivery,
            ingressEcho,
            relay: defaultRelay,
          });
        }
        return jsonResult({
          runId,
          status: "timeout",
          error: result.error,
          sentBeforeError: true,
          sessionKey: displayKey,
          resolvedTarget: resolvedTargetDisplay,
          ingressEcho,
        });
      }
      if (result.status === "error") {
        return jsonResult({
          runId,
          status: "error",
          error: result.error ?? "agent error",
          sentBeforeError: true,
          sessionKey: displayKey,
          resolvedTarget: resolvedTargetDisplay,
          ingressEcho,
        });
      }
      const reply = result.replyText;
      const a2aResult = (await startA2AFlow(reply ?? undefined)) ?? {};
      const relay = a2aResult.relay ?? effectiveDefaultRelay;
      if (relayPolicy.enabled && (relay.status === "blocked" || relay.status === "failed")) {
        return jsonResult({
          runId,
          status: "error",
          error: "Required relay delivery failed.",
          reply,
          sessionKey: displayKey,
          resolvedTarget: resolvedTargetDisplay,
          delivery,
          ingressEcho,
          relay,
        });
      }

      return jsonResult({
        runId,
        status: "ok",
        reply,
        sessionKey: displayKey,
        resolvedTarget: resolvedTargetDisplay,
        delivery,
        ingressEcho,
        relay,
      });
    },
  };
}
