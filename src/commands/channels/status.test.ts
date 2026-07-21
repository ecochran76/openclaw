import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatGatewayChannelsStatusLines } from "./status.js";

describe("formatGatewayChannelsStatusLines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-30T17:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces Slack receiver and admission counters without relying on transport age", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelAccounts: {
        slack: [
          {
            accountId: "soylei",
            running: true,
            connected: true,
            healthState: "healthy",
            lastSocketEnvelopeAt: Date.parse("2026-05-30T16:59:40.000Z"),
            lastSlackEventAt: Date.parse("2026-05-30T16:59:45.000Z"),
            slackTelemetry: {
              rawSlackEvents: 9,
              messageEvents: 4,
              droppedEvents: 2,
              droppedPolicyEvents: 1,
              droppedSelfBotEvents: 5,
              admissionsRecorded: 3,
              dispatchFailures: 1,
            },
          },
        ],
      },
    });

    const text = lines.join("\n");
    expect(text).toContain("socket-envelope:");
    expect(text).toContain("slack-event:");
    expect(text).toContain(
      "slack:raw=9,messages=4,dropped=2,policyDrops=1,selfBotDrops=5,admissions=3,dispatchFailures=1",
    );
    expect(text).not.toContain("transport:");
  });
});
