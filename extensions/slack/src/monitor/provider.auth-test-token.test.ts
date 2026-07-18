// Slack tests cover auth.test token handling during provider boot.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  flush,
  getSlackClient,
  getSlackHandlerOrThrow,
  getSlackHandlers,
  getSlackTestState,
  resetSlackTestState,
  runSlackMessageOnce,
  startSlackMonitor,
  stopSlackMonitor,
} from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");

beforeEach(() => {
  resetSlackTestState();
});

describe("auth.test boot call", () => {
  it("does not pass the bot token in the call arguments", async () => {
    const monitor = startSlackMonitor(monitorSlackProvider);
    await stopSlackMonitor(monitor);

    const client = getSlackClient();
    expect(client.auth.test).toHaveBeenCalledTimes(1);
    // The SDK serializes every property from the call argument into the POST
    // body.  Passing { token } would leak the bot token into the request
    // payload alongside the Authorization header.
    const firstArg = client.auth.test.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    if (firstArg != null) {
      expect(firstArg).not.toHaveProperty("token");
    }
  });

  it("warns when auth.test returns a user id without bot_id", async () => {
    const runtimeLog = vi.fn();
    const client = getSlackClient();
    client.auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UUSER",
      user: "human-installer",
      team_id: "T1",
      team: "OpenClaw",
      is_enterprise_install: false,
    });

    const monitor = startSlackMonitor(monitorSlackProvider, {
      botToken: "xoxp-user-token",
      runtime: {
        log: runtimeLog,
        error: vi.fn(),
        exit: vi.fn(),
      },
    });
    await stopSlackMonitor(monitor);

    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("channels.slack.accounts.default.botToken"),
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("replace it with a Bot User OAuth Token"),
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("required-mention channels fail closed"),
    );
  });

  it("does not use a user-token identity as the bot mention target", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          groupPolicy: "open",
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    });
    const client = getSlackClient();
    client.auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UUSER",
      user: "human-installer",
      team_id: "T1",
      team: "OpenClaw",
      is_enterprise_install: false,
    });
    client.conversations.info.mockResolvedValueOnce({
      channel: { name: "general", is_channel: true },
    });
    const { replyMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "unexpected" });

    await runSlackMessageOnce(
      monitorSlackProvider,
      {
        event: {
          type: "message",
          user: "USENDER",
          text: "<@UUSER> status",
          ts: "100.000",
          channel: "C1",
          channel_type: "channel",
        },
      },
      { botToken: "xoxp-user-token" },
    );

    expect(replyMock).not.toHaveBeenCalled();
  });

  it("warns that required-mention channels fail closed when auth.test fails", async () => {
    const runtimeLog = vi.fn();
    getSlackClient().auth.test.mockRejectedValueOnce(new Error("request_timeout"));

    const monitor = startSlackMonitor(monitorSlackProvider, {
      runtime: {
        log: runtimeLog,
        error: vi.fn(),
        exit: vi.fn(),
      },
    });
    await stopSlackMonitor(monitor);

    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "required-mention channels will fail closed without another trusted activation signal",
      ),
    );
  });

  it("keeps inbound dispatch live while auth metadata hydration is stalled", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          dm: { enabled: true, policy: "open", allowFrom: ["*"] },
          groupPolicy: "open",
          channels: { C1: { allow: true, requireMention: true } },
        },
      },
    });
    getSlackClient().auth.test.mockImplementation(() => new Promise(() => {}));
    const { replyMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "ok" });

    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await handler({
        event: {
          type: "message",
          user: "U1",
          text: "hello",
          ts: "100.000",
          channel: "D1",
          channel_type: "im",
        },
      });
      expect(replyMock).toHaveBeenCalledTimes(1);

      replyMock.mockClear();
      await handler({
        event: {
          type: "message",
          user: "U1",
          text: "<@UBOT> hello",
          ts: "101.000",
          channel: "C1",
          channel_type: "channel",
        },
      });
      await flush();
      expect(replyMock).not.toHaveBeenCalled();
    } finally {
      await stopSlackMonitor(monitor);
    }
  });

  it("does not apply auth metadata or start reconciliation after teardown", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          groupPolicy: "open",
          channels: { C1: { enabled: true, requireMention: true } },
          reconciliation: { enabled: true, intervalMs: 60_000 },
        },
      },
    });
    let resolveAuth!: (value: Record<string, unknown>) => void;
    getSlackClient().auth.test.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAuth = resolve;
        }),
    );
    const { replyMock } = getSlackTestState();
    replyMock.mockResolvedValue({ text: "unexpected" });

    const monitor = startSlackMonitor(monitorSlackProvider);
    const handler = await getSlackHandlerOrThrow("message");
    await stopSlackMonitor(monitor);

    resolveAuth({
      app_id: "A1",
      user_id: "UBOT",
      bot_id: "BBOT",
      team_id: "T1",
      is_enterprise_install: false,
    });
    await flush();
    await flush();

    expect(getSlackClient().conversations.history).not.toHaveBeenCalled();
    await handler({
      event: {
        type: "message",
        user: "U1",
        text: "<@UBOT> should remain inactive",
        ts: "102.000",
        channel: "C1",
        channel_type: "channel",
      },
    });
    expect(replyMock).not.toHaveBeenCalled();
  });

  it("retries auth metadata hydration when reconciliation is disabled", async () => {
    vi.useFakeTimers();
    const authTest = getSlackClient().auth.test;
    authTest.mockRejectedValueOnce(new Error("request_timeout")).mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UBOT",
      bot_id: "BBOT",
      team_id: "T1",
      is_enterprise_install: false,
    });

    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(authTest).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(authTest).toHaveBeenCalledTimes(2);
    } finally {
      monitor.controller.abort();
      await monitor.run;
      vi.useRealTimers();
    }
  });

  it("preserves workspace startup when auth.test omits app_id", async () => {
    getSlackClient().auth.test.mockResolvedValueOnce({
      user_id: "UBOT",
      bot_id: "BBOT",
      team_id: "T1",
      is_enterprise_install: false,
    });

    const monitor = startSlackMonitor(monitorSlackProvider);
    await expect(stopSlackMonitor(monitor)).resolves.toBeUndefined();
  });

  it("starts an org-wide Socket Mode account when auth.test omits app_id", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          enterpriseOrgInstall: true,
          dmPolicy: "disabled",
          groupPolicy: "open",
        },
      },
    });
    getSlackClient().auth.test.mockResolvedValueOnce({
      enterprise_id: "E1",
      is_enterprise_install: true,
    });

    const monitor = startSlackMonitor(monitorSlackProvider, {
      appToken: "xapp-1-A1-opaque",
    });
    await expect(stopSlackMonitor(monitor)).resolves.toBeUndefined();
  });

  it("starts an org-wide account with degraded identity when auth.test fails", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          enterpriseOrgInstall: true,
          dmPolicy: "disabled",
          groupPolicy: "open",
        },
      },
    });
    const runtimeLog = vi.fn();
    getSlackClient().auth.test.mockRejectedValueOnce(new Error("enterprise auth unavailable"));

    const monitor = startSlackMonitor(monitorSlackProvider, {
      appToken: "xapp-1-A1-opaque",
      runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
    });
    await getSlackHandlerOrThrow("message");
    await expect(stopSlackMonitor(monitor)).resolves.toBeUndefined();
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("degraded installation identity"),
    );
  });

  it("registers org-wide event ownership without waiting for initial auth hydration", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          enterpriseOrgInstall: true,
          dmPolicy: "disabled",
          groupPolicy: "open",
        },
      },
    });
    const authTest = getSlackClient().auth.test;
    authTest.mockImplementation(() => new Promise(() => {}));

    const monitor = startSlackMonitor(monitorSlackProvider, {
      appToken: "xapp-1-A1-opaque",
    });
    try {
      await expect(getSlackHandlerOrThrow("message")).resolves.toBeDefined();
      expect(authTest).toHaveBeenCalledTimes(1);
      expect(getSlackHandlers()?.has("reaction_added")).toBe(false);
    } finally {
      await stopSlackMonitor(monitor);
    }
  });

  it("recovers degraded org-wide installation identity in the background", async () => {
    vi.useFakeTimers();
    resetSlackTestState({
      channels: {
        slack: {
          enterpriseOrgInstall: true,
          dmPolicy: "disabled",
          groupPolicy: "open",
        },
      },
    });
    const authTest = getSlackClient().auth.test;
    authTest.mockRejectedValueOnce(new Error("enterprise auth unavailable")).mockResolvedValueOnce({
      enterprise_id: "E1",
      is_enterprise_install: true,
    });

    const monitor = startSlackMonitor(monitorSlackProvider, {
      appToken: "xapp-1-A1-opaque",
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(authTest).toHaveBeenCalledTimes(1);
      expect(getSlackHandlers()?.has("reaction_added")).toBe(false);

      const handler = getSlackHandlers()?.get("app_mention");
      expect(handler).toBeDefined();
      const { replyMock } = getSlackTestState();
      replyMock.mockResolvedValue({ text: "ok" });
      const client = getSlackClient();
      await handler?.({
        event: {
          type: "app_mention",
          user: "U1",
          text: "before recovery",
          ts: "100.000",
          channel: "C1",
          channel_type: "channel",
        },
        body: { api_app_id: "A1" },
        context: { isEnterpriseInstall: true, enterpriseId: "E1", teamId: "T1" },
        client,
      });
      expect(replyMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(authTest).toHaveBeenCalledTimes(2);
      await handler?.({
        event: {
          type: "app_mention",
          user: "U1",
          text: "after recovery",
          ts: "101.000",
          channel: "C1",
          channel_type: "channel",
        },
        body: { api_app_id: "A1" },
        context: { isEnterpriseInstall: true, enterpriseId: "E1", teamId: "T1" },
        client,
      });
      expect(replyMock).toHaveBeenCalledTimes(1);
    } finally {
      monitor.controller.abort();
      await monitor.run;
      vi.useRealTimers();
    }
  });

  it("keeps bounded-backoff org-wide identity recovery live past transient retries", async () => {
    vi.useFakeTimers();
    resetSlackTestState({
      channels: {
        slack: {
          enterpriseOrgInstall: true,
          dmPolicy: "disabled",
          groupPolicy: "open",
        },
      },
    });
    const authTest = getSlackClient().auth.test;
    authTest
      .mockRejectedValueOnce(new Error("enterprise auth unavailable"))
      .mockRejectedValueOnce(new Error("enterprise auth unavailable"))
      .mockRejectedValueOnce(new Error("enterprise auth unavailable"))
      .mockRejectedValueOnce(new Error("enterprise auth unavailable"))
      .mockRejectedValueOnce(new Error("enterprise auth unavailable"))
      .mockRejectedValueOnce(new Error("enterprise auth unavailable"))
      .mockResolvedValueOnce({ enterprise_id: "E1", is_enterprise_install: true });

    const monitor = startSlackMonitor(monitorSlackProvider, {
      appToken: "xapp-1-A1-opaque",
    });
    try {
      await vi.advanceTimersByTimeAsync(1_050_000);
      expect(authTest).toHaveBeenCalledTimes(7);

      const handler = getSlackHandlers()?.get("app_mention");
      const { replyMock } = getSlackTestState();
      replyMock.mockResolvedValue({ text: "ok" });
      await handler?.({
        event: {
          type: "app_mention",
          user: "U1",
          text: "after extended recovery",
          ts: "102.000",
          channel: "C1",
          channel_type: "channel",
        },
        body: { api_app_id: "A1" },
        context: { isEnterpriseInstall: true, enterpriseId: "E1", teamId: "T1" },
        client: getSlackClient(),
      });
      expect(replyMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(600_000);
      expect(authTest).toHaveBeenCalledTimes(7);
    } finally {
      monitor.controller.abort();
      await monitor.run;
      vi.useRealTimers();
    }
  });

  it("rejects enterprise startup with the default pairing DM policy", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          enterpriseOrgInstall: true,
        },
      },
    });

    const monitor = startSlackMonitor(monitorSlackProvider);
    await expect(monitor.run).rejects.toThrow(
      /supports DMs only with dm\.enabled=false.*dmPolicy="open"/,
    );
  });
});
