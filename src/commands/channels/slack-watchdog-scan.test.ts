import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  channelsSlackWatchdogScanCommand,
  parseSlackWatchdogDurationMs,
  parseSlackWatchdogTarget,
  resolveSlackWatchdogLedgerPath,
} from "./slack-watchdog-scan.js";

const tempDirs: string[] = [];

async function makeTempState() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watchdog-scan-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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

async function writeLedger(
  stateDir: string,
  accountId: string,
  records: Array<Record<string, unknown>>,
) {
  const ledgerPath = resolveSlackWatchdogLedgerPath({
    accountId,
    env: { OPENCLAW_STATE_DIR: stateDir },
  });
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.writeFile(ledgerPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
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
  it("reads Slack history through the gateway and reports missing admissions", async () => {
    const runtime = createRuntime();
    const callGateway = vi.fn(async () => ({
      payload: {
        messages: [
          {
            channel: "C123",
            ts: "1779309189.369149",
            text: "<@UOPENCLAW> status?",
            user: "U1",
          },
        ],
      },
    }));

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C123",
        since: "30m",
        botUser: "UOPENCLAW",
      },
      runtime,
      {
        cfg: { channels: { slack: {} } } as never,
        now: new Date("2026-05-20T21:00:00.000Z"),
        env: { OPENCLAW_STATE_DIR: await makeTempState() },
        callGateway,
      },
    );

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "message.action",
        params: expect.objectContaining({
          channel: "slack",
          action: "read",
          accountId: "soylei",
          params: expect.objectContaining({
            to: "channel:C123",
            after: "1779309000",
            limit: 50,
          }),
        }),
      }),
    );
    expect(runtime.logs.join("\n")).toContain("Missing admissions:");
    expect(runtime.logs.join("\n")).toContain("1779309189.369149");
  });

  it("marks matching ledger records as admitted", async () => {
    const stateDir = await makeTempState();
    await writeLedger(stateDir, "soylei", [
      {
        version: 1,
        recordedAt: "2026-05-20T23:17:51.389Z",
        accountId: "soylei",
        channel: "C123",
        ts: "1779309189.369149",
        outcome: "accepted",
        routeAgentId: "soylei-primary",
      },
    ]);
    const runtime = createRuntime();

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C123",
        botUser: "UOPENCLAW",
        json: true,
      },
      runtime,
      {
        cfg: { channels: { slack: {} } } as never,
        env: { OPENCLAW_STATE_DIR: stateDir },
        callGateway: vi.fn(async () => ({
          payload: {
            messages: [
              {
                channel: "C123",
                ts: "1779309189.369149",
                text: "<@UOPENCLAW> status?",
                user: "U1",
              },
            ],
          },
        })),
      },
    );

    const report = JSON.parse(runtime.logs[0] ?? "{}") as { counts?: Record<string, number> };
    expect(report.counts?.admitted).toBe(1);
    expect(report.counts?.["missing-admission"]).toBe(0);
  });

  it("uses requireMention=false channel policy and sender allowlist", async () => {
    const runtime = createRuntime();

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        json: true,
      },
      runtime,
      {
        cfg: {
          channels: {
            slack: {
              accounts: {
                soylei: {
                  channels: {
                    C0B0AK14B7X: {
                      requireMention: false,
                      users: ["U012ETLV6NQ"],
                    },
                  },
                },
              },
            },
          },
        } as never,
        env: { OPENCLAW_STATE_DIR: await makeTempState() },
        callGateway: vi.fn(async () => ({
          payload: {
            messages: [
              {
                channel: "C0B0AK14B7X",
                ts: "1779318546.276599",
                user: "U012ETLV6NQ",
                text: "plain ask",
              },
              {
                channel: "C0B0AK14B7X",
                ts: "1779318547.276599",
                user: "UNOTLISTED",
                text: "plain chatter",
              },
            ],
          },
        })),
      },
    );

    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      counts?: Record<string, number>;
      records?: Array<{ ts?: string; verdict?: string; reason?: string }>;
    };
    expect(report.counts?.["missing-admission"]).toBe(1);
    expect(report.counts?.["not-relevant"]).toBe(1);
    expect(report.records).toContainEqual(
      expect.objectContaining({
        ts: "1779318547.276599",
        verdict: "not-relevant",
        reason: "sender-not-allowlisted",
      }),
    );
  });

  it("infers active Slack threads from accepted admission ledger records", async () => {
    const stateDir = await makeTempState();
    await writeLedger(stateDir, "soylei", [
      {
        version: 1,
        recordedAt: "2026-05-20T23:17:51.389Z",
        accountId: "soylei",
        channel: "C0B0AK14B7X",
        ts: "1779319161.100189",
        threadTs: "1779318546.276599",
        outcome: "accepted",
        routeAgentId: "soylei-primary",
      },
    ]);
    const runtime = createRuntime();

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        json: true,
      },
      runtime,
      {
        cfg: {
          channels: {
            slack: {
              accounts: {
                soylei: {
                  channels: {
                    C0B0AK14B7X: {
                      requireMention: true,
                      users: ["U012ETLV6NQ"],
                    },
                  },
                },
              },
            },
          },
        } as never,
        env: { OPENCLAW_STATE_DIR: stateDir },
        callGateway: vi.fn(async () => ({
          payload: {
            messages: [
              {
                channel: "C0B0AK14B7X",
                ts: "1779319619.353539",
                thread_ts: "1779318546.276599",
                user: "U012ETLV6NQ",
                text: "Lei please incorporate the word Breh",
              },
            ],
          },
        })),
      },
    );

    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      counts?: Record<string, number>;
      records?: Array<{ ts?: string; verdict?: string; reason?: string }>;
    };
    expect(report.counts?.["missing-admission"]).toBe(1);
    expect(report.records).toContainEqual(
      expect.objectContaining({
        ts: "1779319619.353539",
        verdict: "missing-admission",
        reason: "activation-without-ledger-record",
      }),
    );
  });

  it("reads explicit Slack thread replies through the gateway", async () => {
    const runtime = createRuntime();
    const callGateway = vi.fn(async () => ({
      payload: {
        messages: [
          {
            channel: "C0B0AK14B7X",
            ts: "1779322434.225859",
            thread_ts: "1779318546.276599",
            user: "U012ETLV6NQ",
            text: "<@U0B0BS18D70> this would be the time after Michael responds",
          },
        ],
      },
    }));

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        thread: "1779318546.276599",
        botUser: "U0B0BS18D70",
        json: true,
      },
      runtime,
      {
        cfg: {
          channels: {
            slack: {
              accounts: {
                soylei: {
                  channels: {
                    C0B0AK14B7X: {
                      requireMention: true,
                      users: ["U012ETLV6NQ"],
                    },
                  },
                },
              },
            },
          },
        } as never,
        env: { OPENCLAW_STATE_DIR: await makeTempState() },
        callGateway,
      },
    );

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          params: expect.objectContaining({
            threadId: "1779318546.276599",
          }),
        }),
      }),
    );
    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      counts?: Record<string, number>;
      records?: Array<{ ts?: string; verdict?: string; reason?: string }>;
    };
    expect(report.counts?.["missing-admission"]).toBe(1);
    expect(report.records).toContainEqual(
      expect.objectContaining({
        ts: "1779322434.225859",
        verdict: "missing-admission",
        reason: "activation-without-ledger-record",
      }),
    );
  });

  it("posts one deduped alert for new missing admissions", async () => {
    const runtime = createRuntime();
    const stateDir = await makeTempState();
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        payload: {
          messages: [
            {
              channel: "C0B0AK14B7X",
              ts: "1779322434.225859",
              thread_ts: "1779318546.276599",
              user: "U012ETLV6NQ",
              text: "<@U0B0BS18D70> play the song",
            },
          ],
        },
      })
      .mockResolvedValueOnce({ payload: { ok: true } });

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        thread: "1779318546.276599",
        botUser: "U0B0BS18D70",
        alertAccount: "default",
        alertTarget: "channel:C0AHQQ123",
        json: true,
      },
      runtime,
      {
        cfg: {
          channels: {
            slack: {
              accounts: {
                soylei: {
                  channels: {
                    C0B0AK14B7X: {
                      requireMention: true,
                      users: ["U012ETLV6NQ"],
                    },
                  },
                },
              },
            },
          },
        } as never,
        env: { OPENCLAW_STATE_DIR: stateDir },
        now: new Date("2026-05-21T01:30:00.000Z"),
        callGateway,
      },
    );

    expect(callGateway).toHaveBeenCalledTimes(2);
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "message.action",
        params: expect.objectContaining({
          channel: "slack",
          action: "send",
          accountId: "default",
          params: expect.objectContaining({
            to: "channel:C0AHQQ123",
            message: expect.stringContaining("OpenClaw Slack admission watchdog"),
          }),
        }),
      }),
    );
    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      alert?: { sent?: number; skippedKnown?: number };
    };
    expect(report.alert?.sent).toBe(1);
    expect(report.alert?.skippedKnown).toBe(0);

    const secondRuntime = createRuntime();
    callGateway.mockClear();
    callGateway.mockResolvedValueOnce({
      payload: {
        messages: [
          {
            channel: "C0B0AK14B7X",
            ts: "1779322434.225859",
            thread_ts: "1779318546.276599",
            user: "U012ETLV6NQ",
            text: "<@U0B0BS18D70> play the song",
          },
        ],
      },
    });

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        thread: "1779318546.276599",
        botUser: "U0B0BS18D70",
        alertAccount: "default",
        alertTarget: "channel:C0AHQQ123",
        json: true,
      },
      secondRuntime,
      {
        cfg: {
          channels: {
            slack: {
              accounts: {
                soylei: {
                  channels: {
                    C0B0AK14B7X: {
                      requireMention: true,
                      users: ["U012ETLV6NQ"],
                    },
                  },
                },
              },
            },
          },
        } as never,
        env: { OPENCLAW_STATE_DIR: stateDir },
        now: new Date("2026-05-21T01:31:00.000Z"),
        callGateway,
      },
    );

    expect(callGateway).toHaveBeenCalledTimes(1);
    const secondReport = JSON.parse(secondRuntime.logs[0] ?? "{}") as {
      alert?: { sent?: number; skippedKnown?: number };
    };
    expect(secondReport.alert?.sent).toBe(0);
    expect(secondReport.alert?.skippedKnown).toBe(1);
  });
});
