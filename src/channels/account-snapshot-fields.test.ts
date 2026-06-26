// Account snapshot field tests cover channel account snapshot serialization fields.
import { describe, expect, it } from "vitest";
import { projectSafeChannelAccountSnapshotFields } from "./account-snapshot-fields.js";

describe("projectSafeChannelAccountSnapshotFields", () => {
  it("omits webhook and public-key style fields from generic snapshots", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      name: "Primary",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      signingSecretSource: "config", // pragma: allowlist secret
      signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
      webhookUrl: "https://example.com/webhook",
      webhookPath: "/webhook",
      audienceType: "project-number",
      audience: "1234567890",
      publicKey: "pk_live_123",
    });

    expect(snapshot).toEqual({
      name: "Primary",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      signingSecretSource: "config", // pragma: allowlist secret
      signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
    });
  });

  it("strips embedded credentials from baseUrl fields", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      baseUrl: "https://bob:secret@chat.example.test",
    });

    expect(snapshot).toEqual({
      baseUrl: "https://chat.example.test/",
    });
  });

  it("preserves non-secret transport liveness timestamps", () => {
    const snapshot = projectSafeChannelAccountSnapshotFields({
      connected: true,
      lastConnectedAt: 123,
      lastInboundAt: 123,
      lastOutboundAt: 234,
      lastMessageAt: null,
      lastEventAt: 345,
      lastTransportActivityAt: 456,
      lastSocketConnectedAt: 567,
      lastSocketDisconnectedAt: 678,
      lastSocketReconnectAt: 789,
      lastSocketEnvelopeAt: 890,
      lastSlackEventAt: 901,
      socketActiveState: "active",
      socketActiveStateAvailable: true,
      socketConnectionCount: 2,
      socketModeSettings: {
        clientPingTimeout: 15_000,
        connectionCount: 2,
        serverPingTimeout: 30_000,
        pingPongLoggingEnabled: false,
        token: "ignored",
      },
      socketConnections: {
        primary: { connected: true },
      },
      lastSocketDisconnectReason: {
        at: 902,
        reason: "refresh_requested",
        kind: "refresh",
        expectedRefresh: true,
      },
      lastSocketError: { at: 912, error: "socket failed" },
      slackTelemetry: {
        rawSlackEvents: 2,
        dispatchFailures: 1,
        ignored: "secret",
      },
      reconciliationStatus: {
        enabled: true,
        lastScanAt: 999,
        missingCandidates: 1,
        statePath: "/Users/example/.openclaw/slack/reconciliation/work.json",
        recentCandidates: [
          {
            channel: "C123",
            ts: "1.000000",
            status: "missing-admission",
            reason: "eligible-missing-admission",
          },
        ],
      },
      channelAccessToken: "line-token",
      channelSecret: "line-secret", // pragma: allowlist secret
      probe: { ok: true, token: "probe-secret" },
    });

    expect(snapshot).toEqual({
      connected: true,
      lastConnectedAt: 123,
      lastInboundAt: 123,
      lastOutboundAt: 234,
      lastMessageAt: null,
      lastEventAt: 345,
      lastTransportActivityAt: 456,
      lastSocketConnectedAt: 567,
      lastSocketDisconnectedAt: 678,
      lastSocketReconnectAt: 789,
      lastSocketEnvelopeAt: 890,
      lastSlackEventAt: 901,
      socketActiveState: "active",
      socketActiveStateAvailable: true,
      socketConnectionCount: 2,
      socketModeSettings: {
        clientPingTimeout: 15_000,
        connectionCount: 2,
        serverPingTimeout: 30_000,
        pingPongLoggingEnabled: false,
      },
      socketConnections: {
        primary: { connected: true },
      },
      lastSocketDisconnectReason: {
        at: 902,
        reason: "refresh_requested",
        kind: "refresh",
        expectedRefresh: true,
      },
      lastSocketError: { at: 912, error: "socket failed" },
      slackTelemetry: {
        rawSlackEvents: 2,
        dispatchFailures: 1,
      },
      reconciliationStatus: {
        enabled: true,
        lastScanAt: 999,
        missingCandidates: 1,
        recentCandidates: [
          {
            channel: "C123",
            ts: "1.000000",
            status: "missing-admission",
            reason: "eligible-missing-admission",
          },
        ],
      },
    });
  });
});
