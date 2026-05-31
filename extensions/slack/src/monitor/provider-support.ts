// Slack provider module implements model/runtime integration.
import { asOptionalRecord as asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackChannelResolution } from "../resolve-channels.js";
import type { SlackUserResolution } from "../resolve-users.js";
import { formatUnknownError, waitForSlackSocketDisconnect } from "./reconnect-policy.js";

type SlackAppConstructor = typeof import("@slack/bolt").App;
type SlackHttpReceiverConstructor = typeof import("@slack/bolt").HTTPReceiver;
type SlackReceiver = import("@slack/bolt").Receiver;
type SlackSocketModeReceiverConstructor = typeof import("@slack/bolt").SocketModeReceiver;
type SlackSocketModeReceiverOptions = ConstructorParameters<SlackSocketModeReceiverConstructor>[0];
type SlackSocketModeConfig = Pick<
  SlackSocketModeReceiverOptions,
  "clientPingTimeout" | "serverPingTimeout" | "pingPongLoggingEnabled"
>;
type SlackSdkLogger = NonNullable<SlackSocketModeReceiverOptions["logger"]>;
type SlackSdkLogLevel = ReturnType<SlackSdkLogger["getLevel"]>;
type SlackSocketModeLogger = SlackSdkLogger & {
  getLastMessage: () => string | undefined;
};
type SlackSocketDisconnect = Awaited<ReturnType<typeof waitForSlackSocketDisconnect>>;
type SlackSocketModeClientEvent =
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "disconnected"
  | "error"
  | "ws_message"
  | "slack_event";
type SlackSocketModeObservableClient = {
  on?: (event: SlackSocketModeClientEvent, listener: (...args: unknown[]) => void) => unknown;
};
type SlackSocketModeDiagnosticClient = SlackSocketModeObservableClient & {
  emit?: (event: string, ...args: unknown[]) => unknown;
};
export type SlackSocketModeEffectiveSettings = {
  clientPingTimeout: number;
  connectionCount: number;
  serverPingTimeout?: number;
  pingPongLoggingEnabled?: boolean;
};
export type SlackSocketActiveState = "active" | "inactive" | "unknown";
export type SlackSocketDisconnectKind =
  | "refresh"
  | "link-disabled"
  | "network"
  | "auth"
  | "unknown";
export type SlackStatusCounter =
  | "rawSocketEnvelopes"
  | "rawSlackEvents"
  | "messageEvents"
  | "droppedEvents"
  | "droppedAppMismatches"
  | "droppedTeamMismatches"
  | "droppedSelfBotEvents"
  | "droppedPolicyEvents"
  | "preparedForDispatch"
  | "admissionsRecorded"
  | "dispatchFailures";

const OPENCLAW_SLACK_CLIENT_PING_TIMEOUT_MS = 15_000;
const OPENCLAW_SLACK_SOCKET_START_FAILED_EVENT = "unable_to_socket_mode_start";
const OPENCLAW_SLACK_NATIVE_RECONNECT_OBSERVER_KEY = "__openclawNativeReconnectFailureObserver";
const OPENCLAW_SLACK_EXPECTED_REFRESH_KEY = "__openclawExpectedSocketRefresh";
const SLACK_SOCKET_PONG_TIMEOUT_WARNING_PREFIX = "A pong wasn't received from the server";
const SLACK_SOCKET_PING_TIMEOUT_WARNING_PREFIX = "A ping wasn't received from the server";
const SLACK_SOCKET_LOG_LEVEL_IGNORED_WARNING_RE =
  /^The logLevel given to .+ was ignored as you also gave logger$/;

export function resolveSlackSocketModeEffectiveSettings(params: {
  socketMode?: SlackSocketModeConfig & { connectionCount?: number };
  connectionCount: number;
}): SlackSocketModeEffectiveSettings {
  return {
    clientPingTimeout:
      params.socketMode?.clientPingTimeout ?? OPENCLAW_SLACK_CLIENT_PING_TIMEOUT_MS,
    connectionCount: params.connectionCount,
    ...(params.socketMode?.serverPingTimeout !== undefined
      ? { serverPingTimeout: params.socketMode.serverPingTimeout }
      : {}),
    ...(params.socketMode?.pingPongLoggingEnabled !== undefined
      ? { pingPongLoggingEnabled: params.socketMode.pingPongLoggingEnabled }
      : {}),
  };
}
const SLACK_SOCKET_EXPECTED_REFRESH_RE = /^(?:warning|refresh_requested)$/i;
const SLACK_SOCKET_LINK_DISABLED_RE = /^link_disabled$/i;
const SLACK_SOCKET_NETWORK_REASON_RE = /network|timeout|disconnect|server|maintenance|restart/i;

