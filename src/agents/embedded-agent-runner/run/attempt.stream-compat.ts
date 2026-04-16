import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { resolveToolCallArgumentsEncoding } from "../../../plugins/provider-model-compat.js";
import { resolveProviderTextTransforms } from "../../../plugins/provider-runtime.js";
import { createAnthropicPayloadLogger } from "../../anthropic-payload-log.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  downgradeOpenAIReasoningBlocks,
} from "../../embedded-agent-helpers.js";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import { registerProviderStreamForModel } from "../../provider-stream.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import {
  shouldAllowProviderOwnedThinkingReplay,
  type TranscriptPolicy,
} from "../../transcript-policy.js";
import {
  applyExtraParamsToAgent,
  resolveAgentTransportOverride,
  resolveExplicitSettingsTransport,
} from "../extra-params.js";
import { log } from "../logger.js";
import { collectPromptCacheToolNames } from "../prompt-cache-observability.js";
import { resolveCacheRetention } from "../prompt-cache-retention.js";
import {
  describeEmbeddedAgentStreamStrategy,
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
} from "../stream-resolution.js";
import { dropReasoningFromHistory, dropThinkingBlocks } from "../thinking.js";
import { createYieldAbortedResponse } from "./attempt.sessions-yield.js";
import { wrapStreamFnHandleSensitiveStopReason } from "./attempt.stop-reason-recovery.js";
import { shouldUseOpenAIWebSocketTransportForAttempt } from "./attempt.thread-helpers.js";
import {
  shouldRepairMalformedAnthropicToolCallArguments,
  wrapStreamFnDecodeXaiToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";
import {
  sanitizeReplayToolCallIdsForStream,
  wrapStreamFnSanitizeMalformedToolCalls,
  wrapStreamFnTrimToolCallNames,
} from "./attempt.tool-call-normalization.js";
import { resolveLlmIdleTimeoutMs, streamWithIdleTimeout } from "./llm-idle-timeout.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type EmbeddedSession = Awaited<ReturnType<typeof createAgentSession>>["session"];
type EmbeddedStreamFn = NonNullable<EmbeddedSession["agent"]["streamFn"]>;
type CacheTrace = NonNullable<ReturnType<typeof import("../../cache-trace.js").createCacheTrace>>;
type AnthropicPayloadLogger = NonNullable<ReturnType<typeof createAnthropicPayloadLogger>>;
type IdleTimeoutTrigger = (error: Error) => void;

export type ConfigureEmbeddedAttemptStreamCompatibilityParams = {
  session: EmbeddedSession;
  params: EmbeddedRunAttemptParams;
  agentDir: string;
  effectiveWorkspace: string;
  runAbortController: AbortController;
  settingsManager: ReturnType<
    typeof import("../../agent-project-settings.js").createPreparedEmbeddedAgentSettingsManager
  >;
  builtInTools: Array<{ name?: string }>;
  allCustomTools: Array<{ name?: string }>;
  sessionAgentId?: string;
  transcriptPolicy: TranscriptPolicy;
  allowedToolNames: Set<string>;
  clientToolLoopDetection?: {
    enabled?: boolean;
    unknownToolThreshold?: number;
  };
  cacheTrace?: CacheTrace | null;
  anthropicPayloadLogger?: AnthropicPayloadLogger | null;
  resolveUnknownToolGuardThreshold: (loopDetection?: {
    enabled?: boolean;
    unknownToolThreshold?: number;
  }) => number;
  systemPromptText: string;
  yieldDetected: boolean;
};

export type ConfiguredEmbeddedAttemptStreamCompatibility = {
  streamStrategy: string;
  effectiveExtraParams: ReturnType<typeof applyExtraParamsToAgent>["effectiveExtraParams"];
  effectivePromptCacheRetention: ReturnType<typeof resolveCacheRetention>;
  effectiveAgentTransport: EmbeddedSession["agent"]["transport"];
  cacheObservabilityEnabled: boolean;
  promptCacheToolNames: string[];
  setIdleTimeoutTrigger: (trigger?: IdleTimeoutTrigger) => void;
};

export async function configureEmbeddedAttemptStreamCompatibility(
  params: ConfigureEmbeddedAttemptStreamCompatibilityParams,
): Promise<ConfiguredEmbeddedAttemptStreamCompatibility> {
  const activeSession = params.session;
  const defaultSessionStreamFn = resolveEmbeddedAgentBaseStreamFn({
    session: activeSession,
  });
  const providerStreamFn = registerProviderStreamForModel({
    model: params.params.model,
    cfg: params.params.config,
    agentDir: params.agentDir,
    workspaceDir: params.effectiveWorkspace,
  });
  const resolvedTransport = resolveExplicitSettingsTransport({
    settingsManager: params.settingsManager,
    sessionTransport: activeSession.agent.transport,
  });
  const streamExtraParamsOverride = {
    ...params.params.streamParams,
    fastMode: params.params.fastMode,
  };
  const preparedRuntimeExtraParams = params.params.runtimePlan?.transport.resolveExtraParams({
    extraParamsOverride: streamExtraParamsOverride,
    thinkingLevel: params.params.thinkLevel,
    agentId: params.sessionAgentId,
    workspaceDir: params.effectiveWorkspace,
    model: params.params.model,
    resolvedTransport,
  });
  const { effectiveExtraParams } = applyExtraParamsToAgent(
    activeSession.agent,
    params.params.config,
    params.params.provider,
    params.params.modelId,
    streamExtraParamsOverride,
    params.params.thinkLevel,
    params.sessionAgentId,
    params.effectiveWorkspace,
    params.params.model,
    params.agentDir,
    resolvedTransport,
    preparedRuntimeExtraParams
      ? {
          preparedExtraParams: preparedRuntimeExtraParams,
        }
      : undefined,
  );
  const shouldUseWsTransport = shouldUseOpenAIWebSocketTransportForAttempt({
    provider: params.params.provider,
    modelApi: params.params.model.api,
    modelBaseUrl: params.params.model.baseUrl,
    streamParams: params.params.streamParams,
    effectiveExtraParams,
    modelParams: (params.params.model as { params?: Record<string, unknown> }).params,
  });
  const wsApiKey = shouldUseWsTransport
    ? await resolveEmbeddedAgentApiKey({
        provider: params.params.provider,
        resolvedApiKey: params.params.resolvedApiKey,
        authStorage: params.params.authStorage,
      })
    : undefined;
  if (shouldUseWsTransport && !wsApiKey) {
    log.warn(
      `[ws-stream] no API key for provider=${params.params.provider}; keeping session-managed HTTP transport`,
    );
  }
  const streamStrategy = describeEmbeddedAgentStreamStrategy({
    currentStreamFn: defaultSessionStreamFn,
    providerStreamFn,
    shouldUseWebSocketTransport: shouldUseWsTransport,
    wsApiKey,
    model: params.params.model,
  });
  activeSession.agent.streamFn = resolveEmbeddedAgentStreamFn({
    currentStreamFn: defaultSessionStreamFn,
    providerStreamFn,
    shouldUseWebSocketTransport: shouldUseWsTransport,
    wsApiKey,
    sessionId: params.params.sessionId,
    signal: params.runAbortController.signal,
    model: params.params.model,
    resolvedApiKey: params.params.resolvedApiKey,
    authStorage: params.params.authStorage,
  });

  const providerTextTransforms = resolveProviderTextTransforms({
    provider: params.params.provider,
    config: params.params.config,
    workspaceDir: params.effectiveWorkspace,
  });
  if (providerTextTransforms) {
    activeSession.agent.streamFn = wrapStreamFnTextTransforms({
      streamFn: activeSession.agent.streamFn,
      input: providerTextTransforms.input,
      output: providerTextTransforms.output,
      transformSystemPrompt: false,
    });
  }

  const effectivePromptCacheRetention = resolveCacheRetention(
    effectiveExtraParams,
    params.params.provider,
    params.params.model.api,
    params.params.modelId,
  );
  const agentTransportOverride = resolveAgentTransportOverride({
    settingsManager: params.settingsManager,
    effectiveExtraParams,
  });
  const effectiveAgentTransport = agentTransportOverride ?? activeSession.agent.transport;
  if (agentTransportOverride && activeSession.agent.transport !== agentTransportOverride) {
    const previousTransport = activeSession.agent.transport;
    log.debug(
      `embedded agent transport override: ${previousTransport} -> ${agentTransportOverride} ` +
        `(${params.params.provider}/${params.params.modelId})`,
    );
  }

  const cacheObservabilityEnabled = Boolean(params.cacheTrace) || log.isEnabled("debug");
  const promptCacheToolNames = collectPromptCacheToolNames([
    ...params.builtInTools,
    ...params.allCustomTools,
  ]);

  if (params.cacheTrace) {
    params.cacheTrace.recordStage("session:loaded", {
      messages: activeSession.messages,
      system: params.systemPromptText,
      note: "after session create",
    });
    activeSession.agent.streamFn = params.cacheTrace.wrapStreamFn(activeSession.agent.streamFn);
  }

  if (
    params.transcriptPolicy.dropThinkingBlocks ||
    params.transcriptPolicy.dropReasoningFromHistory
  ) {
    const inner = activeSession.agent.streamFn;
    activeSession.agent.streamFn = ((model, context, options) => {
      const ctx = context as unknown as { messages?: unknown };
      const messages = ctx?.messages;
      if (!Array.isArray(messages)) {
        return inner(model, context, options);
      }
      const reasoningSanitized = params.transcriptPolicy.dropReasoningFromHistory
        ? dropReasoningFromHistory(messages as AgentMessage[])
        : (messages as AgentMessage[]);
      const sanitized = params.transcriptPolicy.dropThinkingBlocks
        ? (dropThinkingBlocks(reasoningSanitized) as unknown)
        : (reasoningSanitized as unknown);
      if (sanitized === messages) {
        return inner(model, context, options);
      }
      const nextContext = {
        ...(context as unknown as Record<string, unknown>),
        messages: sanitized,
      } as unknown;
      return inner(model, nextContext as typeof context, options);
    }) as EmbeddedStreamFn;
  }

  const isOpenAIResponsesApi =
    params.params.model.api === "openai-responses" ||
    params.params.model.api === "azure-openai-responses" ||
    params.params.model.api === "openai-codex-responses";

  if (
    params.transcriptPolicy.sanitizeToolCallIds &&
    params.transcriptPolicy.toolCallIdMode &&
    !isOpenAIResponsesApi
  ) {
    const inner = activeSession.agent.streamFn;
    const mode = params.transcriptPolicy.toolCallIdMode;
    activeSession.agent.streamFn = ((model, context, options) => {
      const ctx = context as unknown as { messages?: unknown };
      const messages = ctx?.messages;
      if (!Array.isArray(messages)) {
        return inner(model, context, options);
      }
      const nextMessages = sanitizeReplayToolCallIdsForStream({
        messages: messages as AgentMessage[],
        mode,
        allowedToolNames: params.allowedToolNames,
        preserveNativeAnthropicToolUseIds:
          params.transcriptPolicy.preserveNativeAnthropicToolUseIds,
        preserveReplaySafeThinkingToolCallIds: shouldAllowProviderOwnedThinkingReplay({
          modelApi: (model as { api?: unknown })?.api as string | null | undefined,
          policy: params.transcriptPolicy,
        }),
        repairToolUseResultPairing: params.transcriptPolicy.repairToolUseResultPairing,
      });
      if (nextMessages === messages) {
        return inner(model, context, options);
      }
      const nextContext = {
        ...(context as unknown as Record<string, unknown>),
        messages: nextMessages,
      } as unknown;
      return inner(model, nextContext as typeof context, options);
    }) as EmbeddedStreamFn;
  }

  if (isOpenAIResponsesApi) {
    const inner = activeSession.agent.streamFn;
    activeSession.agent.streamFn = ((model, context, options) => {
      const ctx = context as unknown as { messages?: unknown };
      const messages = ctx?.messages;
      if (!Array.isArray(messages)) {
        return inner(model, context, options);
      }
      // Strip orphaned reasoning blocks first, then fix function-call pairing.
      // This matches the replay sanitation order used by the Google provider.
      const reasoningSanitized = downgradeOpenAIReasoningBlocks(messages as AgentMessage[]);
      const sanitized = downgradeOpenAIFunctionCallReasoningPairs(reasoningSanitized);
      if (sanitized === messages) {
        return inner(model, context, options);
      }
      const nextContext = {
        ...(context as unknown as Record<string, unknown>),
        messages: sanitized,
      } as unknown;
      return inner(model, nextContext as typeof context, options);
    }) as EmbeddedStreamFn;
  }

  const innerStreamFn = activeSession.agent.streamFn;
  activeSession.agent.streamFn = ((model, context, options) => {
    const signal = params.runAbortController.signal as AbortSignal & { reason?: unknown };
    if (params.yieldDetected && signal.aborted && signal.reason === "sessions_yield") {
      return createYieldAbortedResponse(model) as unknown as Awaited<
        ReturnType<typeof innerStreamFn>
      >;
    }
    return innerStreamFn(model, context, options);
  }) as EmbeddedStreamFn;

  activeSession.agent.streamFn = wrapStreamFnSanitizeMalformedToolCalls(
    activeSession.agent.streamFn,
    params.allowedToolNames,
    params.transcriptPolicy,
  );
  activeSession.agent.streamFn = wrapStreamFnTrimToolCallNames(
    activeSession.agent.streamFn,
    params.allowedToolNames,
    {
      unknownToolThreshold: params.resolveUnknownToolGuardThreshold(params.clientToolLoopDetection),
    },
  );

  if (
    params.params.model.api === "anthropic-messages" &&
    shouldRepairMalformedAnthropicToolCallArguments(params.params.provider)
  ) {
    activeSession.agent.streamFn = wrapStreamFnRepairMalformedToolCallArguments(
      activeSession.agent.streamFn,
    );
  }

  if (resolveToolCallArgumentsEncoding(params.params.model) === "html-entities") {
    activeSession.agent.streamFn = wrapStreamFnDecodeXaiToolCallArguments(
      activeSession.agent.streamFn,
    );
  }

  if (params.anthropicPayloadLogger) {
    activeSession.agent.streamFn = params.anthropicPayloadLogger.wrapStreamFn(
      activeSession.agent.streamFn,
    );
  }
  activeSession.agent.streamFn = wrapStreamFnHandleSensitiveStopReason(
    activeSession.agent.streamFn,
  );

  let idleTimeoutTrigger: IdleTimeoutTrigger | undefined;
  const configuredRunTimeoutMs = resolveAgentTimeoutMs({
    cfg: params.params.config,
  });
  const resolvedRunTimeoutMs =
    params.params.runTimeoutOverrideMs ??
    (params.params.timeoutMs !== configuredRunTimeoutMs ? params.params.timeoutMs : undefined);
  const idleTimeoutMs = resolveLlmIdleTimeoutMs({
    cfg: params.params.config,
    trigger: params.params.trigger,
    runTimeoutMs: resolvedRunTimeoutMs,
    modelRequestTimeoutMs: (params.params.model as { requestTimeoutMs?: number }).requestTimeoutMs,
    model: params.params.model as { baseUrl?: string },
  });
  if (idleTimeoutMs > 0) {
    activeSession.agent.streamFn = streamWithIdleTimeout(
      activeSession.agent.streamFn,
      idleTimeoutMs,
      (error) => idleTimeoutTrigger?.(error),
    );
  }

  log.debug(
    `embedded run stream strategy: ${streamStrategy} (${params.params.provider}/${params.params.modelId})`,
  );

  return {
    streamStrategy,
    effectiveExtraParams,
    effectivePromptCacheRetention,
    effectiveAgentTransport,
    cacheObservabilityEnabled,
    promptCacheToolNames,
    setIdleTimeoutTrigger: (trigger) => {
      idleTimeoutTrigger = trigger;
    },
  };
}
