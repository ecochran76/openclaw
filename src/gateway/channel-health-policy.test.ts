/**
 * Channel health policy regression tests.
 */
import { describe, expect, it } from "vitest";
import { evaluateChannelHealth, resolveChannelRestartReason } from "./channel-health-policy.js";

function evaluateHealth(
  account: Record<string, unknown>,
  opts: { now?: number; channelId?: string } = {},
) {
  const { now = 100_000, channelId = "discord" } = opts;
  return evaluateChannelHealth(account, {
    channelId,
    now,
    channelConnectGraceMs: 10_000,
    staleEventThresholdMs: 30_000,
  });
}

function runningAccount(overrides: Record<string, unknown> = {}) {
  return {
    running: true,
    enabled: true,
    configured: true,
    ...overrides,
  };
}

function connectedAccount(overrides: Record<string, unknown> = {}) {
  return runningAccount({ connected: true, ...overrides });
}

function activeRunAccount(lastRunActivityAt: number, overrides: Record<string, unknown> = {}) {
  return runningAccount({
    connected: false,
    activeRuns: 1,
    lastRunActivityAt,
    ...overrides,
  });
}

function staleTransportAccount(overrides: Record<string, unknown> = {}) {
  return connectedAccount({
    lastStartAt: 0,
    lastTransportActivityAt: 0,
    ...overrides,
  });
}

function inheritedTransportAccount() {
  return connectedAccount({
    lastStartAt: 50_000,
    lastTransportActivityAt: 10_000,
  });
}