export type SlackBoltResolvedExports = {
  App: SlackAppConstructor;
  HTTPReceiver: SlackHttpReceiverConstructor;
  SocketModeReceiver: SlackSocketModeReceiverConstructor;
};

type SlackSocketShutdownClient = {
  shuttingDown?: boolean;
};
type Constructor = abstract new (...args: never[]) => unknown;
type SlackSelfFilterArgs = {
  context?: {
    botId?: string;
    botUserId?: string;
  };
  event?: unknown;
  message?: unknown;
};

function isConstructorFunction<
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Constructor guard preserves the requested concrete Slack constructor type.
  T extends Constructor,
>(value: unknown): value is T {
  return typeof value === "function";
}

function installSlackNativeReconnectFailureObserver(receiver: unknown) {
  if (!receiver || typeof receiver !== "object") {
    return;
  }
  const client = Reflect.get(receiver, "client");
  if (!client || typeof client !== "object") {
    return;
  }
  if (Reflect.get(client, OPENCLAW_SLACK_NATIVE_RECONNECT_OBSERVER_KEY)) {
    return;
  }
  const delayReconnectAttempt = Reflect.get(client, "delayReconnectAttempt");
  const emit = Reflect.get(client, "emit");
  if (typeof delayReconnectAttempt !== "function" || typeof emit !== "function") {
    return;
  }

  Reflect.set(client, OPENCLAW_SLACK_NATIVE_RECONNECT_OBSERVER_KEY, true);
  Reflect.set(
    client,
    "emit",
    function patchedEmit(this: object, event: unknown, ...args: unknown[]) {
      if (event === "ws_message") {
        const disconnectReason = readSlackSocketDisconnectReason(args[0]);
        if (classifySlackSocketDisconnectReason(disconnectReason).expectedRefresh) {
          Reflect.set(this, OPENCLAW_SLACK_EXPECTED_REFRESH_KEY, true);
        }
      }
      return emit.call(this, event, ...args);
    },
  );
  Reflect.set(
    client,
    "delayReconnectAttempt",
    function patchedDelayReconnectAttempt(this: object, callback: unknown) {
      if (typeof callback !== "function") {
        return delayReconnectAttempt.call(this, callback);
      }
      const expectedRefresh = Reflect.get(this, OPENCLAW_SLACK_EXPECTED_REFRESH_KEY) === true;
      Reflect.set(this, OPENCLAW_SLACK_EXPECTED_REFRESH_KEY, false);
      const failureCount = Number(Reflect.get(this, "numOfConsecutiveReconnectionFailures") ?? 0);
      const nextFailureCount = expectedRefresh ? 0 : failureCount + 1;
      Reflect.set(this, "numOfConsecutiveReconnectionFailures", nextFailureCount);
      const pingTimeoutMs = Number(Reflect.get(this, "clientPingTimeoutMS"));
      const delayMs = expectedRefresh
        ? 0
        : (Number.isFinite(pingTimeoutMs) && pingTimeoutMs >= 0
            ? pingTimeoutMs
            : OPENCLAW_SLACK_CLIENT_PING_TIMEOUT_MS) * nextFailureCount;
      const logger = Reflect.get(this, "logger") as { debug?: (message: string) => void };
      logger?.debug?.(
        `Before trying to reconnect, this client will wait for ${delayMs} milliseconds`,
      );
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (Reflect.get(this, "shuttingDown")) {
            logger?.debug?.("Client shutting down, will not attempt reconnect.");
            resolve(undefined);
            return;
          }
          logger?.debug?.("Continuing with reconnect...");
          emit.call(this, "reconnecting");
          Promise.resolve(callback.call(this)).then(resolve, (error: unknown) => {
            if (callback === Reflect.get(this, "start")) {
              emit.call(this, OPENCLAW_SLACK_SOCKET_START_FAILED_EVENT, error);
              resolve(undefined);
              return;
            }
            reject(toLintErrorObject(error, "Non-Error rejection"));
          });
        }, delayMs);
      });
    },
  );
}

