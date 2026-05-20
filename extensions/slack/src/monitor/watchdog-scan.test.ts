import { describe, expect, it } from "vitest";
import type { SlackAdmissionRecord } from "./admission-ledger.js";
import { scanSlackAdmissionGaps } from "./watchdog-scan.js";

function admission(overrides: Partial<SlackAdmissionRecord>): SlackAdmissionRecord {
  return {
    version: 1,
    recordedAt: "2026-05-20T20:00:00.000Z",
    accountId: "soylei",
    channel: "C123",
    ts: "1779309189.369149",
    outcome: "accepted",
    ...overrides,
  };
}

describe("scanSlackAdmissionGaps", () => {
  it("classifies accepted and dropped messages from the admission ledger", () => {
    const report = scanSlackAdmissionGaps({
      accountId: "soylei",
      channel: "C123",
      botUserIds: ["UOPENCLAW"],
      messages: [
        { channel: "C123", ts: "1.000001", user: "U1", text: "<@UOPENCLAW> status?" },
        { channel: "C123", ts: "1.000002", user: "U1", text: "background chatter" },
      ],
      ledgerRecords: [
        admission({ ts: "1.000001", outcome: "accepted", routeAgentId: "main" }),
        admission({ ts: "1.000002", outcome: "dropped", reason: "slack-no-mention" }),
      ],
    });

    expect(report.counts).toEqual({
      admitted: 1,
      "explicitly-ignored": 1,
      "missing-admission": 0,
      "not-relevant": 0,
    });
    expect(report.records[0]).toMatchObject({
      verdict: "admitted",
      reason: "ledger-accepted",
      ledgerRecord: { routeAgentId: "main" },
    });
    expect(report.records[1]).toMatchObject({
      verdict: "explicitly-ignored",
      reason: "slack-no-mention",
    });
  });

  it("flags activated human messages without a ledger record as missing admission", () => {
    const report = scanSlackAdmissionGaps({
      accountId: "soylei",
      channel: "C123",
      botUserIds: ["UOPENCLAW"],
      messages: [{ channel: "C123", ts: "1.000003", user: "U1", text: "<@UOPENCLAW> status?" }],
      ledgerRecords: [],
    });

    expect(report.counts["missing-admission"]).toBe(1);
    expect(report.records[0]).toMatchObject({
      verdict: "missing-admission",
      reason: "activation-without-ledger-record",
    });
  });

  it("matches ledger records by timestamp when Slack history omits client_msg_id", () => {
    const report = scanSlackAdmissionGaps({
      accountId: "soylei",
      channel: "C123",
      botUserIds: ["UOPENCLAW"],
      messages: [{ channel: "C123", ts: "1.000008", user: "U1", text: "<@UOPENCLAW> status?" }],
      ledgerRecords: [
        admission({
          ts: "1.000008",
          clientMsgId: "client-1",
          outcome: "accepted",
        }),
      ],
    });

    expect(report.records[0]?.verdict).toBe("admitted");
  });

  it("treats DM and active-thread human messages as relevant", () => {
    const dmReport = scanSlackAdmissionGaps({
      accountId: "soylei",
      channel: "D123",
      directMessage: true,
      messages: [{ channel: "D123", ts: "1.000004", user: "U1", text: "status?" }],
      ledgerRecords: [],
    });
    const threadReport = scanSlackAdmissionGaps({
      accountId: "soylei",
      channel: "C123",
      activeThreadTs: ["1.000000"],
      messages: [
        {
          channel: "C123",
          ts: "1.000005",
          thread_ts: "1.000000",
          user: "U1",
          text: "follow-up",
        },
      ],
      ledgerRecords: [],
    });

    expect(dmReport.records[0]?.verdict).toBe("missing-admission");
    expect(threadReport.records[0]?.verdict).toBe("missing-admission");
  });

  it("treats allowlisted messages in requireMention=false channels as relevant", () => {
    const report = scanSlackAdmissionGaps({
      accountId: "soylei",
      channel: "C123",
      channelRequiresMention: false,
      allowedUserIds: ["U012ETLV6NQ"],
      messages: [{ channel: "C123", ts: "1.000009", user: "U012ETLV6NQ", text: "plain ask" }],
      ledgerRecords: [],
    });

    expect(report.records[0]).toMatchObject({
      verdict: "missing-admission",
      reason: "activation-without-ledger-record",
    });
  });

  it("does not flag non-allowlisted requireMention=false channel chatter", () => {
    const report = scanSlackAdmissionGaps({
      accountId: "soylei",
      channel: "C123",
      channelRequiresMention: false,
      allowedUserIds: ["U012ETLV6NQ"],
      messages: [{ channel: "C123", ts: "1.000010", user: "UNOTLISTED", text: "plain ask" }],
      ledgerRecords: [],
    });

    expect(report.records[0]).toMatchObject({
      verdict: "not-relevant",
      reason: "sender-not-allowlisted",
    });
  });

  it("does not flag bot messages or unactivated channel chatter", () => {
    const report = scanSlackAdmissionGaps({
      accountId: "soylei",
      channel: "C123",
      botUserIds: ["UOPENCLAW"],
      messages: [
        { channel: "C123", ts: "1.000006", bot_id: "B1", text: "<@UOPENCLAW> synthetic" },
        { channel: "C123", ts: "1.000007", user: "U1", text: "plain chatter" },
      ],
      ledgerRecords: [],
    });

    expect(report.counts).toEqual({
      admitted: 0,
      "explicitly-ignored": 0,
      "missing-admission": 0,
      "not-relevant": 2,
    });
    expect(report.records.map((record) => record.reason)).toEqual([
      "bot-message",
      "no-activation-signal",
    ]);
  });
});