describe("evaluateChannelHealth", () => {
  it("treats disabled accounts as healthy unmanaged", () => {
    const evaluation = evaluateHealth({
      running: false,
      enabled: false,
      configured: true,
    });
    expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("uses channel connect grace before flagging disconnected", () => {
    const evaluation = evaluateHealth(
      runningAccount({
        connected: false,
        lastStartAt: 95_000,
      }),
    );
    expect(evaluation).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it("treats active runs as busy even when disconnected", () => {
    const now = 100_000;
    const evaluation = evaluateHealth(activeRunAccount(now - 30_000), { now });
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("flags stale busy channels as stuck when run activity is too old", () => {
    const now = 100_000;
    const evaluation = evaluateHealth(activeRunAccount(now - 26 * 60_000), { now });
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("ignores inherited busy flags until current lifecycle reports run activity", () => {
    const now = 100_000;
    const evaluation = evaluateHealth(
      runningAccount({
        connected: false,
        lastStartAt: now - 30_000,
        busy: true,
        activeRuns: 1,
        lastRunActivityAt: now - 31_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("flags stale sockets when transport activity ages beyond threshold", () => {
    const evaluation = evaluateHealth(staleTransportAccount());
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("ignores stale app events without transport activity", () => {
    const evaluation = evaluateHealth(
      connectedAccount({
        lastStartAt: 0,
        lastEventAt: 0,
      }),
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags stale sockets for telegram polling channels with transport activity", () => {
    const evaluation = evaluateHealth(staleTransportAccount({ mode: "polling" }), {
      channelId: "example",
    });
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("does not special-case malformed channel mode when transport activity is explicit", () => {
    const evaluation = evaluateHealth(
      staleTransportAccount({ mode: { polling: true } as unknown as string }),
      { channelId: "example" },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("trusts explicit transport activity instead of webhook mode heuristics", () => {
    const evaluation = evaluateHealth(staleTransportAccount({ mode: "webhook" }));
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it("does not flag stale sockets for channels without transport tracking", () => {
    const evaluation = evaluateHealth(
      connectedAccount({
        lastStartAt: 0,
        lastTransportActivityAt: null,
      }),
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("keeps quiet Slack socket-mode accounts healthy without transport tracking", () => {
    const evaluation = evaluateHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 0,
        lastTransportActivityAt: null,
        healthState: "healthy",
      },
      { now: 100_000, channelId: "slack" },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("uses current socket errors as unhealthy receiver evidence", () => {
    const evaluation = evaluateHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastSocketConnectedAt: 60_000,
        lastSocketError: { at: 90_000, error: "socket failed" },
      },
      { now: 100_000, channelId: "slack" },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "socket-unhealthy" });
  });

  it("ignores socket errors superseded by a later successful connect", () => {
    const evaluation = evaluateHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastSocketError: { at: 60_000, error: "socket failed" },
        lastSocketConnectedAt: 90_000,
      },
      { now: 100_000, channelId: "slack" },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("uses recent raw receiver activity as proof against stale inherited transport", () => {
    const evaluation = evaluateHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastTransportActivityAt: 10_000,
        lastSocketEnvelopeAt: 95_000,
      },
      { now: 100_000, channelId: "slack" },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("treats current reconnecting state as an unhealthy socket lifecycle", () => {
    const evaluation = evaluateHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastSocketReconnectAt: 90_000,
        healthState: "reconnecting",
      },
      { now: 100_000, channelId: "slack" },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "socket-unhealthy" });
  });

  it("keeps quiet telegram webhooks healthy when they do not publish transport tracking", () => {
    const evaluation = evaluateHealth(
      connectedAccount({
        mode: "webhook",
        lastStartAt: 0,
        lastEventAt: 0,
      }),
      { channelId: "telegram" },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag stale sockets without an active connected socket", () => {
    const evaluation = evaluateHealth(
      runningAccount({
        lastStartAt: 0,
        lastTransportActivityAt: 0,
      }),
      { now: 75_000, channelId: "slack" },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("ignores inherited transport timestamps from a previous lifecycle", () => {
    const evaluation = evaluateHealth(inheritedTransportAccount(), {
      now: 75_000,
      channelId: "slack",
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not flag inherited Slack Socket Mode transport timestamps after the stale threshold", () => {
    const evaluation = evaluateHealth(inheritedTransportAccount(), {
      now: 140_000,
      channelId: "slack",
    });

    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("does not classify Slack Socket Mode by inherited generic transport timestamps", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        lastStartAt: 50_000,
        lastTransportActivityAt: 10_000,
      },
      {
        channelId: "slack",
        now: 140_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("treats inactive Slack Socket Mode active-state as unhealthy despite stale connected flag", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        mode: "socket",
        lastStartAt: 100_000 - 300_000,
        socketActiveState: "inactive",
        socketActiveStateAvailable: true,
      },
      {
        channelId: "slack",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );

    expect(evaluation).toEqual({ healthy: false, reason: "socket-unhealthy" });
  });

  it("keeps multi-connection Slack healthy when another socket remains active", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        mode: "socket",
        healthState: "healthy",
        lastStartAt: 50_000,
        lastSocketConnectedAt: 60_000,
        lastSocketDisconnectedAt: 90_000,
        socketActiveState: "active",
        socketActiveStateAvailable: true,
        socketConnectionCount: 2,
      },
      {
        channelId: "slack",
        now: 100_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );

    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("preserves stale transport checks for explicit Slack HTTP mode", () => {
    const evaluation = evaluateChannelHealth(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
        mode: "http",
        lastStartAt: 50_000,
        lastTransportActivityAt: 10_000,
      },
      {
        channelId: "slack",
        now: 140_000,
        channelConnectGraceMs: 10_000,
        staleEventThresholdMs: 30_000,
      },
    );

    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });
});

describe("resolveChannelRestartReason", () => {
  it("maps not-running + high reconnect attempts to gave-up", () => {
    const reason = resolveChannelRestartReason(
      {
        running: false,
        reconnectAttempts: 10,
      },
      { healthy: false, reason: "not-running" },
    );
    expect(reason).toBe("gave-up");
  });

  it("maps disconnected to disconnected instead of stuck", () => {
    const reason = resolveChannelRestartReason(
      runningAccount({
        connected: false,
      }),
      { healthy: false, reason: "disconnected" },
    );
    expect(reason).toBe("disconnected");
  });

  it("maps socket lifecycle failures to socket-unhealthy", () => {
    const reason = resolveChannelRestartReason(
      {
        running: true,
        connected: true,
        enabled: true,
        configured: true,
      },
      { healthy: false, reason: "socket-unhealthy" },
    );
    expect(reason).toBe("socket-unhealthy");
  });
});