function createSlackRelayReceiver(): SlackReceiver {
  return {
    init() {},
    start: () => Promise.resolve(undefined),
    stop: () => Promise.resolve(undefined),
  };
}

function resolveSlackBoltModule(value: unknown): SlackBoltResolvedExports | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const app = Reflect.get(value, "App");
  const httpReceiver = Reflect.get(value, "HTTPReceiver");
  const socketModeReceiver = Reflect.get(value, "SocketModeReceiver");
  if (
    !isConstructorFunction<SlackAppConstructor>(app) ||
    !isConstructorFunction<SlackHttpReceiverConstructor>(httpReceiver) ||
    !isConstructorFunction<SlackSocketModeReceiverConstructor>(socketModeReceiver)
  ) {
    return null;
  }
  return {
    App: app,
    HTTPReceiver: httpReceiver,
    SocketModeReceiver: socketModeReceiver,
  };
}

export function resolveSlackBoltInterop(params: {
  defaultImport: unknown;
  namespaceImport: unknown;
}): SlackBoltResolvedExports {
  const { defaultImport, namespaceImport } = params;
  const nestedDefault =
    defaultImport && typeof defaultImport === "object"
      ? Reflect.get(defaultImport, "default")
      : undefined;
  const namespaceDefault =
    namespaceImport && typeof namespaceImport === "object"
      ? Reflect.get(namespaceImport, "default")
      : undefined;
  const namespaceReceiver =
    namespaceImport && typeof namespaceImport === "object"
      ? Reflect.get(namespaceImport, "HTTPReceiver")
      : undefined;
  const namespaceSocketModeReceiver =
    namespaceImport && typeof namespaceImport === "object"
      ? Reflect.get(namespaceImport, "SocketModeReceiver")
      : undefined;
  const directModule =
    resolveSlackBoltModule(defaultImport) ??
    resolveSlackBoltModule(nestedDefault) ??
    resolveSlackBoltModule(namespaceDefault) ??
    resolveSlackBoltModule(namespaceImport);
  if (directModule) {
    return directModule;
  }
  if (
    isConstructorFunction<SlackAppConstructor>(defaultImport) &&
    isConstructorFunction<SlackHttpReceiverConstructor>(namespaceReceiver) &&
    isConstructorFunction<SlackSocketModeReceiverConstructor>(namespaceSocketModeReceiver)
  ) {
    return {
      App: defaultImport,
      HTTPReceiver: namespaceReceiver,
      SocketModeReceiver: namespaceSocketModeReceiver,
    };
  }
  throw new TypeError("Unable to resolve @slack/bolt App/HTTPReceiver exports");
}

export function publishSlackConnectedStatus(setStatus?: (next: Record<string, unknown>) => void) {
  if (!setStatus) {
    return;
  }
  const now = Date.now();
  setStatus({
    connected: true,
    lastConnectedAt: now,
    lastTransportActivityAt: null,
    lastSocketError: null,
    lastSocketDisconnectedAt: null,
    lastSocketReconnectAt: null,
    healthState: "healthy",
    lastError: null,
  });
}

export function publishSlackDisconnectedStatus(
  setStatus?: (next: Record<string, unknown>) => void,
  error?: unknown,
) {
  if (!setStatus) {
    return;
  }
  const at = Date.now();
  const message = error ? formatUnknownError(error) : undefined;
  setStatus({
    connected: false,
    healthState: "disconnected",
    lastDisconnect: message ? { at, error: message } : { at },
    lastError: message ?? null,
  });
}

function resolveSlackSocketModeClient(receiver: unknown): SlackSocketModeObservableClient | null {
  if (!receiver || typeof receiver !== "object") {
    return null;
  }
  const client = Reflect.get(receiver, "client");
  if (!client || typeof client !== "object") {
    return null;
  }
  const on = Reflect.get(client, "on");
  return typeof on === "function" ? (client as SlackSocketModeObservableClient) : null;
}

