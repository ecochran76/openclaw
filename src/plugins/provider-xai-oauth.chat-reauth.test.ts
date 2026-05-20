import { afterEach, describe, expect, it, vi } from "vitest";
import { xaiChatReauthCapability } from "./provider-xai-oauth.js";

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function createJwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

describe("provider-xai chat reauth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates an xAI device-code authorization for Slack reauth", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          device_authorization_endpoint: "https://auth.x.ai/oauth/device/code",
          token_endpoint: "https://auth.x.ai/oauth/token",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: "device-code-1",
          user_code: "GROK-1234",
          verification_uri: "https://auth.x.ai/device",
          verification_uri_complete: "https://auth.x.ai/device?user_code=GROK-1234",
          expires_in: 900,
          interval: 7,
        }),
      );

    const pending = await xaiChatReauthCapability.createPendingAuthorization({
      preferredFlow: "device_code",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pending).toMatchObject({
      flow: "device_code",
      deviceAuthId: "device-code-1",
      userCode: "GROK-1234",
      verificationUrl: "https://auth.x.ai/device?user_code=GROK-1234",
      intervalMs: 7_000,
    });
  });

  it("returns null while xAI device-code authorization is pending", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          device_authorization_endpoint: "https://auth.x.ai/oauth/device/code",
          token_endpoint: "https://auth.x.ai/oauth/token",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "authorization_pending",
          },
          { status: 400 },
        ),
      );

    await expect(
      xaiChatReauthCapability.pollPendingAuthorization?.({
        pending: {
          deviceAuthId: "device-code-1",
          userCode: "GROK-1234",
          intervalMs: 5_000,
          expiresAt: Date.now() + 60_000,
        },
      }),
    ).resolves.toBeNull();
  });

  it("exchanges an approved xAI device code for OAuth credentials", async () => {
    const idToken = createJwt({
      email: "user@example.com",
      name: "Grok User",
      sub: "acct_xai_123",
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          device_authorization_endpoint: "https://auth.x.ai/oauth/device/code",
          token_endpoint: "https://auth.x.ai/oauth/token",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          id_token: idToken,
        }),
      );

    await expect(
      xaiChatReauthCapability.pollPendingAuthorization?.({
        pending: {
          deviceAuthId: "device-code-1",
          userCode: "GROK-1234",
          intervalMs: 5_000,
          expiresAt: Date.now() + 60_000,
        },
      }),
    ).resolves.toMatchObject({
      access: "access-token",
      refresh: "refresh-token",
      email: "user@example.com",
      displayName: "Grok User",
      accountId: "acct_xai_123",
      authFlow: "device-code",
    });
  });
});
