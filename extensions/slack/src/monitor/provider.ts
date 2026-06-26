// Slack provider module implements model/runtime integration.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  mergeAllowlist,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "openclaw/plugin-sdk/allow-from";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { SessionScope } from "openclaw/plugin-sdk/config-contracts";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { DEFAULT_GROUP_HISTORY_LIMIT } from "openclaw/plugin-sdk/reply-history";
import { normalizeMainKey } from "openclaw/plugin-sdk/routing";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import {
  computeBackoff,
  createNonExitingRuntime,
  registerUnhandledRejectionHandler,
  sleepWithAbort,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { installRequestBodyLimitGuard } from "openclaw/plugin-sdk/webhook-request-guards";
import {
  resolveSlackAccount,
  resolveSlackAccountAllowFrom,
  resolveSlackAccountDmPolicy,
} from "../accounts.js";
import { isSlackAnyNativeApprovalClientEnabled } from "../approval-native-gates.js";
import { resolveSlackWebClientOptions } from "../client-options.js";
import { normalizeSlackWebhookPath, registerSlackHttpHandler } from "../http/index.js";
import { SLACK_TEXT_LIMIT } from "../limits.js";
import { resolveSlackChannelAllowlist } from "../resolve-channels.js";
import { resolveSlackUserAllowlist, type SlackUserResolution } from "../resolve-users.js";
import { resolveSlackAppToken, resolveSlackBotToken } from "../token.js";
import { normalizeAllowList } from "./allow-list.js";
import { resolveSlackSlashCommandConfig } from "./commands.js";
import {
  getRuntimeConfig,
  isDangerousNameMatchingEnabled,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "./config.runtime.js";
import { createSlackMonitorContext } from "./context.js";
import { registerSlackMonitorEvents } from "./events.js";
import { createSlackMessageHandler } from "./message-handler.js";
import {
  createSlackBoltApp,
  createSlackSocketDisconnectWaiter,
  formatSlackChannelResolved,
  formatSlackUserResolved,
  gracefulStopSlackApp,
  incrementSlackStatusCounterSnapshot,
  installSlackSocketModeStatusObserver,
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  publishSlackSocketConnectionDisconnectedStatus,
  resolveSlackBoltInterop,
  resolveSlackSocketModeEffectiveSettings,
  resolveSlackSocketShutdownClient,
  startSlackSocketAndWaitForDisconnect,
  triggerSlackSocketDiagnosticDisconnect,
  type SlackBoltResolvedExports,
  type SlackStatusCounter,
} from "./provider-support.js";
import { startSlackHistoryReconciliation } from "./reconciliation.js";
import {
  formatUnknownError,
  getSocketEmitter,
  isNonRecoverableSlackAuthError,
  isRecoverableSlackSocketTransportError,
  SLACK_SOCKET_RECONNECT_POLICY,
  waitForSlackSocketDisconnect,
} from "./reconnect-policy.js";
import { setSlackDefaultSendIdentity } from "./send.runtime.js";
import { registerSlackMonitorSlashCommands } from "./slash.js";
import type { MonitorSlackOpts } from "./types.js";

let slackBoltInterop: SlackBoltResolvedExports | undefined;
type SlackRelaySourceModule = typeof import("./relay-source.js");
let slackRelaySourcePromise: Promise<SlackRelaySourceModule> | undefined;

async function getSlackBoltInterop(): Promise<SlackBoltResolvedExports> {
  if (!slackBoltInterop) {
    const slackBoltModule = await import("@slack/bolt");
    slackBoltInterop = resolveSlackBoltInterop({
      defaultImport: slackBoltModule.default,
      namespaceImport: slackBoltModule,
    });
  }
  return slackBoltInterop;
}

function loadSlackRelaySource(): Promise<SlackRelaySourceModule> {
  slackRelaySourcePromise ??= import("./relay-source.js");
  return slackRelaySourcePromise;
}

const SLACK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const SLACK_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
const SLACK_STARTUP_SLOW_STEP_MS = 5_000;
const SLACK_SOCKET_MAX_CONNECTIONS = 10;
const SLACK_AUTH_METADATA_RETRY_MS = 30_000;

type SlackSocketRuntime = ReturnType<typeof createSlackBoltApp> & {
  connectionId: string;
};

type SlackSocketDiagnosticDisconnect = {
  accountId?: string;
  connectionId: string;
  delayMs: number;
  reason: string;
};

function resolveStableSlackUserIdEntry(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const mention = /^<@([A-Z][A-Z0-9]+)>$/i.exec(trimmed);
  if (mention) {
    return mention[1]?.toUpperCase();
  }
  const prefixed = /^(?:slack:|user:)([A-Z][A-Z0-9]+)$/i.exec(trimmed);
  if (prefixed) {
    return prefixed[1]?.toUpperCase();
  }
  return /^[UW][A-Z0-9]+$/i.test(trimmed) ? trimmed.toUpperCase() : undefined;
}

function resolveStableSlackUserAllowlistEntries(entries: string[]): SlackUserResolution[] {
  const resolved: SlackUserResolution[] = [];
  for (const input of entries) {
    const id = resolveStableSlackUserIdEntry(input);
    if (id) {
      resolved.push({ input, resolved: true, id });
    }
  }
  return resolved;
}

export function formatSlackSocketReconnectMessage(params: {
  event: string;
  attempt: number;
  delayMs: number;
  error?: unknown;
}) {
  const suffix = params.error ? ` (${formatUnknownError(params.error)})` : "";
  return `slack socket disconnected (${params.event}); reconnecting in ${Math.round(params.delayMs / 1000)}s (attempt ${params.attempt}/∞)${suffix}`;
}

export function formatSlackSocketStartRetryMessage(params: {
  attempt: number;
  delayMs: number;
  error: unknown;
  sdkContext?: string;
}) {
  const reason = formatUnknownError(
    params.error,
    "Slack Socket Mode start failed without error detail",
  );
  const sdkContext = params.sdkContext?.trim() ? `; last SDK log: ${params.sdkContext.trim()}` : "";
  return `slack socket mode failed to start; retry ${params.attempt}/∞ in ${Math.round(params.delayMs / 1000)}s reason="${reason}${sdkContext}"`;
}

function parseApiAppIdFromAppToken(raw?: string) {
  const token = raw?.trim();
  if (!token) {
    return undefined;
  }
  const match = /^xapp-\d-([a-z0-9]+)-/i.exec(token);
  return match?.[1]?.toUpperCase();
}

function resolveSlackRelayConfig(params: { relay: unknown; accountId: string }): {
  url: string;
  authToken: string;
  gatewayId: string;
} {
  const relay =
    params.relay && typeof params.relay === "object" && !Array.isArray(params.relay)
      ? (params.relay as Record<string, unknown>)
      : {};
  const url = normalizeOptionalString(relay.url);
  const authToken = normalizeResolvedSecretInputString({
    value: relay.authToken,
    path: `channels.slack.accounts.${params.accountId}.relay.authToken`,
  });
  const gatewayId = normalizeOptionalString(relay.gatewayId);
  if (!url || !authToken || !gatewayId) {
    throw new Error(
      `Slack relay mode requires relay.url, relay.authToken, and relay.gatewayId for account "${params.accountId}".`,
    );
  }
  return {
    url,
    authToken,
    gatewayId,
  };
}

function startSlackStartupStepTimer(runtime: RuntimeEnv, label: string): () => void {
  const startedAt = Date.now();
  let finished = false;
  const timer = setTimeout(() => {
    runtime.log?.(
      `slack startup step "${label}" still running after ${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
  }, SLACK_STARTUP_SLOW_STEP_MS);
  timer.unref?.();
  return () => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timer);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= 1_000) {
      runtime.log?.(`slack startup step "${label}" completed in ${elapsedMs}ms`);
    }
  };
}

function resolveSlackSocketConnectionCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(SLACK_SOCKET_MAX_CONNECTIONS, Math.max(1, Math.trunc(value)))
    : 1;
}

function readExpectedSocketRefresh(
  snapshot: Record<string, unknown> | undefined,
  connectionId: string,
): boolean {
  const connections = snapshot?.socketConnections;
  const connection =
    connections && typeof connections === "object" && !Array.isArray(connections)
      ? (connections as Record<string, Record<string, unknown>>)[connectionId]
      : undefined;
  const value = connection?.lastSocketDisconnectReason ?? snapshot?.lastSocketDisconnectReason;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return (value as { expectedRefresh?: unknown }).expectedRefresh === true;
}

function parseSlackSocketDiagnosticDisconnect(
  raw: string | undefined,
): SlackSocketDiagnosticDisconnect | undefined {
  const text = raw?.trim();
  if (!text) {
    return undefined;
  }
  const [accountId, connectionId, delayMs, reason] = text.split(":");
  const parsedDelayMs = Number(delayMs);
  if (
    !connectionId?.trim() ||
    !Number.isFinite(parsedDelayMs) ||
    parsedDelayMs < 0 ||
    !reason?.trim()
  ) {
    return undefined;
  }
  return {
    accountId: accountId?.trim() || undefined,
    connectionId: connectionId.trim(),
    delayMs: Math.trunc(parsedDelayMs),
    reason: reason.trim(),
  };
}

function resolveSlackSocketDiagnosticDisconnect(
  accountId: string,
): SlackSocketDiagnosticDisconnect | undefined {
  const parsed = parseSlackSocketDiagnosticDisconnect(
    process.env.OPENCLAW_SLACK_DIAGNOSTIC_DISCONNECT,
  );
  if (!parsed || (parsed.accountId && parsed.accountId !== accountId)) {
    return undefined;
  }
  return parsed;
}

export async function monitorSlackProvider(opts: MonitorSlackOpts = {}) {
  const cfg = opts.config ?? getRuntimeConfig();
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const account = resolveSlackAccount({
    cfg,
    accountId: opts.accountId,
  });

  if (!account.enabled) {
    runtime.log?.(`[${account.accountId}] slack account disabled; monitor startup skipped`);
    if (opts.abortSignal?.aborted) {
      return;
    }
    await new Promise<void>((resolve) => {
      opts.abortSignal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    return;
  }

  const historyLimit = Math.max(
    0,
    account.config.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const dmHistoryLimit = Math.max(0, account.config.dmHistoryLimit ?? 0);

  const sessionCfg = cfg.session;
  const sessionScope: SessionScope = sessionCfg?.scope ?? "per-sender";
  const mainKey = normalizeMainKey(sessionCfg?.mainKey);

  const slackMode = opts.mode ?? account.config.mode ?? "socket";
  const slackWebhookPath = normalizeSlackWebhookPath(account.config.webhookPath);
  const signingSecret = normalizeResolvedSecretInputString({
    value: account.config.signingSecret,
    path: `channels.slack.accounts.${account.accountId}.signingSecret`,
  });
  const botToken = resolveSlackBotToken(opts.botToken ?? account.botToken);
  const appToken = resolveSlackAppToken(opts.appToken ?? account.appToken);
  const relayConfig =
    slackMode === "relay"
      ? resolveSlackRelayConfig({
          relay: account.config.relay,
          accountId: account.accountId,
        })
      : undefined;
  if (!botToken || (slackMode === "socket" && !appToken)) {
    const missing =
      slackMode === "http"
        ? `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).`
        : slackMode === "relay"
          ? `Slack bot token missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken or SLACK_BOT_TOKEN for default).`
          : `Slack bot + app tokens missing for account "${account.accountId}" (set channels.slack.accounts.${account.accountId}.botToken/appToken or SLACK_BOT_TOKEN/SLACK_APP_TOKEN for default).`;
    throw new Error(missing);
  }
  if (slackMode === "http" && !signingSecret) {
    throw new Error(
      `Slack signing secret missing for account "${account.accountId}" (set channels.slack.signingSecret or channels.slack.accounts.${account.accountId}.signingSecret).`,
    );
  }

  const slackCfg = account.config;
  const dmConfig = slackCfg.dm;

  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = resolveSlackAccountDmPolicy({ cfg, accountId: account.accountId }) ?? "pairing";
  let allowFrom = resolveSlackAccountAllowFrom({ cfg, accountId: account.accountId });
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  let channelsConfig = slackCfg.channels;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const providerConfigPresent = cfg.channels?.slack !== undefined;
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent,
    groupPolicy: slackCfg.groupPolicy,
    defaultGroupPolicy,
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "slack",
    accountId: account.accountId,
    log: (message) => runtime.log?.(warn(message)),
  });

  const resolveToken = account.userToken || botToken;
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const reactionMode = slackCfg.reactionNotifications ?? "own";
  const reactionAllowlist = slackCfg.reactionAllowlist ?? [];
  const replyToMode = slackCfg.replyToMode ?? "off";
  const threadHistoryScope = slackCfg.thread?.historyScope ?? "thread";
  const threadInheritParent = slackCfg.thread?.inheritParent ?? false;
  const threadRequireExplicitMention = slackCfg.thread?.requireExplicitMention ?? false;
  const slashCommand = resolveSlackSlashCommandConfig(opts.slashCommand ?? slackCfg.slashCommand);
  const allowNameMatching = isDangerousNameMatchingEnabled(slackCfg);
  const textLimit = resolveTextChunkLimit(cfg, "slack", account.accountId, {
    fallbackLimit: SLACK_TEXT_LIMIT,
  });
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const typingReaction = slackCfg.typingReaction?.trim() ?? "";
  const mediaMaxBytes = (opts.mediaMaxMb ?? slackCfg.mediaMaxMb ?? 20) * 1024 * 1024;
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const clientOptions = resolveSlackWebClientOptions();
  const trackTelemetry =
    opts.setStatus && opts.getStatus
      ? (counter: SlackStatusCounter) => {
          opts.setStatus!({
            slackTelemetry: incrementSlackStatusCounterSnapshot({
              snapshot: opts.getStatus?.(),
              counter,
            }),
          });
        }
      : undefined;
  const primarySocket = {
    ...createSlackBoltApp({
      interop: await getSlackBoltInterop(),
      slackMode,
      botToken,
      appToken: appToken ?? undefined,
      signingSecret: signingSecret ?? undefined,
      slackWebhookPath,
      clientOptions: clientOptions as Record<string, unknown>,
      ...(slackCfg.socketMode ? { socketMode: slackCfg.socketMode } : {}),
      onSelfEventDropped: trackTelemetry
        ? () => {
            trackTelemetry("droppedSelfBotEvents");
            trackTelemetry("droppedEvents");
          }
        : undefined,
    }),
    connectionId: "primary",
  } satisfies SlackSocketRuntime;
  const socketRuntimes: SlackSocketRuntime[] = [primarySocket];
  const interop = await getSlackBoltInterop();
  const configuredSocketConnectionCount =
    slackMode === "socket"
      ? resolveSlackSocketConnectionCount(slackCfg.socketMode?.connectionCount)
      : 1;
  const diagnosticDisconnect =
    slackMode === "socket" ? resolveSlackSocketDiagnosticDisconnect(account.accountId) : undefined;
  for (let index = 1; slackMode === "socket" && index < configuredSocketConnectionCount; index++) {
    socketRuntimes.push({
      ...createSlackBoltApp({
        interop,
        slackMode,
        botToken,
        appToken: appToken ?? undefined,
        signingSecret: signingSecret ?? undefined,
        slackWebhookPath,
        clientOptions: clientOptions as Record<string, unknown>,
        ...(slackCfg.socketMode ? { socketMode: slackCfg.socketMode } : {}),
        onSelfEventDropped: trackTelemetry
          ? () => {
              trackTelemetry("droppedSelfBotEvents");
              trackTelemetry("droppedEvents");
            }
          : undefined,
      }),
      connectionId: `socket-${index + 1}`,
    });
  }
  const { app, receiver } = primarySocket;
  opts.setStatus?.({
    socketConnectionCount: socketRuntimes.length,
    ...(slackMode === "socket"
      ? {
          socketModeSettings: resolveSlackSocketModeEffectiveSettings({
            socketMode: slackCfg.socketMode,
            connectionCount: socketRuntimes.length,
          }),
        }
      : {}),
  });
  const socketObserverDisposers =
    slackMode === "socket"
      ? socketRuntimes.map((socketRuntime) =>
          installSlackSocketModeStatusObserver(
            socketRuntime.receiver,
            opts.setStatus,
            opts.getStatus,
            {
              connectionId: socketRuntime.connectionId,
            },
          ),
        )
      : [];
  if (slackMode === "socket") {
    opts.setStatus?.({
      socketConnectionCount: socketRuntimes.length,
      socketModeSettings: resolveSlackSocketModeEffectiveSettings({
        socketMode: slackCfg.socketMode,
        connectionCount: socketRuntimes.length,
      }),
    });
  }

  // Pre-set shuttingDown on the SocketModeClient before app.stop() to prevent
  // a race where the library's internal ping timeout fires disconnect() before
  // shuttingDown is set, causing orphaned reconnects with leaked ping intervals.
  // See: openclaw/openclaw#56508
  const gracefulStop = async () => {
    await Promise.all(
      socketRuntimes.map((socketRuntime) => gracefulStopSlackApp(socketRuntime.app)),
    );
  };

  const slackHttpHandler =
    slackMode === "http" && receiver
      ? async (req: IncomingMessage, res: ServerResponse) => {
          const httpReceiver = receiver as {
            requestListener: (req: IncomingMessage, res: ServerResponse) => unknown;
          };
          const guard = installRequestBodyLimitGuard(req, res, {
            maxBytes: SLACK_WEBHOOK_MAX_BODY_BYTES,
            timeoutMs: SLACK_WEBHOOK_BODY_TIMEOUT_MS,
            responseFormat: "text",
          });
          if (guard.isTripped()) {
            return;
          }
          try {
            await Promise.resolve(httpReceiver.requestListener(req, res));
          } catch (err) {
            if (!guard.isTripped()) {
              throw err;
            }
          } finally {
            guard.dispose();
          }
        }
      : null;
  let unregisterHttpHandler: (() => void) | null = null;
  let recentSocketFaultAt = 0;
  let recentSocketFaultMessage: string | undefined;
  const noteRecentSocketFault = (error?: unknown) => {
    if (!error) {
      return;
    }
    if (!isRecoverableSlackSocketTransportError(error)) {
      return;
    }
    recentSocketFaultAt = Date.now();
    recentSocketFaultMessage = formatUnknownError(error);
  };
  const shouldSuppressSlackSocketUnhandledRejection = (reason: unknown) => {
    if (slackMode !== "socket") {
      return false;
    }
    if (recentSocketFaultAt <= 0 || Date.now() - recentSocketFaultAt > 15_000) {
      return false;
    }
    if (reason == null) {
      return true;
    }
    return isRecoverableSlackSocketTransportError(reason);
  };
  const unregisterUnhandledRejectionHandler = registerUnhandledRejectionHandler((reason) => {
    if (!shouldSuppressSlackSocketUnhandledRejection(reason)) {
      return false;
    }
    runtime.error?.(
      `slack socket mode suppressed unhandled rejection after recoverable transport fault (${recentSocketFaultMessage ?? "unknown socket fault"})`,
    );
    return true;
  });

  const expectedApiAppIdFromAppToken = parseApiAppIdFromAppToken(appToken);

  const ctx = createSlackMonitorContext({
    cfg,
    accountId: account.accountId,
    botToken,
    app,
    runtime,
    botUserId: "",
    botId: "",
    teamId: "",
    apiAppId: expectedApiAppIdFromAppToken ?? "",
    historyLimit,
    dmHistoryLimit,
    sessionScope,
    mainKey,
    dmEnabled,
    dmPolicy,
    allowFrom,
    allowNameMatching,
    groupDmEnabled,
    groupDmChannels,
    defaultRequireMention: slackCfg.requireMention,
    channelsConfig,
    groupPolicy,
    useAccessGroups,
    reactionMode,
    reactionAllowlist,
    replyToMode,
    threadHistoryScope,
    threadInheritParent,
    threadRequireExplicitMention,
    slashCommand,
    textLimit,
    ackReactionScope,
    typingReaction,
    mediaMaxBytes,
    removeAckAfterReply,
    trackTelemetry,
  });

  let authMetadataHydrationStarted = false;
  let authMetadataRetryTimer: NodeJS.Timeout | undefined;
  let reconciliationStarted = false;
  let stopReconciliation: (() => void) | undefined;
  const startReconciliation = () => {
    if (reconciliationStarted) {
      return;
    }
    reconciliationStarted = true;
    stopReconciliation = startSlackHistoryReconciliation({
      ctx,
      accountId: account.accountId,
      config: slackCfg.reconciliation,
      accountAllowBots: slackCfg.allowBots,
      handleSlackMessage,
      setStatus: opts.setStatus,
      abortSignal: opts.abortSignal,
    }).stop;
  };
  const scheduleAuthMetadataHydrationRetry = (reason: string) => {
    if (
      opts.abortSignal?.aborted ||
      reconciliationStarted ||
      authMetadataRetryTimer ||
      slackCfg.reconciliation?.enabled !== true
    ) {
      return;
    }
    authMetadataHydrationStarted = false;
    runtime.log?.(
      `slack auth metadata missing; reconciliation deferred until bot identity is available (${reason}); retrying in ${SLACK_AUTH_METADATA_RETRY_MS}ms`,
    );
    authMetadataRetryTimer = setTimeout(() => {
      authMetadataRetryTimer = undefined;
      startAuthMetadataHydration();
    }, SLACK_AUTH_METADATA_RETRY_MS);
    authMetadataRetryTimer.unref?.();
  };
  const startAuthMetadataHydration = () => {
    if (authMetadataHydrationStarted) {
      return;
    }
    if (authMetadataRetryTimer) {
      clearTimeout(authMetadataRetryTimer);
      authMetadataRetryTimer = undefined;
    }
    authMetadataHydrationStarted = true;
    void (async () => {
      const finishAuthStep = startSlackStartupStepTimer(runtime, "auth.test");
      let retryReason: string | undefined;
      try {
        const auth = await app.client.auth.test({ token: botToken });
        const apiAppId = (auth as { api_app_id?: string }).api_app_id ?? "";
        ctx.botUserId = auth.user_id ?? "";
        ctx.botId = (auth as { bot_id?: string }).bot_id ?? "";
        ctx.teamId = auth.team_id ?? "";
        ctx.apiAppId = apiAppId;
        if (apiAppId && expectedApiAppIdFromAppToken && apiAppId !== expectedApiAppIdFromAppToken) {
          runtime.error?.(
            `slack token mismatch: bot token api_app_id=${apiAppId} but app token looks like api_app_id=${expectedApiAppIdFromAppToken}`,
          );
        }
        if (!ctx.botUserId) {
          retryReason = "auth.test returned no user_id";
        }
      } catch (err) {
        // Auth metadata improves self-filtering and routing, but Socket Mode should
        // not be held hostage by a slow or transient auth.test request. History
        // reconciliation does need bot identity before it can safely checkpoint.
        retryReason = formatUnknownError(err);
        runtime.log?.(
          `slack auth metadata hydration failed; continuing without reconciliation. ${retryReason}`,
        );
      } finally {
        finishAuthStep();
        if (ctx.botUserId) {
          startReconciliation();
        } else {
          scheduleAuthMetadataHydrationRetry(retryReason ?? "missing bot identity");
        }
      }
    })();
  };

  // Slack's socket-mode client keeps ping/pong health private and closes on
  // missed pongs. App events are useful status activity, but not transport proof.
  const trackEvent = opts.setStatus
    ? () => {
        opts.setStatus!({ lastEventAt: Date.now(), lastInboundAt: Date.now() });
      }
    : undefined;
  const handleSlackMessage = createSlackMessageHandler({
    ctx,
    account,
    trackEvent,
    trackTelemetry,
  });
  if (slackMode !== "socket") {
    startAuthMetadataHydration();
  }
  if (
    isSlackAnyNativeApprovalClientEnabled({
      cfg,
      accountId: account.accountId,
    })
  ) {
    registerChannelRuntimeContext({
      channelRuntime: opts.channelRuntime,
      channelId: "slack",
      accountId: account.accountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      context: {
        app,
        config: slackCfg.execApprovals ?? {},
      },
      abortSignal: opts.abortSignal,
    });
  }

  for (const socketRuntime of socketRuntimes) {
    registerSlackMonitorEvents({
      ctx: socketRuntime.app === ctx.app ? ctx : { ...ctx, app: socketRuntime.app },
      account,
      handleSlackMessage,
      trackEvent,
      trackTelemetry,
    });
  }
  const finishSlashRegistration = startSlackStartupStepTimer(runtime, "slash registration");
  try {
    for (const socketRuntime of socketRuntimes) {
      await registerSlackMonitorSlashCommands({
        ctx: socketRuntime.app === ctx.app ? ctx : { ...ctx, app: socketRuntime.app },
        account,
        trackEvent,
      });
    }
  } finally {
    finishSlashRegistration();
  }
  if (slackMode === "http" && slackHttpHandler) {
    unregisterHttpHandler = registerSlackHttpHandler({
      path: slackWebhookPath,
      handler: slackHttpHandler,
      log: runtime.log,
      accountId: account.accountId,
    });
  }

  let allowlistResolutionStarted = false;
  const startAllowlistResolution = () => {
    if (!resolveToken || allowlistResolutionStarted) {
      return;
    }
    allowlistResolutionStarted = true;
    void (async () => {
      if (opts.abortSignal?.aborted) {
        return;
      }

      if (channelsConfig && Object.keys(channelsConfig).length > 0) {
        try {
          const entries = Object.keys(channelsConfig).filter((key) => key !== "*");
          if (entries.length > 0) {
            const resolved = await resolveSlackChannelAllowlist({
              token: resolveToken,
              entries,
            });
            const nextChannels = { ...channelsConfig };
            const mapping: string[] = [];
            const unresolved: string[] = [];
            for (const entry of resolved) {
              const source = channelsConfig?.[entry.input];
              if (!source) {
                continue;
              }
              if (!entry.resolved || !entry.id) {
                unresolved.push(entry.input);
                continue;
              }
              mapping.push(formatSlackChannelResolved(entry));
              const existing = nextChannels[entry.id] ?? {};
              nextChannels[entry.id] = { ...source, ...existing };
            }
            channelsConfig = nextChannels;
            ctx.channelsConfig = nextChannels;
            summarizeMapping("slack channels", mapping, unresolved, runtime);
          }
        } catch (err) {
          runtime.log?.(
            `slack channel resolve failed; using config entries. ${formatUnknownError(err)}`,
          );
        }
      }

      const allowEntries = normalizeStringEntries(allowFrom).filter((entry) => entry !== "*");
      if (allowEntries.length > 0) {
        const stableResolvedUsers = resolveStableSlackUserAllowlistEntries(allowEntries);
        if (stableResolvedUsers.length > 0) {
          const { mapping, additions } = buildAllowlistResolutionSummary(stableResolvedUsers, {
            formatResolved: formatSlackUserResolved,
          });
          allowFrom = mergeAllowlist({ existing: allowFrom, additions });
          ctx.allowFrom = normalizeAllowList(allowFrom);
          summarizeMapping("slack users", mapping, [], runtime);
        }

        if (allowNameMatching) {
          try {
            const resolvedUsers = await resolveSlackUserAllowlist({
              token: resolveToken,
              entries: allowEntries,
            });
            const { mapping, unresolved, additions } = buildAllowlistResolutionSummary(
              resolvedUsers,
              {
                formatResolved: formatSlackUserResolved,
              },
            );
            allowFrom = mergeAllowlist({ existing: allowFrom, additions });
            ctx.allowFrom = normalizeAllowList(allowFrom);
            summarizeMapping("slack users", mapping, unresolved, runtime);
          } catch (err) {
            runtime.log?.(
              `slack user resolve failed; using config entries. ${formatUnknownError(err)}`,
            );
          }
        }
      }

      if (channelsConfig && Object.keys(channelsConfig).length > 0) {
        const userEntries = new Set<string>();
        for (const channel of Object.values(channelsConfig)) {
          addAllowlistUserEntriesFromConfigEntry(userEntries, channel);
        }

        if (userEntries.size > 0) {
          const stableResolvedUsers = resolveStableSlackUserAllowlistEntries(
            Array.from(userEntries),
          );
          if (stableResolvedUsers.length > 0) {
            const { resolvedMap, mapping } = buildAllowlistResolutionSummary(stableResolvedUsers, {
              formatResolved: formatSlackUserResolved,
            });
            const nextChannels = patchAllowlistUsersInConfigEntries({
              entries: channelsConfig,
              resolvedMap,
            });
            channelsConfig = nextChannels;
            ctx.channelsConfig = nextChannels;
            summarizeMapping("slack channel users", mapping, [], runtime);
          }

          if (allowNameMatching) {
            try {
              const resolvedUsers = await resolveSlackUserAllowlist({
                token: resolveToken,
                entries: Array.from(userEntries),
              });
              const { resolvedMap, mapping, unresolved } = buildAllowlistResolutionSummary(
                resolvedUsers,
                {
                  formatResolved: formatSlackUserResolved,
                },
              );

              const nextChannels = patchAllowlistUsersInConfigEntries({
                entries: channelsConfig,
                resolvedMap,
              });
              channelsConfig = nextChannels;
              ctx.channelsConfig = nextChannels;
              summarizeMapping("slack channel users", mapping, unresolved, runtime);
            } catch (err) {
              runtime.log?.(
                `slack channel user resolve failed; using config entries. ${formatUnknownError(err)}`,
              );
            }
          }
        }
      }
    })();
  };
  if (slackMode !== "socket") {
    startAllowlistResolution();
  }

  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted && slackMode === "socket") {
      void gracefulStop();
    }
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });

  try {
    if (slackMode === "socket") {
      const runSocketConnection = async (socketRuntime: SlackSocketRuntime) => {
        let reconnectAttempts = 0;
        let hasLoggedSocketConnected = false;
        let diagnosticDisconnectArmed = false;
        while (!opts.abortSignal?.aborted) {
          try {
            const finishSocketStart = startSlackStartupStepTimer(
              runtime,
              `socket start ${socketRuntime.connectionId}`,
            );
            const disconnect = await startSlackSocketAndWaitForDisconnect({
              app: socketRuntime.app,
              abortSignal: opts.abortSignal,
              onStarted: () => {
                finishSocketStart();
                startAuthMetadataHydration();
                startAllowlistResolution();
                reconnectAttempts = 0;
                publishSlackConnectedStatus(opts.setStatus);
                if (
                  diagnosticDisconnect &&
                  diagnosticDisconnect.connectionId === socketRuntime.connectionId &&
                  !diagnosticDisconnectArmed
                ) {
                  diagnosticDisconnectArmed = true;
                  const timer = setTimeout(() => {
                    const triggered = triggerSlackSocketDiagnosticDisconnect({
                      receiver: socketRuntime.receiver,
                      reason: diagnosticDisconnect.reason,
                    });
                    runtime.log?.(
                      triggered
                        ? `slack diagnostic socket disconnect triggered (${socketRuntime.connectionId}, reason=${diagnosticDisconnect.reason})`
                        : `slack diagnostic socket disconnect unavailable (${socketRuntime.connectionId})`,
                    );
                  }, diagnosticDisconnect.delayMs);
                  timer.unref?.();
                }
                if (!hasLoggedSocketConnected) {
                  hasLoggedSocketConnected = true;
                  runtime.log?.(`slack socket mode connected (${socketRuntime.connectionId})`);
                }
              },
            }).catch((err: unknown) => {
              finishSocketStart();
              throw err;
            });
            finishSocketStart();
            if (!disconnect) {
              break;
            }
            if (opts.abortSignal?.aborted) {
              break;
            }
            noteRecentSocketFault(disconnect.error);
            publishSlackSocketConnectionDisconnectedStatus({
              receiver: socketRuntime.receiver,
              setStatus: opts.setStatus,
              getStatus: opts.getStatus,
              connectionId: socketRuntime.connectionId,
              error: disconnect.error,
            });
            const expectedRefresh = readExpectedSocketRefresh(
              opts.getStatus?.(),
              socketRuntime.connectionId,
            );

            // Bail immediately on non-recoverable auth errors during reconnect too.
            if (disconnect.error && isNonRecoverableSlackAuthError(disconnect.error)) {
              runtime.error?.(
                `slack socket mode disconnected due to non-recoverable auth error — skipping channel (${formatUnknownError(disconnect.error)})`,
              );
              throw disconnect.error instanceof Error
                ? disconnect.error
                : new Error(formatUnknownError(disconnect.error));
            }

            reconnectAttempts = expectedRefresh ? 0 : reconnectAttempts + 1;
            if (
              SLACK_SOCKET_RECONNECT_POLICY.maxAttempts > 0 &&
              reconnectAttempts >= SLACK_SOCKET_RECONNECT_POLICY.maxAttempts
            ) {
              throw new Error(
                `Slack socket mode reconnect max attempts reached (${reconnectAttempts}/${SLACK_SOCKET_RECONNECT_POLICY.maxAttempts}) after ${disconnect.event}`,
              );
            }

            const delayMs = expectedRefresh
              ? 0
              : computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
            runtime.log?.(
              warn(
                expectedRefresh
                  ? `slack socket refresh requested (${socketRuntime.connectionId}); reconnecting immediately`
                  : formatSlackSocketReconnectMessage({
                      event: disconnect.event,
                      attempt: reconnectAttempts,
                      maxAttempts: SLACK_SOCKET_RECONNECT_POLICY.maxAttempts,
                      delayMs,
                      error: disconnect.error,
                    }),
              ),
            );
            await gracefulStopSlackApp(socketRuntime.app);
            try {
              await sleepWithAbort(delayMs, opts.abortSignal);
            } catch {
              break;
            }
          } catch (err) {
            noteRecentSocketFault(err);
            // Auth errors (account_inactive, invalid_auth, etc.) are permanent —
            // retrying will never succeed and blocks the entire gateway.  Fail fast.
            if (isNonRecoverableSlackAuthError(err)) {
              runtime.error?.(
                `slack socket mode failed to start due to non-recoverable auth error — skipping channel (${formatUnknownError(err)})`,
              );
              throw err;
            }
            reconnectAttempts += 1;
            if (
              SLACK_SOCKET_RECONNECT_POLICY.maxAttempts > 0 &&
              reconnectAttempts >= SLACK_SOCKET_RECONNECT_POLICY.maxAttempts
            ) {
              throw err;
            }
            const delayMs = computeBackoff(SLACK_SOCKET_RECONNECT_POLICY, reconnectAttempts);
            runtime.error?.(
              formatSlackSocketStartRetryMessage({
                attempt: reconnectAttempts,
                delayMs,
                error: err,
                sdkContext: socketRuntime.socketModeLogger.getLastMessage(),
              }),
            );
            try {
              await sleepWithAbort(delayMs, opts.abortSignal);
            } catch {
              break;
            }
            continue;
          }
        }
      };
      await Promise.all(socketRuntimes.map((socketRuntime) => runSocketConnection(socketRuntime)));
    } else if (slackMode === "relay" && relayConfig) {
      runtime.log?.(
        `slack relay mode connecting to ${relayConfig.url} gateway_id:${relayConfig.gatewayId}`,
      );
      await (
        await loadSlackRelaySource()
      ).monitorSlackRelaySource({
        config: relayConfig,
        handleSlackMessage,
        runtime,
        abortSignal: opts.abortSignal,
        setStatus: opts.setStatus,
        setIdentity: (identity) => setSlackDefaultSendIdentity(account.accountId, identity),
      });
    } else {
      runtime.log?.(`slack http mode listening at ${slackWebhookPath}`);
      if (!opts.abortSignal?.aborted) {
        await new Promise<void>((resolve) => {
          opts.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      }
    }
  } finally {
    if (slackMode === "relay") {
      setSlackDefaultSendIdentity(account.accountId, undefined);
    }
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    for (const dispose of socketObserverDisposers) {
      dispose();
    }
    if (authMetadataRetryTimer) {
      clearTimeout(authMetadataRetryTimer);
      authMetadataRetryTimer = undefined;
    }
    unregisterUnhandledRejectionHandler();
    stopReconciliation?.();
    unregisterHttpHandler?.();
    await gracefulStop();
  }
}

export { isNonRecoverableSlackAuthError } from "./reconnect-policy.js";

export const resolveSlackRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;

export const testing = {
  formatSlackChannelResolved,
  formatSlackUserResolved,
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  resolveSlackSocketShutdownClient,
  gracefulStopSlackApp,
  resolveSlackRuntimeGroupPolicy: resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveSlackBoltInterop,
  createSlackBoltApp,
  createSlackSocketDisconnectWaiter,
  startSlackSocketAndWaitForDisconnect,
  isRecoverableSlackSocketTransportError,
  getSocketEmitter,
  waitForSlackSocketDisconnect,
};
export { testing as __testing };