function resolveSlackSocketActiveState(receiver: unknown): {
  state: SlackSocketActiveState;
  available: boolean;
} {
  if (!receiver || typeof receiver !== "object") {
    return { state: "unknown", available: false };
  }
  const client = Reflect.get(receiver, "client");
  if (!client || typeof client !== "object") {
    return { state: "unknown", available: false };
  }
  const websocket = Reflect.get(client, "websocket");
  if (!websocket || typeof websocket !== "object") {
    return { state: "inactive", available: true };
  }
  const isActive = Reflect.get(websocket, "isActive");
  if (typeof isActive === "function") {
    try {
      return {
        state: isActive.call(websocket) ? "active" : "inactive",
        available: true,
      };
    } catch {
      return { state: "unknown", available: false };
    }
  }
  const readyState = Reflect.get(websocket, "readyState");
  if (typeof readyState === "number" && Number.isFinite(readyState)) {
    return { state: readyState === 1 ? "active" : "inactive", available: true };
  }
  return { state: "unknown", available: false };
}

export function classifySlackSocketDisconnectReason(reason: unknown): {
  reason?: string;
  kind: SlackSocketDisconnectKind;
  expectedRefresh: boolean;
} {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) {
    return { kind: "unknown", expectedRefresh: false };
  }
  if (SLACK_SOCKET_EXPECTED_REFRESH_RE.test(text)) {
    return { reason: text, kind: "refresh", expectedRefresh: true };
  }
  if (SLACK_SOCKET_LINK_DISABLED_RE.test(text)) {
    return { reason: text, kind: "link-disabled", expectedRefresh: false };
  }
  if (isNonRecoverableAuthReason(text)) {
    return { reason: text, kind: "auth", expectedRefresh: false };
  }
  if (SLACK_SOCKET_NETWORK_REASON_RE.test(text)) {
    return { reason: text, kind: "network", expectedRefresh: false };
  }
  return { reason: text, kind: "unknown", expectedRefresh: false };
}

function isNonRecoverableAuthReason(reason: string): boolean {
  return /account_inactive|invalid_auth|token_revoked|token_expired|not_authed|missing_scope/i.test(
    reason,
  );
}

function mergeSocketConnectionStatus(params: {
  snapshot?: Record<string, unknown>;
  connectionId: string;
  patch: Record<string, unknown>;
}): Record<string, Record<string, unknown>> {
  const current = params.snapshot?.socketConnections;
  const connections =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, Record<string, unknown>>) }
      : {};
  const existing = connections[params.connectionId];
  connections[params.connectionId] = {
    ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}),
    ...params.patch,
  };
  return connections;
}

function summarizeSocketConnections(connections: Record<string, Record<string, unknown>>): {
  connected: boolean;
  healthState: "healthy" | "reconnecting" | "disconnecting" | "disconnected";
  socketActiveState: SlackSocketActiveState;
  socketActiveStateAvailable: boolean;
  socketConnectionCount: number;
} {
  const entries = Object.values(connections);
  const hasActive = entries.some((entry) => entry.socketActiveState === "active");
  const hasKnown = entries.some((entry) => entry.socketActiveStateAvailable === true);
  const connected = entries.some((entry) => entry.connected === true) || hasActive;
  const hasReconnecting = entries.some((entry) => entry.healthState === "reconnecting");
  const hasDisconnecting = entries.some((entry) => entry.healthState === "disconnecting");
  return {
    connected,
    healthState: connected
      ? "healthy"
      : hasReconnecting
        ? "reconnecting"
        : hasDisconnecting
          ? "disconnecting"
          : "disconnected",
    socketActiveState: hasActive ? "active" : hasKnown ? "inactive" : "unknown",
    socketActiveStateAvailable: hasKnown,
    socketConnectionCount: entries.length,
  };
}

function publishSocketConnectionPatch(params: {
  receiver: unknown;
  setStatus: (next: Record<string, unknown>) => void;
  getStatus?: () => Record<string, unknown>;
  connectionId: string;
  patch: Record<string, unknown>;
}) {
  const activeState = resolveSlackSocketActiveState(params.receiver);
  const connections = mergeSocketConnectionStatus({
    snapshot: params.getStatus?.(),
    connectionId: params.connectionId,
    patch: {
      ...params.patch,
      socketActiveState: activeState.state,
      socketActiveStateAvailable: activeState.available,
    },
  });
  params.setStatus({
    ...summarizeSocketConnections(connections),
    socketConnections: connections,
  });
}

