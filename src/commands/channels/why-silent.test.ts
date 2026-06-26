import { describe, expect, it } from "vitest";
import { buildChannelsWhySilentReport, formatChannelsWhySilentReport } from "./why-silent.js";

describe("buildChannelsWhySilentReport", () => {
  it("flags a Slack message newer than account inbound activity when reconciliation has not checked", () => {
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

    expect(report.verdict).toBe("reconciliation-not-checked");
    expect(report.explanation).toContain("reconciliation has not checked");
    expect(report.newestMessage).toMatchObject({
      ts: "1700000006.500000",
      at: 1_700_000_006_500,
      user: "U123",
      textPreview: "QUACK",
    });
  });

  it("reports a receiver-active admission gap when reconciliation has checked and raw Slack receiver activity is current", () => {
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
        lastSocketEnvelopeAt: 1_700_000_006_900,
        lastSlackEventAt: 1_700_000_006_900,
        slackTelemetry: {
          rawSlackEvents: 10,
          messageEvents: 4,
          droppedEvents: 2,
          admissionsRecorded: 3,
        },
        reconciliationStatus: {
          enabled: true,
          lastScanAt: 1_700_000_007_000,
          missingCandidates: 0,
          recoveredCandidates: 0,
          failedCandidates: 0,
        },
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "hello",
        },
      ],
    });

    expect(report.verdict).toBe("receiver-active-admission-gap");
    expect(report.explanation).toContain("receiver activity");
    const lines = formatChannelsWhySilentReport(report);
    const text = lines.join("\n");
    expect(text).toContain("Last socket envelope: 2023-11-14T22:13:26.900Z");
    expect(text).toContain("Last Slack event: 2023-11-14T22:13:26.900Z");
    expect(lines).toContain("Slack counters: raw=10, messages=4, dropped=2, admissions=3");
    expect(text).toContain("Slack reconciliation: lastScan=2023-11-14T22:13:27.000Z");
    expect(text).not.toContain("Last transport:");
  });

  it("uses recent reconciliation candidate status before generic receiver state", () => {
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
        lastSocketEnvelopeAt: 1_700_000_006_900,
        lastSlackEventAt: 1_700_000_006_900,
        reconciliationStatus: {
          enabled: true,
          lastScanAt: 1_700_000_007_000,
          missingCandidates: 1,
          recoveredCandidates: 0,
          failedCandidates: 0,
          recentCandidates: [
            {
              channel: "C123",
              ts: "1700000006.500000",
              status: "missing-admission",
              reason: "eligible-missing-admission",
              lastSeenAt: "2023-11-14T22:13:27.000Z",
            },
          ],
        },
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "hello",
        },
      ],
    });

    expect(report.verdict).toBe("reconciliation-found-missing");
    expect(report.explanation).toContain("Auto recovery is not enabled");
  });

  it("reports current Slack socket lifecycle errors as receiver problems", () => {
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
        lastSocketConnectedAt: 1_700_000_000_000,
        lastSocketError: { at: 1_700_000_009_000, error: "socket failed" },
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "hello",
        },
      ],
    });

    expect(report.verdict).toBe("socket-receiver-problem");
    expect(report.explanation).toContain("Slack/network receiver problem");
  });

  it("does not use Slack-specific receiver wording for other channel outages", () => {
    const report = buildChannelsWhySilentReport({
      channel: "discord",
      accountId: "default",
      target: "channel:C123",
      now: 1_700_000_010_000,
      account: {
        accountId: "default",
        running: true,
        connected: false,
        lastStartAt: 1_699_999_000_000,
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "hello",
        },
      ],
    });

    expect(report.verdict).not.toBe("socket-receiver-problem");
    expect(report.explanation).not.toContain("Slack/network receiver problem");
  });

  it("reports current Slack policy-drop telemetry before generic admission gaps", () => {
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
        lastSocketEnvelopeAt: 1_700_000_006_900,
        lastSlackEventAt: 1_700_000_006_900,
        slackTelemetry: {
          rawSlackEvents: 10,
          messageEvents: 4,
          droppedEvents: 1,
          droppedPolicyEvents: 1,
          admissionsRecorded: 1,
        },
        reconciliationStatus: {
          enabled: true,
          lastScanAt: 1_700_000_007_000,
          missingCandidates: 0,
          recoveredCandidates: 0,
          failedCandidates: 0,
        },
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "hello",
        },
      ],
      admissionRecords: [
        {
          accountId: "soylei",
          channel: "C123",
          ts: "1700000006.500000",
          outcome: "dropped",
          reason: "channel-user-not-allowed",
        },
      ],
    });

    expect(report.verdict).toBe("receiver-dropped-by-policy");
    expect(report.explanation).toContain("admission ledger drop by policy");
    expect(formatChannelsWhySilentReport(report)).toContain(
      "Slack counters: raw=10, messages=4, dropped=1, policyDrops=1, admissions=1",
    );
  });

  it("does not treat cumulative Slack drop counters as candidate-specific proof", () => {
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
        lastSocketEnvelopeAt: 1_700_000_006_900,
        lastSlackEventAt: 1_700_000_006_900,
        slackTelemetry: {
          rawSlackEvents: 10,
          messageEvents: 4,
          droppedEvents: 1,
          droppedPolicyEvents: 1,
          admissionsRecorded: 1,
        },
        reconciliationStatus: {
          enabled: true,
          lastScanAt: 1_700_000_007_000,
          missingCandidates: 0,
          recoveredCandidates: 0,
          failedCandidates: 0,
        },
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "hello",
        },
      ],
    });

    expect(report.verdict).toBe("receiver-active-admission-gap");
  });

  it("uses accepted Slack admission ledger records as candidate-specific proof", () => {
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
        lastSocketEnvelopeAt: 1_700_000_006_900,
        lastSlackEventAt: 1_700_000_006_900,
        reconciliationStatus: {
          enabled: true,
          lastScanAt: 1_700_000_007_000,
          missingCandidates: 0,
          recoveredCandidates: 0,
          failedCandidates: 0,
        },
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "hello",
        },
      ],
      admissionRecords: [
        {
          accountId: "soylei",
          channel: "C123",
          ts: "1700000006.500000",
          outcome: "accepted",
        },
      ],
    });

    expect(report.verdict).toBe("account-inbound-after-message");
    expect(report.explanation).toContain("admission ledger proof");
  });

  it("keeps candidate-specific Slack admission proof ahead of current socket state", () => {
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
        lastSocketConnectedAt: 1_700_000_000_000,
        lastSocketError: { at: 1_700_000_009_000, error: "socket failed" },
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "hello",
        },
      ],
      admissionRecords: [
        {
          accountId: "soylei",
          channel: "C123",
          ts: "1700000006.500000",
          outcome: "accepted",
        },
      ],
    });

    expect(report.verdict).toBe("account-inbound-after-message");
  });

  it("uses self-bot Slack admission ledger drops even when no inbound candidate exists", () => {
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
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U_BOT",
          bot_id: "B123",
          text: "bot reply",
        },
      ],
      admissionRecords: [
        {
          accountId: "soylei",
          channel: "C123",
          ts: "1700000006.500000",
          outcome: "dropped",
          reason: "bot-self",
        },
      ],
    });

    expect(report.verdict).toBe("receiver-dropped-self-bot");
  });

  it("does not treat replay Slack admission ledger records as original admission proof", () => {
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
        lastSocketEnvelopeAt: 1_700_000_006_900,
        lastSlackEventAt: 1_700_000_006_900,
        reconciliationStatus: {
          enabled: true,
          lastScanAt: 1_700_000_007_000,
          missingCandidates: 0,
          recoveredCandidates: 0,
          failedCandidates: 0,
        },
      },
      messages: [
        {
          ts: "1700000006.500000",
          user: "U123",
          text: "hello",
        },
      ],
      admissionRecords: [
        {
          accountId: "soylei",
          channel: "C123",
          ts: "1700000006.500000",
          outcome: "replay-failed",
        },
      ],
    });

    expect(report.verdict).toBe("receiver-active-admission-gap");
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
