// Slack tests cover provider.reconnect plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifySlackSocketDisconnectReason,
  gracefulStopSlackApp,
  installSlackSocketModeStatusObserver,
  publishSlackConnectedStatus,
  publishSlackDisconnectedStatus,
  startSlackSocketAndWaitForDisconnect,
} from "./provider-support.js";
import {
  formatSlackSocketReconnectMessage,
  formatSlackSocketStartRetryMessage,
} from "./provider.js";
import { formatUnknownError, waitForSlackSocketDisconnect } from "./reconnect-policy.js";

class FakeEmitter {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void) {
    const bucket = this.listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  listenerCount(event: string) {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function statusCallAt(setStatus: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  const call = setStatus.mock.calls[index];
  if (!call) {
    throw new Error(`expected status call ${index}`);
  }
  const [status] = call;
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    throw new Error(`expected status call ${index} payload`);
  }
  return status as Record<string, unknown>;
}

describe("slack socket reconnect helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks socket mode healthy without seeding event liveness on connect", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_400_000);

    publishSlackConnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    const status = statusCallAt(setStatus, 0);
    expect(status?.connected).toBe(true);
    expect(status?.lastConnectedAt).toBe(1_711_406_400_000);
    expect(status?.lastTransportActivityAt).toBeNull();
    expect(status?.lastSocketError).toBeNull();
    expect(status?.lastSocketDisconnectedAt).toBeNull();
    expect(status?.lastSocketReconnectAt).toBeNull();
    expect(status?.healthState).toBe("healthy");
    expect(status?.lastError).toBeNull();
    expect(status).not.toHaveProperty("lastEventAt");
  });

  it("publishes socket lifecycle fields from Slack SDK lifecycle events", () => {
    const client = new FakeEmitter();
    const setStatus = vi.fn();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_711_406_410_000)
      .mockReturnValueOnce(1_711_406_411_000)
      .mockReturnValueOnce(1_711_406_412_000)
      .mockReturnValueOnce(1_711_406_413_000)
      .mockReturnValueOnce(1_711_406_414_000);

    installSlackSocketModeStatusObserver({ client }, setStatus, undefined, {
      activeProbeIntervalMs: 0,
    });
    setStatus.mockClear();
    client.emit("connected");
    client.emit("reconnecting");
    client.emit("disconnecting");
    client.emit("disconnected");
    client.emit("error", new Error("socket failed"));

    expect(setStatus.mock.calls.map(([patch]) => patch)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connected: true,
          socketActiveState: "inactive",
          socketActiveStateAvailable: true,
          socketConnectionCount: 1,
        }),
        {
          lastSocketConnectedAt: 1_711_406_410_000,
          lastSocketError: null,
          lastSocketDisconnectedAt: null,
          lastSocketReconnectAt: null,
          lastError: null,
        },
        expect.objectContaining({
          socketActiveState: "inactive",
          socketActiveStateAvailable: true,
          socketConnectionCount: 1,
        }),
        {
          lastSocketReconnectAt: 1_711_406_411_000,
        },
        expect.objectContaining({
          connected: false,
          socketActiveState: "inactive",
          socketActiveStateAvailable: true,
          socketConnectionCount: 1,
        }),
        {
          lastSocketDisconnectedAt: 1_711_406_412_000,
        },
        expect.objectContaining({
          connected: false,
          socketActiveState: "inactive",
          socketActiveStateAvailable: true,
          socketConnectionCount: 1,
        }),
        {
          lastSocketDisconnectedAt: 1_711_406_413_000,
        },
        {
          lastSocketError: {
            at: 1_711_406_414_000,
            error: "socket failed",
          },
          lastError: "socket failed",
        },
      ]),
    );
  });

  it("keeps aggregate account status healthy when one of multiple sockets disconnects", () => {
    const primary = new FakeEmitter() as FakeEmitter & {
      websocket?: { isActive: () => boolean };
    };
    const secondary = new FakeEmitter() as FakeEmitter & {
      websocket?: { isActive: () => boolean };
    };
    primary.websocket = { isActive: () => true };
    secondary.websocket = { isActive: () => false };
    const status: Record<string, unknown> = {};
    const setStatus = vi.fn((patch: Record<string, unknown>) => Object.assign(status, patch));
    const getStatus = () => status;
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_711_406_410_000)
      .mockReturnValueOnce(1_711_406_411_000)
      .mockReturnValueOnce(1_711_406_412_000);

    installSlackSocketModeStatusObserver({ client: primary }, setStatus, getStatus, {
      connectionId: "primary",
      activeProbeIntervalMs: 0,
    });
    installSlackSocketModeStatusObserver({ client: secondary }, setStatus, getStatus, {
      connectionId: "socket-2",
      activeProbeIntervalMs: 0,
    });

    primary.emit("connected");
    secondary.emit("connected");
    secondary.emit("disconnected");

    expect(status.connected).toBe(true);
    expect(status.healthState).toBe("healthy");
    expect(status.socketActiveState).toBe("active");
    expect(status.socketConnectionCount).toBe(2);
    expect(status.socketConnections).toMatchObject({
      primary: {
        connected: true,
        socketActiveState: "active",
        healthState: "healthy",
      },
      "socket-2": {
        connected: false,
        socketActiveState: "inactive",
        healthState: "disconnected",
        lastSocketDisconnectedAt: 1_711_406_412_000,
      },
    });
  });

  it("reports active websocket state from the Slack SDK websocket", () => {
    const client = new FakeEmitter() as FakeEmitter & {
      websocket?: { isActive: () => boolean };
    };
    const setStatus = vi.fn();
    const getStatus = () => {
      const last = setStatus.mock.calls.at(-1)?.[0];
      return last && typeof last === "object" ? (last as Record<string, unknown>) : {};
    };

    client.websocket = { isActive: () => true };
    installSlackSocketModeStatusObserver({ client }, setStatus, getStatus, {
      activeProbeIntervalMs: 0,
    });

    expect(setStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connected: true,
        socketActiveState: "active",
        socketActiveStateAvailable: true,
      }),
    );
  });

  it("publishes raw receiver liveness without app-level inbound activity", () => {
    const client = new FakeEmitter();
    const setStatus = vi.fn();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_711_406_420_000)
      .mockReturnValueOnce(1_711_406_421_000);

    installSlackSocketModeStatusObserver({ client }, setStatus, undefined, {
      activeProbeIntervalMs: 0,
    });
    setStatus.mockClear();
    client.emit("ws_message", Buffer.from("{}"), false);
    client.emit("slack_event", { type: "events_api" });

    expect(setStatus.mock.calls.map(([patch]) => patch)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          socketActiveState: "inactive",
          socketActiveStateAvailable: true,
          socketConnectionCount: 1,
        }),
        {
          slackTelemetry: {
            rawSocketEnvelopes: 1,
          },
          lastSocketEnvelopeAt: 1_711_406_420_000,
        },
        expect.objectContaining({
          socketActiveState: "inactive",
          socketActiveStateAvailable: true,
          socketConnectionCount: 1,
        }),
        {
          slackTelemetry: {
            rawSlackEvents: 1,
          },
          lastSlackEventAt: 1_711_406_421_000,
        },
      ]),
    );
    expect(setStatus.mock.calls).not.toContainEqual([
      expect.objectContaining({ lastInboundAt: expect.any(Number) }),
    ]);
  });

  it("classifies Slack Socket Mode refresh disconnects", () => {
    expect(classifySlackSocketDisconnectReason("warning")).toEqual({
      reason: "warning",
      kind: "refresh",
      expectedRefresh: true,
    });
    expect(classifySlackSocketDisconnectReason("refresh_requested")).toEqual({
      reason: "refresh_requested",
      kind: "refresh",
      expectedRefresh: true,
    });
    expect(classifySlackSocketDisconnectReason("link_disabled")).toEqual({
      reason: "link_disabled",
      kind: "link-disabled",
      expectedRefresh: false,
    });
  });

  it("records Slack disconnect envelopes before the SDK closes the socket", () => {
    const client = new FakeEmitter();
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_422_000);

    installSlackSocketModeStatusObserver({ client }, setStatus, undefined, {
      activeProbeIntervalMs: 0,
    });
    setStatus.mockClear();
    client.emit(
      "ws_message",
      Buffer.from(JSON.stringify({ type: "disconnect", reason: "refresh_requested" })),
      false,
    );

    expect(setStatus.mock.calls.map(([patch]) => patch)).toEqual(
      expect.arrayContaining([
        {
          lastSocketDisconnectReason: {
            at: 1_711_406_422_000,
            reason: "refresh_requested",
            kind: "refresh",
            expectedRefresh: true,
          },
          healthState: "reconnecting",
        },
        {
          slackTelemetry: {
            rawSocketEnvelopes: 1,
          },
          lastSocketEnvelopeAt: 1_711_406_422_000,
        },
      ]),
    );
  });

  it("marks socket mode disconnected when an error closes the socket", () => {
    const setStatus = vi.fn();
    const err = new Error("dns down");
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_401_000);

    publishSlackDisconnectedStatus(setStatus, err);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      healthState: "disconnected",
      lastDisconnect: {
        at: 1_711_406_401_000,
        error: "dns down",
      },
      lastError: "dns down",
    });
  });

  it("marks socket mode disconnected without error when the socket closes cleanly", () => {
    const setStatus = vi.fn();
    vi.spyOn(Date, "now").mockReturnValue(1_711_406_402_000);

    publishSlackDisconnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith({
      connected: false,
      healthState: "disconnected",
      lastDisconnect: {
        at: 1_711_406_402_000,
      },
      lastError: null,
    });
  });

  it("formats recoverable disconnects beyond the former cap as unlimited", () => {
    expect(
      formatSlackSocketReconnectMessage({
        event: "disconnect",
        attempt: 13,
        delayMs: 2_340,
      }),
    ).toBe("slack socket disconnected (disconnect); reconnecting in 2s (attempt 13/∞)");
  });

  it("formats missing and unserializable socket errors without leaking undefined", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(formatUnknownError(undefined)).toBe("no error detail");
    expect(formatUnknownError(null)).toBe("no error detail");
    expect(formatUnknownError("")).toBe("no error detail");
    expect(formatUnknownError(new Error(""))).toBe("Error");
    expect(formatUnknownError(circular)).toBe('{"self":"[Circular]"}');
  });

  it("formats structured Slack socket errors", () => {
    expect(
      formatUnknownError({
        code: "slack_webapi_platform_error",
        data: {
          error: "missing_scope",
          needed: "connections:write",
          response_metadata: {
            messages: ["[ERROR] missing required scope"],
          },
        },
      }),
    ).toBe(
      "code: slack_webapi_platform_error; slack error: missing_scope; needed: connections:write; slack message: [ERROR] missing required scope",
    );
  });

  it("formats socket start retries with an explicit reason field", () => {
    expect(
      formatSlackSocketStartRetryMessage({
        attempt: 13,
        delayMs: 2_340,
        error: undefined,
      }),
    ).toBe(
      'slack socket mode failed to start; retry 13/∞ in 2s reason="Slack Socket Mode start failed without error detail"',
    );
  });

  it("includes last SDK log context when start errors have no detail", () => {
    expect(
      formatSlackSocketStartRetryMessage({
        attempt: 1,
        delayMs: 2_340,
        error: undefined,
        sdkContext: "socket-mode:SlackWebSocket:1 Failed to retrieve WSS URL",
      }),
    ).toBe(
      'slack socket mode failed to start; retry 1/∞ in 2s reason="Slack Socket Mode start failed without error detail; last SDK log: socket-mode:SlackWebSocket:1 Failed to retrieve WSS URL"',
    );
  });

  it("resolves disconnect waiter on socket disconnect event", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client } };

    const waiter = waitForSlackSocketDisconnect(app as never);
    client.emit("disconnected");

    await expect(waiter).resolves.toEqual({ event: "disconnect" });
  });

  it("resolves disconnect waiter on socket error event", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client } };
    const err = new Error("dns down");

    const waiter = waitForSlackSocketDisconnect(app as never);
    client.emit("error", err);

    await expect(waiter).resolves.toEqual({ event: "error", error: err });
  });

  it("installs the disconnect waiter before socket start completes", async () => {
    const client = new FakeEmitter();
    const app = {
      receiver: { client },
      start: vi.fn().mockImplementation(async () => {
        client.emit("disconnected");
      }),
    };
    const onStarted = vi.fn();

    await expect(
      startSlackSocketAndWaitForDisconnect({
        app: app as never,
        onStarted,
      }),
    ).resolves.toEqual({ event: "disconnect" });

    expect(app.start).toHaveBeenCalledTimes(1);
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it("cancels the disconnect waiter when onStarted throws", async () => {
    const client = new FakeEmitter();
    const app = {
      receiver: { client },
      start: vi.fn().mockResolvedValue(undefined),
    };
    const err = new Error("status sink failed");

    await expect(
      startSlackSocketAndWaitForDisconnect({
        app: app as never,
        onStarted: () => {
          throw err;
        },
      }),
    ).rejects.toThrow("status sink failed");

    expect(client.listenerCount("disconnected")).toBe(0);
    expect(client.listenerCount("unable_to_socket_mode_start")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("preserves error payload from unable_to_socket_mode_start event", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client } };
    const err = new Error("invalid_auth");

    const waiter = waitForSlackSocketDisconnect(app as never);
    client.emit("unable_to_socket_mode_start", err);

    await expect(waiter).resolves.toEqual({
      event: "unable_to_socket_mode_start",
      error: err,
    });
  });

  it("uses socket start event error when Bolt rejects without detail", async () => {
    const client = new FakeEmitter();
    const err = new Error("missing_scope");
    const app = {
      receiver: { client },
      start: vi.fn().mockImplementation(() => {
        client.emit("unable_to_socket_mode_start", err);
        throw new Error();
      }),
    };

    await expect(startSlackSocketAndWaitForDisconnect({ app: app as never })).rejects.toThrow(
      "missing_scope",
    );

    expect(client.listenerCount("disconnected")).toBe(0);
    expect(client.listenerCount("unable_to_socket_mode_start")).toBe(0);
    expect(client.listenerCount("error")).toBe(0);
  });

  it("marks the socket client as shutting down before stop runs", async () => {
    const app = {
      receiver: { client: { shuttingDown: false } },
      stop: vi.fn().mockImplementation(async () => {
        expect(app.receiver.client.shuttingDown).toBe(true);
      }),
    };

    await gracefulStopSlackApp(app);

    expect(app.stop).toHaveBeenCalledTimes(1);
    expect(app.receiver.client.shuttingDown).toBe(true);
  });
});