function publishSlackSocketLifecycleStatus(
  setStatus: (next: Record<string, unknown>) => void,
  receiver: unknown,
  getStatus: (() => Record<string, unknown>) | undefined,
  connectionId: string,
  event: "connected" | "reconnecting" | "disconnecting" | "disconnected",
) {
  const at = Date.now();
  if (event === "connected") {
    publishSocketConnectionPatch({
      receiver,
      setStatus,
      getStatus,
      connectionId,
      patch: {
        connected: true,
        lastSocketConnectedAt: at,
        lastSocketError: null,
        lastSocketDisconnectedAt: null,
        lastSocketReconnectAt: null,
        healthState: "healthy",
      },
    });
    setStatus({
      lastSocketConnectedAt: at,
      lastSocketError: null,
      lastSocketDisconnectedAt: null,
      lastSocketReconnectAt: null,
      lastError: null,
    });
    return;
  }
  if (event === "reconnecting") {
    publishSocketConnectionPatch({
      receiver,
      setStatus,
      getStatus,
      connectionId,
      patch: {
        lastSocketReconnectAt: at,
        healthState: "reconnecting",
      },
    });
    setStatus({
      lastSocketReconnectAt: at,
    });
    return;
  }
  publishSocketConnectionPatch({
    receiver,
    setStatus,
    getStatus,
    connectionId,
    patch: {
      connected: false,
      lastSocketDisconnectedAt: at,
      healthState: event === "disconnecting" ? "disconnecting" : "disconnected",
    },
  });
  setStatus({
    lastSocketDisconnectedAt: at,
  });
}

export function publishSlackSocketConnectionDisconnectedStatus(params: {
  receiver: unknown;
  setStatus?: (next: Record<string, unknown>) => void;
  getStatus?: () => Record<string, unknown>;
  connectionId: string;
  error?: unknown;
}) {
  if (!params.setStatus) {
    return;
  }
  const at = Date.now();
  const message = params.error ? formatUnknownError(params.error) : undefined;
  publishSocketConnectionPatch({
    receiver: params.receiver,
    setStatus: params.setStatus,
    getStatus: params.getStatus,
    connectionId: params.connectionId,
    patch: {
      connected: false,
      healthState: "disconnected",
      lastSocketDisconnectedAt: at,
      lastDisconnect: message ? { at, error: message } : { at },
    },
  });
  params.setStatus({
    lastSocketDisconnectedAt: at,
    lastDisconnect: message ? { at, error: message } : { at },
    ...(message ? { lastError: message } : {}),
  });
}

function publishSlackSocketErrorStatus(
  setStatus: (next: Record<string, unknown>) => void,
  error: unknown,
) {
  const at = Date.now();
  const message = formatUnknownError(error);
  setStatus({
    lastSocketError: { at, error: message },
    lastError: message,
  });
}

