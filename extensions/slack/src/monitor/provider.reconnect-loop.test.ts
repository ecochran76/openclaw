// Slack tests cover provider reconnect loop behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackTestState, resetSlackTestState } from "../monitor.test-helpers.js";

const { consumeExpectedSocketRefresh, monitorSlackProvider } = await import("./provider.js");
const slackTestState = getSlackTestState();

describe("slack socket reconnect loop", () => {
  beforeEach(() => {
    resetSlackTestState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not start socket loops when the provider signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      monitorSlackProvider({
        botToken: "bot-token",
        appToken: "app-token",
        abortSignal: controller.signal,
        config: slackTestState.config,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      }),
    ).resolves.toBeUndefined();

    expect(slackTestState.appStartMock).not.toHaveBeenCalled();
  });

  it("consumes connection-local refresh markers without leaking global markers", () => {
    const refresh = {
      at: 1_711_406_422_000,
      reason: "refresh_requested",
      kind: "refresh",
      expectedRefresh: true,
    };
    const status: Record<string, unknown> = {
      lastSocketDisconnectReason: refresh,
      socketConnections: {
        primary: { lastSocketDisconnectReason: refresh },
        "socket-2": { lastSocketDisconnectReason: null },
      },
    };
    const setStatus = (patch: Record<string, unknown>) => Object.assign(status, patch);

    expect(
      consumeExpectedSocketRefresh({ snapshot: status, connectionId: "primary", setStatus }),
    ).toBe(true);
    expect(status.lastSocketDisconnectReason).toBeNull();
    expect(status.socketConnections).toMatchObject({
      primary: { lastSocketDisconnectReason: null },
    });
    expect(
      consumeExpectedSocketRefresh({ snapshot: status, connectionId: "primary", setStatus }),
    ).toBe(false);

    status.lastSocketDisconnectReason = refresh;
    expect(
      consumeExpectedSocketRefresh({ snapshot: status, connectionId: "socket-2", setStatus }),
    ).toBe(false);
  });

  it("reconnects immediately after an expected refresh without a status readback", async () => {
    const controller = new AbortController();
    const runtimeLog = vi.fn();
    const setStatus = vi.fn();
    let starts = 0;
    slackTestState.appStartMock.mockImplementation(async () => {
      starts += 1;
      if (starts === 2) {
        controller.abort();
      }
    });

    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: slackTestState.config,
      setStatus,
      runtime: {
        log: runtimeLog,
        error: vi.fn(),
        exit: vi.fn(),
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    const receiver = slackTestState.socketReceivers[0] as {
      client: { on: ReturnType<typeof vi.fn> };
    };
    const listenersFor = (event: string) =>
      receiver.client.on.mock.calls
        .filter(([registeredEvent]) => registeredEvent === event)
        .map(([, listener]) => listener as (...args: unknown[]) => void);
    for (const listener of listenersFor("ws_message")) {
      listener(Buffer.from(JSON.stringify({ type: "disconnect", reason: "refresh_requested" })));
    }
    for (const listener of listenersFor("disconnected")) {
      listener();
    }

    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeUndefined();

    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(2);
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("slack socket refresh requested (primary); reconnecting immediately"),
    );
  });

  it("preserves a healthy peer when one setStatus-only socket disconnects", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          enabled: true,
          socketMode: { connectionCount: 2 },
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
        },
      },
    });
    const controller = new AbortController();
    const status: Record<string, unknown> = {};
    slackTestState.appStartMock.mockResolvedValue(undefined);

    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: slackTestState.config,
      setStatus: (patch) => Object.assign(status, patch),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    await vi.advanceTimersByTimeAsync(0);

    const emit = (receiverIndex: number, event: string, ...args: unknown[]) => {
      const receiver = slackTestState.socketReceivers[receiverIndex] as {
        client: { on: ReturnType<typeof vi.fn> };
      };
      for (const [, listener] of receiver.client.on.mock.calls.filter(
        ([registeredEvent]) => registeredEvent === event,
      )) {
        (listener as (...listenerArgs: unknown[]) => void)(...args);
      }
    };
    emit(0, "connected");
    emit(1, "connected");
    emit(1, "disconnected");

    await vi.runOnlyPendingTimersAsync();

    expect(status).toMatchObject({
      connected: true,
      socketConnectionCount: 2,
      socketConnections: {
        primary: { connected: true, healthState: "healthy" },
        "socket-2": { connected: false, healthState: "disconnected" },
      },
    });

    controller.abort();
    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeUndefined();
  });

  it("cancels sibling socket loops when one connection fails terminally", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          enabled: true,
          socketMode: { connectionCount: 2 },
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
        },
      },
    });
    let starts = 0;
    slackTestState.appStartMock.mockImplementation(async () => {
      starts += 1;
      if (starts === 1) {
        throw new Error("invalid_auth");
      }
    });

    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      config: slackTestState.config,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    const rejected = expect(run).rejects.toThrow("invalid_auth");
    await vi.runAllTimersAsync();

    await rejected;
    expect(slackTestState.appStartMock).toHaveBeenCalledTimes(2);
    expect(slackTestState.appStopMock).toHaveBeenCalled();
    const peer = slackTestState.socketReceivers[1] as {
      client: { off: ReturnType<typeof vi.fn> };
    };
    expect(peer.client.off).toHaveBeenCalledWith("disconnected", expect.any(Function));
    expect(peer.client.off).toHaveBeenCalledWith(
      "unable_to_socket_mode_start",
      expect.any(Function),
    );
    expect(peer.client.off).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it.each([
    ["network error", () => new Error("ECONNRESET")],
    [
      "Slack Web API request error",
      () =>
        Object.assign(new Error("Slack Web API request error"), {
          code: "slack_webapi_request_error",
          original: new Error("ECONNRESET"),
        }),
    ],
    [
      "Slack Web API HTTP error",
      () =>
        Object.assign(new Error("Slack Web API HTTP error"), {
          code: "slack_webapi_http_error",
          statusCode: 503,
          statusMessage: "Service Unavailable",
        }),
    ],
  ])(
    "continues after thirteen consecutive recoverable %s failures",
    async (_label, createError) => {
      const controller = new AbortController();
      const runtimeError = vi.fn();
      let attempts = 0;
      slackTestState.appStartMock.mockImplementation(async () => {
        attempts += 1;
        if (attempts <= 13) {
          throw createError();
        }
        controller.abort();
      });

      const run = monitorSlackProvider({
        botToken: "bot-token",
        appToken: "app-token",
        abortSignal: controller.signal,
        config: slackTestState.config,
        runtime: {
          log: vi.fn(),
          error: runtimeError,
          exit: vi.fn(),
        },
      });

      await vi.runAllTimersAsync();
      await expect(run).resolves.toBeUndefined();

      expect(slackTestState.appStartMock).toHaveBeenCalledTimes(14);
      expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("retry 13/∞"));
    },
  );

  it("includes the configured Socket Mode logger context in start retry diagnostics", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const runtimeError = vi.fn();
    let attempts = 0;
    slackTestState.appStartMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        slackTestState.socketModeLogger?.error("failed to retrieve WSS URL", {
          data: { error: "missing_scope", needed: "connections:write" },
        });
        throw new Error();
      }
      controller.abort();
    });

    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: slackTestState.config,
      runtime: {
        log: vi.fn(),
        error: runtimeError,
        exit: vi.fn(),
      },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeUndefined();

    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining(
        "last SDK log: socket-mode:socket-mode failed to retrieve WSS URL slack error: missing_scope; needed: connections:write",
      ),
    );
  });
});
