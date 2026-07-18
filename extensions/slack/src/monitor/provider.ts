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
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
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
import {
  formatSlackBotTokenIdentityWarning,
  resolveSlackAppToken,
  resolveSlackBotToken,
} from "../token.js";
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
import {
  assertEnterpriseSlackDmPolicy,
  assertEnterpriseSlackPolicyConfig,
  assertNoEnterpriseSlackBindings,
  resolveSlackInstallationIdentity,
} from "./enterprise-install.js";
import { registerSlackMonitorEvents } from "./events.js";
import { createSlackMessageHandler } from "./message-handler.js";
import {
  createSlackBoltApp,
  formatSlackChannelResolved,
  formatSlackUserResolved,
  gracefulStopSlackApp,
  incrementSlackStatusCounterSnapshot,
  installSlackSocketModeStatusObserver,
  publishSlackConnectedStatus,
  publishSlackSocketConnectionDisconnectedStatus,
  resolveSlackBoltInterop,
  resolveSlackSocketModeEffectiveSettings,
  startSlackSocketAndWaitForDisconnect,
  triggerSlackSocketDiagnosticDisconnect,
  type SlackBoltResolvedExports,
  type SlackStatusCounter,
} from "./provider-support.js";
import { startSlackHistoryReconciliation } from "./reconciliation.js";
import {
  formatUnknownError,
  isNonRecoverableSlackAuthError,
  isRecoverableSlackSocketTransportError,
  SLACK_SOCKET_RECONNECT_POLICY,
} from "./reconnect-policy.js";
import { setSlackDefaultSendIdentity } from "./send.runtime.js";
import { registerSlackMonitorSlashCommands } from "./slash.js";
import type { MonitorSlackOpts } from "./types.js";

let slackBoltInterop: SlackBoltResolvedExports | undefined;

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

const loadSlackRelaySource = createLazyRuntimeModule(() => import("./relay-source.js"));

const SLACK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const SLACK_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
const SLACK_STARTUP_SLOW_STEP_MS = 5_000;
const SLACK_SOCKET_MAX_CONNECTIONS = 10;
const SLACK_AUTH_METADATA_RETRY_MS = 30_000;
const SLACK_ENTERPRISE_AUTH_METADATA_MAX_RETRY_MS = 5 * 60_000;
const SLACK_SOCKET_REJECTION_CORRELATION_WINDOW_MS = 15_000;

type SlackSocketRuntime = ReturnType<typeof createSlackBoltApp> & {
  connectionId: string;
  expectedRefreshPending: boolean;
};

type SlackSocketDiagnosticDisconnect = {
  accountId?: string;
  connectionId: string;
  delayMs: number;
  reason: string;
};

type SlackSocketUnhandledRejectionGuard = {
  noteFault: (error?: unknown) => void;
  consumeFault: (reason: unknown) => string | undefined;
};

export function createSlackSocketUnhandledRejectionGuard(
  now: () => number = Date.now,
): SlackSocketUnhandledRejectionGuard {
  // The process-wide hook may only claim the exact error object already observed
  // by this socket loop; message similarity can swallow unrelated runtime failures.
  const recentFaults = new WeakMap<object, { at: number; message: string }>();
  return {
    noteFault: (error) => {
      if (
        !error ||
        (typeof error !== "object" && typeof error !== "function") ||
        !isRecoverableSlackSocketTransportError(error)
      ) {
        return;
      }
      recentFaults.set(error, { at: now(), message: formatUnknownError(error) });
    },
    consumeFault: (reason) => {
      if (!reason || (typeof reason !== "object" && typeof reason !== "function")) {
        return undefined;
      }
      const fault = recentFaults.get(reason);
      if (!fault) {
        return undefined;
      }
      recentFaults.delete(reason);
      return now() - fault.at <= SLACK_SOCKET_REJECTION_CORRELATION_WINDOW_MS
        ? fault.message
        : undefined;
    },
  };
}

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

