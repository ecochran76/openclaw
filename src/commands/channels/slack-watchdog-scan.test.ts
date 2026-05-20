import { describe, expect, it, vi } from "vitest";
import {
  channelsSlackWatchdogScanCommand,
  parseSlackWatchdogDurationMs,
  parseSlackWatchdogTarget,
} from "./slack-watchdog-scan.js";

function createRuntime() {
  return {
    logs: [] as string[],
    log(message: string) {
      this.logs.push(message);
    },
    writeStdout(message: string) {
      this.logs.push(message);
    },
    writeStderr(message: string) {
      this.logs.push(message);
    },
    writeJson(value: unknown) {
      this.logs.push(JSON.stringify(value));
    },
    exit(code?: number): never {
      throw new Error(`exit:${code ?? 0}`);
    },
  };
}

describe("parseSlackWatchdogDurationMs", () => {
  it("parses common bounded scan durations", () => {
    expect(parseSlackWatchdogDurationMs("30m", 1)).toBe(1_800_000);
    expect(parseSlackWatchdogDurationMs("2h", 1)).toBe(7_200_000);
    expect(parseSlackWatchdogDurationMs(undefined, 123)).toBe(123);
  });

  it("rejects ambiguous durations", () => {
    expect(() => parseSlackWatchdogDurationMs("later", 1)).toThrow("Invalid watchdog duration");
  });
});

describe("parseSlackWatchdogTarget", () => {
  it("normalizes channel targets and detects DMs", () => {
    expect(parseSlackWatchdogTarget("channel:C123")).toEqual({
      channelId: "C123",
      directMessage: false,
    });
    expect(parseSlackWatchdogTarget("D123")).toEqual({
      channelId: "D123",
      directMessage: true,
    });
  });
});

describe("channelsSlackWatchdogScanCommand", () => {
  it("scans Slack history directly and reports missing admissions", async () => {
    const runtime = createRuntime();
    const scanSlackAdmissionGaps = vi.fn(() => ({
      accountId: "soylei",
      channel: "C123",
      scanned: 1,
      counts: {
        admitted: 0,
        "explicitly-ignored": 0,
        "not-relevant": 0,
        "missing-admission": 1,
      },
      records: [
        {
          accountId: "soylei",
          channel: "C123",
          ts: "1779309189.369149",
          verdict: "missing-admission",
          reason: "activation-without-ledger-record",
        },
      ],
    }));
    const readSlackMessages = vi.fn(async () => ({
      messages: [{ ts: "1779309189.369149", text: "<@UOPENCLAW> status?", user: "U1" }],
      hasMore: false,
    }));
    const readSlackAdmissionRecords = vi.fn(async () => []);
    const authTest = vi.fn(async () => ({ user_id: "UOPENCLAW" }));

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C123",
        since: "30m",
      },
      runtime,
      {
        cfg: { channels: { slack: {} } } as never,
        now: new Date("2026-05-20T21:00:00.000Z"),
        slackApi: {
          createSlackWebClient: vi.fn(() => ({ auth: { test: authTest } }) as never),
          readSlackAdmissionRecords,
          readSlackMessages,
          resolveSlackChannelConfig: vi.fn(() => ({
            allowed: true,
            requireMention: true,
          })),
          resolveSlackAccount: vi.fn(
            () =>
              ({
                accountId: "soylei",
                botToken: "xoxb-test",
                config: {},
              }) as never,
          ),
          scanSlackAdmissionGaps,
        },
      },
    );

    expect(readSlackMessages).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({
        accountId: "soylei",
        after: "1779309000",
        limit: 50,
      }),
    );
    expect(readSlackAdmissionRecords).toHaveBeenCalledWith({
      accountId: "soylei",
      limit: 5000,
    });
    expect(scanSlackAdmissionGaps).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "soylei",
        channel: "C123",
        botUserIds: ["UOPENCLAW"],
      }),
    );
    expect(runtime.logs.join("\n")).toContain("Missing admissions:");
    expect(runtime.logs.join("\n")).toContain("1779309189.369149");
  });

  it("uses explicit bot user id without auth.test", async () => {
    const authTest = vi.fn(async () => ({ user_id: "UOPENCLAW" }));

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C123",
        botUser: "UCONFIGURED",
        json: true,
      },
      createRuntime(),
      {
        cfg: { channels: { slack: {} } } as never,
        slackApi: {
          createSlackWebClient: vi.fn(() => ({ auth: { test: authTest } }) as never),
          readSlackAdmissionRecords: vi.fn(async () => []),
          readSlackMessages: vi.fn(async () => ({ messages: [], hasMore: false })),
          resolveSlackChannelConfig: vi.fn(() => ({
            allowed: true,
            requireMention: true,
          })),
          resolveSlackAccount: vi.fn(
            () =>
              ({
                accountId: "soylei",
                botToken: "xoxb-test",
                config: {},
              }) as never,
          ),
          scanSlackAdmissionGaps: vi.fn(() => ({
            accountId: "soylei",
            channel: "C123",
            scanned: 0,
            counts: {
              admitted: 0,
              "explicitly-ignored": 0,
              "not-relevant": 0,
              "missing-admission": 0,
            },
            records: [],
          })),
        },
      },
    );

    expect(authTest).not.toHaveBeenCalled();
  });

  it("passes requireMention=false channel policy into the scanner", async () => {
    const scanSlackAdmissionGaps = vi.fn(() => ({
      accountId: "soylei",
      channel: "C0B0AK14B7X",
      scanned: 1,
      counts: {
        admitted: 0,
        "explicitly-ignored": 0,
        "not-relevant": 0,
        "missing-admission": 1,
      },
      records: [],
    }));

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        botUser: "UOPENCLAW",
      },
      createRuntime(),
      {
        cfg: { channels: { slack: {} } } as never,
        slackApi: {
          createSlackWebClient: vi.fn(() => ({ auth: { test: vi.fn() } }) as never),
          readSlackAdmissionRecords: vi.fn(async () => []),
          readSlackMessages: vi.fn(async () => ({
            messages: [{ ts: "1779318546.276599", user: "U012ETLV6NQ", text: "plain ask" }],
            hasMore: false,
          })),
          resolveSlackChannelConfig: vi.fn(() => ({
            allowed: true,
            requireMention: false,
            users: ["U012ETLV6NQ"],
          })),
          resolveSlackAccount: vi.fn(
            () =>
              ({
                accountId: "soylei",
                botToken: "xoxb-test",
                config: {
                  channels: {
                    C0B0AK14B7X: {
                      requireMention: false,
                      users: ["U012ETLV6NQ"],
                    },
                  },
                },
              }) as never,
          ),
          scanSlackAdmissionGaps,
        },
      },
    );

    expect(scanSlackAdmissionGaps).toHaveBeenCalledWith(
      expect.objectContaining({
        channelRequiresMention: false,
        allowedUserIds: ["U012ETLV6NQ"],
      }),
    );
  });
});