export function installSlackSocketModeStatusObserver(
  receiver: unknown,
  setStatus?: (next: Record<string, unknown>) => void,
  getStatus?: () => Record<string, unknown>,
  opts?: { connectionId?: string; activeProbeIntervalMs?: number },
): () => void {
  if (!setStatus) {
    return () => {};
  }
  const client = resolveSlackSocketModeClient(receiver);
  if (!client?.on) {
    setStatus({
      socketActiveState: "unknown",
      socketActiveStateAvailable: false,
    });
    return () => {};
  }
  const connectionId = opts?.connectionId ?? "primary";
  const listeners: Array<[SlackSocketModeClientEvent, (...args: unknown[]) => void]> = [];
  const on = (event: SlackSocketModeClientEvent, listener: (...args: unknown[]) => void) => {
    listeners.push([event, listener]);
    client.on?.(event, listener);
  };

  on("connected", () =>
    publishSlackSocketLifecycleStatus(setStatus, receiver, getStatus, connectionId, "connected"),
  );
  on("reconnecting", () =>
    publishSlackSocketLifecycleStatus(setStatus, receiver, getStatus, connectionId, "reconnecting"),
  );
  on("disconnecting", () =>
    publishSlackSocketLifecycleStatus(
      setStatus,
      receiver,
      getStatus,
      connectionId,
      "disconnecting",
    ),
  );
  on("disconnected", () =>
    publishSlackSocketLifecycleStatus(setStatus, receiver, getStatus, connectionId, "disconnected"),
  );
  on("error", (error: unknown) => publishSlackSocketErrorStatus(setStatus, error));
  // @slack/socket-mode's SlackWebSocket emits this raw frame event on the
  // client before SocketModeClient normalizes it into higher-level events.
  on("ws_message", (data: unknown) => {
    const at = Date.now();
    const disconnectReason = readSlackSocketDisconnectReason(data);
    let disconnectStatus: Record<string, unknown> | undefined;
    if (disconnectReason) {
      const classified = classifySlackSocketDisconnectReason(disconnectReason);
      disconnectStatus = {
        at,
        ...(classified.reason ? { reason: classified.reason } : {}),
        kind: classified.kind,
        expectedRefresh: classified.expectedRefresh,
      };
      setStatus({
        lastSocketDisconnectReason: disconnectStatus,
        healthState: classified.expectedRefresh ? "reconnecting" : "disconnecting",
      });
    }
    publishSocketConnectionPatch({
      receiver,
      setStatus,
      getStatus,
      connectionId,
      patch: {
        lastSocketEnvelopeAt: at,
        ...(disconnectStatus ? { lastSocketDisconnectReason: disconnectStatus } : {}),
      },
    });
    setStatus({
      slackTelemetry: incrementSlackStatusCounterSnapshot({
        snapshot: getStatus?.(),
        counter: "rawSocketEnvelopes",
      }),
      lastSocketEnvelopeAt: at,
    });
  });
  on("slack_event", () => {
    const at = Date.now();
    publishSocketConnectionPatch({
      receiver,
      setStatus,
      getStatus,
      connectionId,
      patch: {
        lastSlackEventAt: at,
      },
    });
    setStatus({
      slackTelemetry: incrementSlackStatusCounterSnapshot({
        snapshot: getStatus?.(),
        counter: "rawSlackEvents",
      }),
      lastSlackEventAt: at,
    });
  });
  const intervalMs = opts?.activeProbeIntervalMs ?? 30_000;
  const interval =
    intervalMs > 0
      ? setInterval(() => {
          publishSocketConnectionPatch({
            receiver,
            setStatus,
            getStatus,
            connectionId,
            patch: {},
          });
        }, intervalMs)
      : null;
  interval?.unref?.();
  publishSocketConnectionPatch({
    receiver,
    setStatus,
    getStatus,
    connectionId,
    patch: {},
  });
  return () => {
    interval && clearInterval(interval);
    const clientWithOff = client as SlackSocketModeObservableClient & {
      off?: (event: SlackSocketModeClientEvent, listener: (...args: unknown[]) => void) => unknown;
    };
    for (const [event, listener] of listeners) {
      clientWithOff.off?.(event, listener);
    }
  };
}

export function triggerSlackSocketDiagnosticDisconnect(params: {
  receiver: unknown;
  reason?: string;
}): boolean {
  if (!params.receiver || typeof params.receiver !== "object") {
    return false;
  }
  const client = Reflect.get(params.receiver, "client") as SlackSocketModeDiagnosticClient;
  if (!client || typeof client !== "object" || typeof client.emit !== "function") {
    return false;
  }
  const reason = params.reason?.trim() || "refresh_requested";
  client.emit("ws_message", Buffer.from(JSON.stringify({ type: "disconnect", reason })), false);
  return true;
}

function readSlackSocketDisconnectReason(data: unknown): string | undefined {
  const raw = Buffer.isBuffer(data) ? data.toString("utf8") : typeof data === "string" ? data : "";
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; reason?: unknown };
    return parsed.type === "disconnect" && typeof parsed.reason === "string"
      ? parsed.reason
      : undefined;
  } catch {
    return undefined;
  }
}

function readSlackTelemetrySnapshot(
  snapshot: Record<string, unknown> | undefined,
): Record<string, number> {
  const value = snapshot?.slackTelemetry;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = Math.max(0, Math.trunc(raw));
    }
  }
  return out;
}

export function incrementSlackStatusCounterSnapshot(params: {
  snapshot?: Record<string, unknown>;
  counter: SlackStatusCounter;
}): Record<string, number> {
  const next = readSlackTelemetrySnapshot(params.snapshot);
  next[params.counter] = (next[params.counter] ?? 0) + 1;
  return next;
}

function isSlackSocketHeartbeatTimeoutWarning(args: readonly unknown[]) {
  return (
    typeof args[0] === "string" &&
    (args[0].startsWith(SLACK_SOCKET_PONG_TIMEOUT_WARNING_PREFIX) ||
      args[0].startsWith(SLACK_SOCKET_PING_TIMEOUT_WARNING_PREFIX))
  );
}

