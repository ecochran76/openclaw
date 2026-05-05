import { describe, expect, it } from "vitest";
import { buildChannelsWhySilentReport } from "./why-silent.js";

describe("buildChannelsWhySilentReport", () => {
  it("flags a Slack message newer than account inbound activity as likely not ingested", () => {
    const report = buildChannelsWhySilentReport({
      channel: "slack",
      accountId: "soylei",
      target: "channel:C123",
      now: 1_700_000_010_000,
      account: {
        accountId: "soylei",
        running: true,
        connected: true,
        lastStartAt: 1_699_999_000_000,
        lastInboundAt: 1_700_000_000_000,
        lastTransportActivityAt: 1_700_000_005_000,
      },
      messages: [
        {
          ts: "1700000008.500000",
          bot_id: "B123",
          text: "bot reply",
        },
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "QUACK",
        },
      ],
    });

    expect(report.verdict).toBe("likely-not-ingested");
    expect(report.explanation).toContain("newer message");
    expect(report.newestMessage).toMatchObject({
      ts: "1700000006.500000",
      at: 1_700_000_006_500,
      user: "U123",
      textPreview: "QUACK",
    });
  });

  it("reports account-level inbound activity after the newest message as a routing-level problem", () => {
    const report = buildChannelsWhySilentReport({
      channel: "slack",
      accountId: "soylei",
      target: "channel:C123",
      now: 1_700_000_010_000,
      account: {
        accountId: "soylei",
        running: true,
        connected: true,
        lastStartAt: 1_699_999_000_000,
        lastInboundAt: 1_700_000_009_000,
        lastTransportActivityAt: 1_700_000_009_500,
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "hello",
        },
      ],
    });

    expect(report.verdict).toBe("account-inbound-after-message");
    expect(report.explanation).toContain("routing");
  });

  it("handles empty channel history", () => {
    const report = buildChannelsWhySilentReport({
      channel: "slack",
      accountId: "soylei",
      target: "channel:C123",
      messages: [],
    });

    expect(report.verdict).toBe("no-messages");
  });

  it("does not infer ingestion from a message before the current gateway lifecycle", () => {
    const report = buildChannelsWhySilentReport({
      channel: "slack",
      accountId: "soylei",
      target: "channel:C123",
      account: {
        accountId: "soylei",
        running: true,
        connected: true,
        lastStartAt: 1_700_000_010_000,
        lastInboundAt: null,
        lastTransportActivityAt: 1_700_000_012_000,
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "hello",
        },
      ],
    });

    expect(report.verdict).toBe("message-before-current-lifecycle");
  });
});
