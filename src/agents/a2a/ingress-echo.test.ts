import { describe, expect, it, vi } from "vitest";
import type { IngressEchoPolicy } from "../tools/sessions-send-helpers.js";
import { attemptIngressEcho, type IngressEchoDeps } from "./ingress-echo.js";

const basePolicy: IngressEchoPolicy = {
  enabled: true,
  requireDelivery: false,
};

function makeGatewayCallStub(
  impl: (opts: unknown) => Promise<Record<string, unknown>>,
): NonNullable<IngressEchoDeps["callGateway"]> {
  return vi.fn(impl) as unknown as NonNullable<IngressEchoDeps["callGateway"]>;
}

describe("ingress-echo", () => {
  it("returns disabled when the policy is off", async () => {
    const callGateway = vi.fn();
    const resolveAnnounceTarget = vi.fn();

    const result = await attemptIngressEcho(
      {
        policy: { enabled: false, requireDelivery: false },
        sessionKey: "discord:group:target",
        displayKey: "discord:group:target",
        message: "hello",
      },
      { callGateway, resolveAnnounceTarget },
    );

    expect(result).toEqual({
      ingressEcho: { status: "disabled" },
      requiredFailure: false,
    });
    expect(resolveAnnounceTarget).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("sends ingress echo and preserves the success shape", async () => {
    const callGateway = makeGatewayCallStub(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { message?: string } };
      expect(request.method).toBe("send");
      expect(request.params?.message).toContain("A2A ingress echo:");
      return { messageId: "m-ingress", threadId: "thread-override" };
    });
    const resolveAnnounceTarget = vi.fn(async () => ({
      channel: "discord",
      to: "group:target",
      accountId: "acct-1",
      threadId: "thread-1",
    }));

    const result = await attemptIngressEcho(
      {
        policy: basePolicy,
        sessionKey: "discord:group:target",
        displayKey: "discord:group:target",
        requesterSessionKey: "discord:group:req",
        requesterChannel: "discord",
        message: "ping",
      },
      { callGateway, resolveAnnounceTarget },
    );

    expect(result).toEqual({
      ingressEcho: {
        status: "sent",
        channel: "discord",
        to: "group:target",
        accountId: "acct-1",
        threadId: "thread-override",
        messageId: "m-ingress",
      },
      requiredFailure: false,
    });
    expect(resolveAnnounceTarget).toHaveBeenCalledOnce();
  });

  it("returns not_applicable in best-effort mode when no target can be resolved", async () => {
    const callGateway = vi.fn();
    const resolveAnnounceTarget = vi.fn(async () => null);

    const result = await attemptIngressEcho(
      {
        policy: basePolicy,
        sessionKey: "agent:main:main",
        displayKey: "main",
        message: "ping",
      },
      { callGateway, resolveAnnounceTarget },
    );

    expect(result).toEqual({
      ingressEcho: { status: "not_applicable" },
      requiredFailure: false,
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("blocks when a strict target cannot be resolved", async () => {
    const callGateway = vi.fn();
    const resolveAnnounceTarget = vi.fn(async () => null);

    const result = await attemptIngressEcho(
      {
        policy: { enabled: true, requireDelivery: true },
        sessionKey: "agent:main:main",
        displayKey: "main",
        message: "ping",
      },
      { callGateway, resolveAnnounceTarget },
    );

    expect(result).toEqual({
      ingressEcho: {
        status: "blocked",
        error: "No ingress echo target could be resolved.",
      },
      requiredFailure: true,
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("returns blocked on strict delivery failure", async () => {
    const callGateway = makeGatewayCallStub(async (_opts: unknown) => {
      throw new Error("send failed");
    });
    const resolveAnnounceTarget = vi.fn(async () => ({
      channel: "discord",
      to: "group:target",
      accountId: "acct-1",
      threadId: "thread-1",
    }));

    const result = await attemptIngressEcho(
      {
        policy: { enabled: true, requireDelivery: true },
        sessionKey: "discord:group:target",
        displayKey: "discord:group:target",
        message: "ping",
      },
      { callGateway, resolveAnnounceTarget },
    );

    expect(result).toEqual({
      ingressEcho: {
        status: "blocked",
        channel: "discord",
        to: "group:target",
        accountId: "acct-1",
        threadId: "thread-1",
        error: "send failed",
      },
      requiredFailure: true,
    });
  });
});