function isExpectedSocketRefresh(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { expectedRefresh?: unknown }).expectedRefresh === true,
  );
}

function isSameSocketDisconnectReason(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (
    !left ||
    typeof left !== "object" ||
    Array.isArray(left) ||
    !right ||
    typeof right !== "object" ||
    Array.isArray(right)
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  return (
    leftRecord.at === rightRecord.at &&
    leftRecord.reason === rightRecord.reason &&
    leftRecord.kind === rightRecord.kind &&
    leftRecord.expectedRefresh === rightRecord.expectedRefresh
  );
}

export function consumeExpectedSocketRefresh(params: {
  snapshot: Record<string, unknown> | undefined;
  connectionId: string;
  setStatus?: (next: Record<string, unknown>) => void;
}): boolean {
  const { snapshot, connectionId } = params;
  const connections = snapshot?.socketConnections;
  const connection =
    connections && typeof connections === "object" && !Array.isArray(connections)
      ? (connections as Record<string, Record<string, unknown>>)[connectionId]
      : undefined;
  const connectionReason = connection?.lastSocketDisconnectReason;
  const globalReason = snapshot?.lastSocketDisconnectReason;
  // A connection-local marker is authoritative. Falling back to a global marker
  // when this connection already has status lets another socket's refresh leak across connections.
  const reason = connection ? connectionReason : globalReason;
  if (!isExpectedSocketRefresh(reason)) {
    return false;
  }

  const patch: Record<string, unknown> = {};
  if (connection && connections && typeof connections === "object" && !Array.isArray(connections)) {
    patch.socketConnections = {
      ...(connections as Record<string, Record<string, unknown>>),
      [connectionId]: {
        ...connection,
        lastSocketDisconnectReason: null,
      },
    };
  }
  if (!connection || isSameSocketDisconnectReason(globalReason, reason)) {
    patch.lastSocketDisconnectReason = null;
  }
  params.setStatus?.(patch);
  return true;
}

function resolveSlackSocketDiagnosticDisconnect(
  accountId: string,
): SlackSocketDiagnosticDisconnect | undefined {
  const text = process.env.OPENCLAW_SLACK_DIAGNOSTIC_DISCONNECT?.trim();
  if (!text) {
    return undefined;
  }
  const [configuredAccountId, connectionId, delayMs, reason] = text.split(":");
  const parsedDelayMs = Number(delayMs);
  if (
    !connectionId?.trim() ||
    !Number.isFinite(parsedDelayMs) ||
    parsedDelayMs < 0 ||
    !reason?.trim() ||
    (configuredAccountId?.trim() && configuredAccountId.trim() !== accountId)
  ) {
    return undefined;
  }
  return {
    accountId: configuredAccountId?.trim() || undefined,
    connectionId: connectionId.trim(),
    delayMs: Math.trunc(parsedDelayMs),
    reason: reason.trim(),
  };
}

function formatSlackSocketReconnectMessage(params: {
  event: string;
  attempt: number;
  delayMs: number;
  error?: unknown;
}) {
  const suffix = params.error ? ` (${formatUnknownError(params.error)})` : "";
  return `slack socket disconnected (${params.event}); reconnecting in ${Math.round(params.delayMs / 1000)}s (attempt ${params.attempt}/∞)${suffix}`;
}

function formatSlackSocketStartRetryMessage(params: {
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
  const enterpriseOrgInstall = account.config.enterpriseOrgInstall === true;
  if (enterpriseOrgInstall && slackMode === "relay") {
    throw new Error(
      `Slack Enterprise Grid org account "${account.accountId}" requires direct socket or HTTP delivery; relay mode is unsupported`,
    );
  }
  if (enterpriseOrgInstall && account.config.execApprovals?.enabled === true) {
    throw new Error(
      `Slack Enterprise Grid org account "${account.accountId}" does not support Slack-native exec approvals`,
    );
  }
  if (enterpriseOrgInstall) {
    assertEnterpriseSlackPolicyConfig({ config: account.config, accountId: account.accountId });
    assertNoEnterpriseSlackBindings({ cfg, accountId: account.accountId });
  }
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
  if (enterpriseOrgInstall) {
    assertEnterpriseSlackDmPolicy({
      accountId: account.accountId,
      dmEnabled,
      dmPolicy,
      allowFrom,
    });
  }
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
  const lifecycleStatusSnapshot: Record<string, unknown> = {};
  const setLifecycleStatus = opts.setStatus
    ? (patch: Record<string, unknown>) => {
        Object.assign(lifecycleStatusSnapshot, patch);
        opts.setStatus?.(patch);
      }
    : undefined;
  // Runtime-provided readback remains authoritative. The local snapshot only
  // backs supported setStatus-only integrations and is shared with raw socket telemetry.
  const getLifecycleStatus =
    opts.getStatus ?? (setLifecycleStatus ? () => lifecycleStatusSnapshot : undefined);
  const trackTelemetry = setLifecycleStatus
    ? (counter: SlackStatusCounter) => {
        setLifecycleStatus({
          slackTelemetry: incrementSlackStatusCounterSnapshot({
            snapshot: getLifecycleStatus?.(),
            counter,
          }),
        });
      }
    : undefined;
  const interop = await getSlackBoltInterop();
  const createSocketRuntime = (connectionId: string): SlackSocketRuntime => ({
    ...createSlackBoltApp({
      interop,
      slackMode,
      botToken,
      appToken: slackMode === "socket" ? (appToken ?? undefined) : undefined,
      signingSecret: slackMode === "http" ? (signingSecret ?? undefined) : undefined,
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
    connectionId,
    expectedRefreshPending: false,
  });
  const socketRuntimes: SlackSocketRuntime[] = [createSocketRuntime("primary")];
  const socketConnectionCount =
    slackMode === "socket"
      ? resolveSlackSocketConnectionCount(slackCfg.socketMode?.connectionCount)
      : 1;
  for (let index = 1; index < socketConnectionCount; index += 1) {
    socketRuntimes.push(createSocketRuntime(`socket-${index + 1}`));
  }
  const primarySocket = socketRuntimes[0]!;
  const { app, receiver } = primarySocket;
  const diagnosticDisconnect =
    slackMode === "socket" ? resolveSlackSocketDiagnosticDisconnect(account.accountId) : undefined;
  setLifecycleStatus?.({
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
            setLifecycleStatus,
            getLifecycleStatus,
            {
              connectionId: socketRuntime.connectionId,
              onExpectedRefresh: () => {
                socketRuntime.expectedRefreshPending = true;
              },
            },
          ),
        )
      : [];

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
  const expectedApiAppIdFromAppToken =
    slackMode === "socket" ? parseApiAppIdFromAppToken(appToken) : undefined;
  const installationIdentity = resolveSlackInstallationIdentity({
    enterpriseOrgInstall,
    transportApiAppId: expectedApiAppIdFromAppToken,
  });

  const ctx = createSlackMonitorContext({
    cfg,
    accountId: account.accountId,
    botToken,
    app,
    runtime,
    channelRuntime: opts.channelRuntime,
    botUserId: "",
    botId: "",
    teamId: installationIdentity.kind === "workspace" ? installationIdentity.teamId : "",
    apiAppId: installationIdentity.kind === "degraded" ? "" : (installationIdentity.apiAppId ?? ""),
    installationIdentity,
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

  // Slack's socket-mode client keeps ping/pong health private and closes on
  // missed pongs. App events are useful status activity, but not transport proof.
  const trackEvent = setLifecycleStatus
    ? () => {
        setLifecycleStatus({ lastEventAt: Date.now(), lastInboundAt: Date.now() });
      }
    : undefined;

  const baseHandleSlackMessage = createSlackMessageHandler({ ctx, account, trackEvent });
  // Metadata hydration enables explicit mention detection and reconciliation, but
  // ordinary inbound dispatch must stay live while Slack auth is slow or unavailable.
  // Empty bot identity keeps required-mention message events fail closed meanwhile.
  const handleSlackMessage = baseHandleSlackMessage;
  const monitorContexts = socketRuntimes.map((socketRuntime) =>
    socketRuntime.app === ctx.app ? ctx : { ...ctx, app: socketRuntime.app },
  );
  let monitorDisposed = false;
  let authMetadataHydrationStarted = false;
  let authMetadataRetryTimer: NodeJS.Timeout | undefined;
  let enterpriseAuthMetadataRetryAttempts = 0;
  let reconciliationStarted = false;
  let stopReconciliation: (() => void) | undefined;
  const startReconciliation = () => {
    if (
      monitorDisposed ||
      opts.abortSignal?.aborted ||
      reconciliationStarted ||
      enterpriseOrgInstall
    ) {
      return;
    }
    reconciliationStarted = true;
    stopReconciliation = startSlackHistoryReconciliation({
      ctx,
      accountId: account.accountId,
      config: slackCfg.reconciliation,
      accountAllowBots: slackCfg.allowBots,
      handleSlackMessage,
      setStatus: setLifecycleStatus,
      abortSignal: opts.abortSignal,
    }).stop;
  };
  const scheduleAuthMetadataHydrationRetry = (reason: string) => {
    if (monitorDisposed || opts.abortSignal?.aborted || authMetadataRetryTimer) {
      return;
    }
    let retryDelayMs = SLACK_AUTH_METADATA_RETRY_MS;
    if (enterpriseOrgInstall) {
      enterpriseAuthMetadataRetryAttempts += 1;
      retryDelayMs = Math.min(
        SLACK_ENTERPRISE_AUTH_METADATA_MAX_RETRY_MS,
        SLACK_AUTH_METADATA_RETRY_MS * 2 ** Math.min(4, enterpriseAuthMetadataRetryAttempts - 1),
      );
    } else if (reconciliationStarted) {
      return;
    }
    authMetadataHydrationStarted = false;
    runtime.log?.(
      enterpriseOrgInstall
        ? `enterprise slack installation identity unavailable (${reason}); retry ${enterpriseAuthMetadataRetryAttempts}/∞ in ${retryDelayMs}ms`
        : `slack auth metadata missing; mention detection remains fail closed until bot identity is available (${reason}); retrying in ${SLACK_AUTH_METADATA_RETRY_MS}ms`,
    );
    authMetadataRetryTimer = setTimeout(() => {
      authMetadataRetryTimer = undefined;
      startAuthMetadataHydration();
    }, retryDelayMs);
    authMetadataRetryTimer.unref?.();
  };
  const startAuthMetadataHydration = () => {
    if (monitorDisposed || opts.abortSignal?.aborted || authMetadataHydrationStarted) {
      return;
    }
    authMetadataHydrationStarted = true;
    void (async () => {
      const finishAuthStep = startSlackStartupStepTimer(runtime, "auth.test");
      let retryReason: string | undefined;
      try {
        const auth = await app.client.auth.test();
        // auth.test is intentionally detached so inbound startup stays live. Its
        // continuation must not revive metadata or reconciliation after teardown.
        if (monitorDisposed || opts.abortSignal?.aborted) {
          return;
        }
        const authUserId = normalizeOptionalString(auth.user_id) ?? "";
        const botId = normalizeOptionalString((auth as { bot_id?: string }).bot_id) ?? "";
        if (!enterpriseOrgInstall) {
          const identityWarning = formatSlackBotTokenIdentityWarning({
            auth,
            accountId: account.accountId,
          });
          if (identityWarning) {
            runtime.log?.(warn(identityWarning));
          }
        }
        if (!enterpriseOrgInstall && !authUserId) {
          retryReason = "auth.test returned no user_id";
          throw new Error(retryReason);
        }
        const hydratedIdentity = resolveSlackInstallationIdentity({
          enterpriseOrgInstall,
          auth,
          transportApiAppId: expectedApiAppIdFromAppToken,
        });
        if (enterpriseOrgInstall && hydratedIdentity.kind === "degraded") {
          retryReason = hydratedIdentity.reason;
          throw new Error(retryReason);
        }
        const teamId = hydratedIdentity.kind === "workspace" ? hydratedIdentity.teamId : "";
        const apiAppId =
          hydratedIdentity.kind === "degraded" ? "" : (hydratedIdentity.apiAppId ?? "");
        for (const monitorContext of monitorContexts) {
          monitorContext.botUserId = botId ? authUserId : "";
          monitorContext.botId = botId;
          monitorContext.teamId = teamId;
          monitorContext.apiAppId = apiAppId;
          monitorContext.installationIdentity = hydratedIdentity;
        }
        startReconciliation();
      } catch (err) {
        if (monitorDisposed || opts.abortSignal?.aborted) {
          return;
        }
        retryReason ??= formatUnknownError(err);
        runtime.log?.(
          warn(
            enterpriseOrgInstall
              ? `[${account.accountId}] enterprise slack auth.test failed during background identity hydration (${retryReason}); ` +
                  "continuing with degraded installation identity until credentials or Slack recover"
              : `[${account.accountId}] slack auth.test failed at boot (${retryReason}); ` +
                  "explicit bot-mention detection will be disabled until valid bot metadata is available; " +
                  "required-mention channels will fail closed without another trusted activation signal",
          ),
        );
        scheduleAuthMetadataHydrationRetry(retryReason);
      } finally {
        finishAuthStep();
      }
    })();
  };
  startAuthMetadataHydration();
  if (
    !enterpriseOrgInstall &&
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

  // Resolve command registration first so App Home never advertises an inactive single command.
  for (const monitorContext of monitorContexts) {
    const commandRegistration = enterpriseOrgInstall
      ? ({ mode: "disabled" } as const)
      : await registerSlackMonitorSlashCommands({ ctx: monitorContext, account, trackEvent });
    registerSlackMonitorEvents({
      ctx: monitorContext,
      account,
      handleSlackMessage,
      enterpriseOrgInstall,
      appHomeSlashCommandName:
        commandRegistration.mode === "single" ? commandRegistration.name : undefined,
      trackEvent,
      trackTelemetry,
    });
  }
  if (slackMode === "http" && slackHttpHandler) {
    unregisterHttpHandler = registerSlackHttpHandler({
      path: slackWebhookPath,
      handler: slackHttpHandler,
      log: runtime.log,
      accountId: account.accountId,
    });
  }

  if (resolveToken && installationIdentity.kind !== "enterprise") {
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
              const resolvedLabel = formatSlackChannelResolved(entry);
              if (resolvedLabel) {
                mapping.push(resolvedLabel);
              }
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
  }

  const socketUnhandledRejectionGuard = createSlackSocketUnhandledRejectionGuard();
  const unregisterUnhandledRejectionHandler = registerUnhandledRejectionHandler((reason) => {
    if (slackMode !== "socket") {
      return false;
    }
    const socketFaultMessage = socketUnhandledRejectionGuard.consumeFault(reason);
    if (!socketFaultMessage) {
      return false;
    }
    runtime.error?.(
      `slack socket mode suppressed correlated unhandled rejection after recoverable transport fault (${socketFaultMessage})`,
    );
    return true;
  });

  const socketRunAbortController = new AbortController();
  const stopOnAbort = () => {
    socketRunAbortController.abort();
    if (slackMode === "socket") {
      void gracefulStop();
    }
  };
  if (opts.abortSignal?.aborted) {
    stopOnAbort();
  } else {
    opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });
  }

  try {
    if (slackMode === "socket") {
      const runSocketConnection = async (socketRuntime: SlackSocketRuntime) => {
        let reconnectAttempts = 0;
        let hasLoggedSocketConnected = false;
        let diagnosticDisconnectArmed = false;
        while (!socketRunAbortController.signal.aborted) {
          try {
            const finishSocketStart = startSlackStartupStepTimer(
              runtime,
              `socket start ${socketRuntime.connectionId}`,
            );
            const disconnect = await startSlackSocketAndWaitForDisconnect({
              app: socketRuntime.app,
              abortSignal: socketRunAbortController.signal,
              onStarted: () => {
                finishSocketStart();
                reconnectAttempts = 0;
                publishSlackConnectedStatus(setLifecycleStatus);
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
            if (!disconnect || socketRunAbortController.signal.aborted) {
              break;
            }
            socketUnhandledRejectionGuard.noteFault(disconnect.error);
            publishSlackSocketConnectionDisconnectedStatus({
              receiver: socketRuntime.receiver,
              setStatus: setLifecycleStatus,
              getStatus: getLifecycleStatus,
              connectionId: socketRuntime.connectionId,
              error: disconnect.error,
            });
            if (disconnect.error && isNonRecoverableSlackAuthError(disconnect.error)) {
              runtime.error?.(
                `slack socket mode disconnected due to non-recoverable auth error — skipping channel (${formatUnknownError(disconnect.error)})`,
              );
              throw disconnect.error instanceof Error
                ? disconnect.error
                : new Error(formatUnknownError(disconnect.error));
            }
            const expectedRefreshFromRuntime = socketRuntime.expectedRefreshPending;
            socketRuntime.expectedRefreshPending = false;
            const expectedRefreshFromStatus = consumeExpectedSocketRefresh({
              snapshot: getLifecycleStatus?.(),
              connectionId: socketRuntime.connectionId,
              setStatus: setLifecycleStatus,
            });
            const expectedRefresh = expectedRefreshFromRuntime || expectedRefreshFromStatus;
            reconnectAttempts = expectedRefresh ? 0 : reconnectAttempts + 1;
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
                      delayMs,
                      error: disconnect.error,
                    }),
              ),
            );
            await gracefulStopSlackApp(socketRuntime.app);
            try {
              await sleepWithAbort(delayMs, socketRunAbortController.signal);
            } catch {
              break;
            }
          } catch (err) {
            socketUnhandledRejectionGuard.noteFault(err);
            if (isNonRecoverableSlackAuthError(err)) {
              runtime.error?.(
                `slack socket mode failed to start due to non-recoverable auth error — skipping channel (${formatUnknownError(err)})`,
              );
              throw err;
            }
            reconnectAttempts += 1;
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
              await sleepWithAbort(delayMs, socketRunAbortController.signal);
            } catch {
              break;
            }
          }
        }
      };
      const socketRuns = socketRuntimes.map(async (socketRuntime) => {
        try {
          await runSocketConnection(socketRuntime);
        } catch (error) {
          // One terminal connection failure retires the whole monitor. Cancel
          // sibling waiters before propagating so they cannot outlive teardown.
          socketRunAbortController.abort();
          await gracefulStop();
          throw error;
        }
      });
      const socketResults = await Promise.allSettled(socketRuns);
      const failedSocket = socketResults.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failedSocket) {
        throw failedSocket.reason;
      }
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
        setStatus: setLifecycleStatus,
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
    monitorDisposed = true;
    if (slackMode === "relay") {
      setSlackDefaultSendIdentity(account.accountId, undefined);
    }
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
    for (const dispose of socketObserverDisposers) {
      dispose();
    }
    if (authMetadataRetryTimer) {
      clearTimeout(authMetadataRetryTimer);
    }
    unregisterUnhandledRejectionHandler();
    stopReconciliation?.();
    unregisterHttpHandler?.();
    await gracefulStop();
  }
}

export const resolveSlackRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