function isSlackSocketSelfInflictedLoggerWarning(args: readonly unknown[]) {
  return typeof args[0] === "string" && SLACK_SOCKET_LOG_LEVEL_IGNORED_WARNING_RE.test(args[0]);
}

function formatSlackSdkLogArgs(args: readonly unknown[]) {
  return args
    .map((arg) => formatUnknownError(arg, ""))
    .filter(Boolean)
    .join(" ");
}

export function createSlackSocketModeLogger(
  sink: Pick<typeof console, "debug" | "info" | "warn" | "error"> = console,
): SlackSocketModeLogger {
  let level = "info" as SlackSdkLogLevel;
  let name = "socket-mode";
  const prefix = () => `socket-mode:${name}`;
  let lastMessage: string | undefined;
  const remember = (args: readonly unknown[]) => {
    const message = formatSlackSdkLogArgs([prefix(), ...args]);
    if (message) {
      lastMessage = message;
    }
  };
  return {
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      if (
        isSlackSocketHeartbeatTimeoutWarning(args) ||
        isSlackSocketSelfInflictedLoggerWarning(args)
      ) {
        return;
      }
      remember(args);
      sink.warn(prefix(), ...args);
    },
    error: (...args: unknown[]) => {
      remember(args);
      sink.error(prefix(), ...args);
    },
    setLevel: (nextLevel) => {
      level = nextLevel;
    },
    getLevel: () => level,
    setName: (nextName) => {
      name = nextName;
    },
    getLastMessage: () => lastMessage,
  };
}

export function shouldSkipOpenClawSlackSelfEvent(args: SlackSelfFilterArgs): boolean {
  const botId = args.context?.botId;
  const botUserId = args.context?.botUserId;
  const message = asRecord(args.message);
  if (message?.subtype === "bot_message" && botId && message.bot_id === botId) {
    return true;
  }

  const event = asRecord(args.event);
  if (
    event?.type === "message" &&
    event.subtype === "message_changed" &&
    event.user === botUserId
  ) {
    return false;
  }

  const eventsWhichShouldBeKept = new Set(["member_joined_channel", "member_left_channel"]);
  return Boolean(
    botUserId &&
    event &&
    event.user === botUserId &&
    typeof event.type === "string" &&
    !eventsWhichShouldBeKept.has(event.type),
  );
}

export function createSlackBoltApp(params: {
  interop: SlackBoltResolvedExports;
  slackMode: "socket" | "http" | "relay";
  botToken: string;
  appToken?: string;
  signingSecret?: string;
  slackWebhookPath: string;
  clientOptions: Record<string, unknown>;
  socketMode?: SlackSocketModeConfig;
  onSelfEventDropped?: () => void;
}) {
  const socketModeLogger = createSlackSocketModeLogger();
  const socketModeReceiverOptions: SlackSocketModeReceiverOptions = {
    appToken: params.appToken ?? "",
    autoReconnectEnabled: true,
    clientPingTimeout:
      params.socketMode?.clientPingTimeout ?? OPENCLAW_SLACK_CLIENT_PING_TIMEOUT_MS,
    logger: socketModeLogger,
    installerOptions: {
      clientOptions: params.clientOptions,
    },
  };
  if (params.socketMode?.serverPingTimeout !== undefined) {
    socketModeReceiverOptions.serverPingTimeout = params.socketMode.serverPingTimeout;
  }
  if (params.socketMode?.pingPongLoggingEnabled !== undefined) {
    socketModeReceiverOptions.pingPongLoggingEnabled = params.socketMode.pingPongLoggingEnabled;
  }

  let receiver:
    | InstanceType<SlackSocketModeReceiverConstructor>
    | InstanceType<SlackHttpReceiverConstructor>
    | SlackReceiver
    | undefined;
  if (params.slackMode === "socket") {
    receiver = new params.interop.SocketModeReceiver(socketModeReceiverOptions);
    installSlackNativeReconnectFailureObserver(receiver);
  } else if (params.slackMode === "http") {
    receiver = new params.interop.HTTPReceiver({
      signingSecret: params.signingSecret ?? "",
      endpoints: params.slackWebhookPath,
    });
  } else {
    receiver = createSlackRelayReceiver();
  }
  const app = new params.interop.App({
    token: params.botToken,
    clientOptions: params.clientOptions,
    ignoreSelf: false,
    // Bolt eagerly starts an auth.test promise in the constructor when token
    // verification is enabled. Invalid tokens can reject before any listener
    // consumes that promise, tripping OpenClaw's fatal unhandled-rejection path.
    tokenVerificationEnabled: false,
    ...(receiver ? { receiver } : {}),
  });
  app.use(async (args) => {
    if (shouldSkipOpenClawSlackSelfEvent(args)) {
      params.onSelfEventDropped?.();
      return;
    }
    await args.next();
  });
  return { app, receiver, socketModeLogger };
}

export function createSlackSocketDisconnectWaiter(app: unknown, abortSignal?: AbortSignal) {
  const waiterAbortController = new AbortController();
  const relayAbort = () => waiterAbortController.abort();
  let latest: SlackSocketDisconnect | undefined;
  abortSignal?.addEventListener("abort", relayAbort, { once: true });
  const promise = waitForSlackSocketDisconnect(app, waiterAbortController.signal).then((value) => {
    latest = value;
    return value;
  });
  return {
    promise,
    getLatest: () => latest,
    cancel: () => {
      waiterAbortController.abort();
      abortSignal?.removeEventListener("abort", relayAbort);
    },
    complete: () => {
      abortSignal?.removeEventListener("abort", relayAbort);
    },
  };
}

export async function startSlackSocketAndWaitForDisconnect(params: {
  app: { start: () => unknown };
  abortSignal?: AbortSignal;
  onStarted?: () => void;
}) {
  const disconnectWaiter = createSlackSocketDisconnectWaiter(params.app, params.abortSignal);
  try {
    await Promise.resolve(params.app.start());
    if (params.abortSignal?.aborted) {
      disconnectWaiter.cancel();
      return null;
    }
    params.onStarted?.();
    const disconnect = await disconnectWaiter.promise;
    disconnectWaiter.complete();
    return disconnect;
  } catch (err) {
    await Promise.resolve();
    const disconnect = disconnectWaiter.getLatest();
    disconnectWaiter.cancel();
    if (isMissingSocketStartErrorDetail(err) && disconnect?.error !== undefined) {
      throw toLintErrorObject(disconnect.error, "Non-Error thrown");
    }
    if (isMissingSocketStartErrorDetail(err)) {
      const suffix = disconnect ? ` after ${disconnect.event}` : "";
      throw new Error(`Slack Socket Mode start failed${suffix} without error detail`, {
        cause: err,
      });
    }
    throw err;
  }
}

function isMissingSocketStartErrorDetail(err: unknown): boolean {
  return (
    err === undefined || err === null || err === "" || (err instanceof Error && err.message === "")
  );
}

export function resolveSlackSocketShutdownClient(
  app: unknown,
): SlackSocketShutdownClient | undefined {
  if (!app || typeof app !== "object") {
    return undefined;
  }
  const receiver = Reflect.get(app, "receiver");
  if (!receiver || typeof receiver !== "object") {
    return undefined;
  }
  const client = Reflect.get(receiver, "client");
  if (!client || typeof client !== "object") {
    return undefined;
  }
  return client as SlackSocketShutdownClient;
}

export async function gracefulStopSlackApp(app: { stop: () => unknown }) {
  const socketClient = resolveSlackSocketShutdownClient(app);
  if (socketClient) {
    socketClient.shuttingDown = true;
  }
  await Promise.resolve(app.stop()).catch(() => undefined);
}

function formatSlackResolvedLabel(params: {
  input: string;
  id: string;
  name?: string;
  extra?: string[];
}): string {
  const extras = params.extra?.filter(Boolean) ?? [];
  const suffix =
    extras.length > 0 ? ` (id:${params.id}, ${extras.join(", ")})` : ` (id:${params.id})`;
  return `${params.input}→${params.name ?? params.id}${suffix}`;
}

export function formatSlackChannelResolved(entry: SlackChannelResolution): string {
  const id = entry.id ?? entry.input;
  return formatSlackResolvedLabel({
    input: entry.input,
    id,
    name: entry.name,
    extra: entry.archived ? ["archived"] : [],
  });
}

export function formatSlackUserResolved(entry: SlackUserResolution): string {
  const id = entry.id ?? entry.input;
  return formatSlackResolvedLabel({
    input: entry.input,
    id,
    name: entry.name,
    extra: entry.note ? [entry.note] : [],
  });
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
