import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  channelsSlackWatchdogReplayCommand,
  channelsSlackWatchdogScanCommand,
  channelsSlackWatchdogStatusCommand,
  parseSlackWatchdogDurationMs,
  parseSlackWatchdogPermalink,
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

describe("channelsSlackWatchdogStatusCommand", () => {
  it("summarizes watchdog action state", async () => {
    const stateDir = await makeTempState();
    const statePath = path.join(stateDir, "watchdog-state.json");
    await fs.writeFile(
      statePath,
      `${JSON.stringify(
        {
          "soylei\u0000C1\u00001.000001\u0000client-1\u0000": {
            operatorAlertedAt: "2026-05-29T01:00:00.000Z",
          },
          "soylei\u0000C1\u00001.000002\u0000client-2\u0000": {
            operatorAlertedAt: "2026-05-29T02:00:00.000Z",
            sourceRepliedAt: "2026-05-29T02:01:00.000Z",
            sourceReplyTs: "1.000003",
            replayAttemptedAt: "2026-05-29T02:02:00.000Z",
            replayOutcome: "dispatched",
          },
          "soylei\u0000C1\u00001.000004\u0000client-4\u0000": {
            replayAttemptedAt: "2026-05-29T03:00:00.000Z",
            replayOutcome: "failed",
          },
        },
        null,
        2,
      )}\n`,
    );
    const runtime = createRuntime();

    await channelsSlackWatchdogStatusCommand(
      {
        account: "soylei",
        state: statePath,
        json: true,
      },
      runtime,
    );

    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      accountId?: string;
      knownMessages?: number;
      operatorAlerted?: number;
      sourceReplied?: number;
      replayAttempted?: number;
      replayDispatched?: number;
      replayFailed?: number;
      latestOperatorAlertedAt?: string;
      latestReplayAttemptedAt?: string;
    };
    expect(report).toEqual(
      expect.objectContaining({
        accountId: "soylei",
        knownMessages: 3,
        operatorAlerted: 2,
        sourceReplied: 1,
        replayAttempted: 2,
        replayDispatched: 1,
        replayFailed: 1,
        latestOperatorAlertedAt: "2026-05-29T02:00:00.000Z",
        latestReplayAttemptedAt: "2026-05-29T03:00:00.000Z",
      }),
    );
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

describe("parseSlackWatchdogPermalink", () => {
  it("extracts channel id and Slack timestamp from a permalink", () => {
    expect(
      parseSlackWatchdogPermalink(
        "https://polycy.slack.com/archives/C0AHQQCG7J4/p1780022048464099",
      ),
    ).toEqual({
      channelId: "C0AHQQCG7J4",
      ts: "1780022048.464099",
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

  it("anchors scan history around a Slack permalink", async () => {
    const runtime = createRuntime();
    const callGateway = vi.fn(async () => ({
      payload: {
        messages: [
          {
            channel: "C0AHQQCG7J4",
            ts: "1780022048.464099",
            text: "<@UOPENCLAW> did this get missed?",
            user: "U1",
          },
        ],
      },
    }));

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        permalink: "https://polycy.slack.com/archives/C0AHQQCG7J4/p1780022048464099",
        since: "30m",
        botUser: "UOPENCLAW",
      },
      runtime,
      {
        cfg: { channels: { slack: {} } } as never,
        now: new Date("2026-05-29T14:00:00.000Z"),
        env: { OPENCLAW_STATE_DIR: await makeTempState() },
        callGateway,
      },
    );

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "message.action",
        params: expect.objectContaining({
          params: expect.objectContaining({
            to: "channel:C0AHQQCG7J4",
            after: "1780020248.464",
          }),
        }),
      }),
    );
    expect(runtime.logs.join("\n")).toContain("C0AHQQCG7J4");
    expect(runtime.logs.join("\n")).toContain("1780022048.464099");
  });

  it("formats human-readable tenant, channel, and Chicago-local times", async () => {
    const runtime = createRuntime();

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        tenantLabel: "SoyLei",
        target: "channel:C0B0AK14B7X",
        channelName: "ask-lei",
        since: "30m",
        botUser: "UOPENCLAW",
      },
      runtime,
      {
        cfg: { channels: { slack: {} } } as never,
        now: new Date("2026-05-20T21:00:00.000Z"),
        env: { OPENCLAW_STATE_DIR: await makeTempState() },
        callGateway: vi.fn(async () => ({
          payload: {
            messages: [
              {
                channel: "C0B0AK14B7X",
                ts: "1779309189.369149",
                text: "<@UOPENCLAW> status?",
                user: "U1",
              },
            ],
          },
        })),
      },
    );

    const output = runtime.logs.join("\n");
    expect(output).toContain("Slack tenant: SoyLei (soylei)");
    expect(output).toContain("Channel: #ask-lei (C0B0AK14B7X)");
    expect(output).toContain("America/Chicago");
    expect(output).toContain("May 20, 2026, 3:33:09 PM CDT");
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
      .mockResolvedValueOnce({
        channelAccounts: {
          slack: [
            {
              accountId: "soylei",
              running: true,
              connected: true,
              healthState: "healthy",
              lastInboundAt: Date.parse("2026-05-21T01:28:00.000Z"),
              lastTransportActivityAt: Date.parse("2026-05-21T01:29:00.000Z"),
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

    expect(callGateway).toHaveBeenCalledTimes(3);
    expect(callGateway).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: "message.action",
        params: expect.objectContaining({
          channel: "slack",
          action: "send",
          accountId: "default",
          params: expect.objectContaining({
            to: "channel:C0AHQQ123",
            message: expect.stringContaining("OpenClaw missed 1 Slack message"),
          }),
        }),
      }),
    );
    const alertMessage = callGateway.mock.calls[2]?.[0]?.params?.params?.message;
    expect(alertMessage).toContain("Where: soylei <#C0B0AK14B7X> (C0B0AK14B7X)");
    expect(alertMessage).toContain("What checked: Slack history vs OpenClaw admission ledger");
    expect(alertMessage).toContain(
      "Nearby channel health: health=healthy, connected=true, running=true, transport=1m ago, inbound=2m ago",
    );
    expect(alertMessage).toContain("Reason: Slack has the message, but OpenClaw has no admission");
    expect(alertMessage).toContain("Next action:");
    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      health?: { available?: boolean; healthState?: string; lastTransportActivityAge?: string };
      alert?: { sent?: number; skippedKnown?: number };
    };
    expect(report.health).toEqual(
      expect.objectContaining({
        available: true,
        healthState: "healthy",
        lastTransportActivityAge: "1m ago",
      }),
    );
    expect(report.alert?.sent).toBe(1);
    expect(report.alert?.skippedKnown).toBe(0);

    const secondRuntime = createRuntime();
    callGateway.mockClear();
    callGateway
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
      .mockResolvedValueOnce({
        channelAccounts: {
          slack: [
            {
              accountId: "soylei",
              running: true,
              connected: true,
              healthState: "healthy",
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

    expect(callGateway).toHaveBeenCalledTimes(2);
    const secondReport = JSON.parse(secondRuntime.logs[0] ?? "{}") as {
      alert?: { sent?: number; skippedKnown?: number };
    };
    expect(secondReport.alert?.sent).toBe(0);
    expect(secondReport.alert?.skippedKnown).toBe(1);
  });

  it("reports operator alert send failures without marking the alert as sent", async () => {
    const stateDir = await makeTempState();
    const cfg = {
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
    } as never;
    const message = {
      channel: "C0B0AK14B7X",
      ts: "1779322434.225859",
      user: "U012ETLV6NQ",
      text: "<@U0B0BS18D70> play the song",
    };
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ payload: { messages: [message] } })
      .mockResolvedValueOnce({
        channelAccounts: {
          slack: [{ accountId: "soylei", running: true, connected: true }],
        },
      })
      .mockRejectedValueOnce(new Error("Slack send failed"));
    const runtime = createRuntime();

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        botUser: "U0B0BS18D70",
        alertAccount: "default",
        alertTarget: "channel:C0AHQQ123",
        json: true,
      },
      runtime,
      {
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
        now: new Date("2026-05-21T01:30:00.000Z"),
        callGateway,
      },
    );

    const failedReport = JSON.parse(runtime.logs[0] ?? "{}") as {
      alert?: { sent?: number; failed?: number; skippedKnown?: number; error?: string };
    };
    expect(failedReport.alert).toEqual(
      expect.objectContaining({
        sent: 0,
        failed: 1,
        skippedKnown: 0,
        error: "Slack send failed",
      }),
    );

    const retryRuntime = createRuntime();
    callGateway.mockReset();
    callGateway
      .mockResolvedValueOnce({ payload: { messages: [message] } })
      .mockResolvedValueOnce({
        channelAccounts: {
          slack: [{ accountId: "soylei", running: true, connected: true }],
        },
      })
      .mockResolvedValueOnce({ payload: { ok: true } });

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        botUser: "U0B0BS18D70",
        alertAccount: "default",
        alertTarget: "channel:C0AHQQ123",
        json: true,
      },
      retryRuntime,
      {
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
        now: new Date("2026-05-21T01:31:00.000Z"),
        callGateway,
      },
    );

    const retryReport = JSON.parse(retryRuntime.logs[0] ?? "{}") as {
      alert?: { sent?: number; failed?: number; skippedKnown?: number };
    };
    expect(retryReport.alert).toEqual(
      expect.objectContaining({
        sent: 1,
        failed: 0,
        skippedKnown: 0,
      }),
    );
  });

  it("posts one deduped missed-message thread reply when explicitly enabled", async () => {
    const runtime = createRuntime();
    const stateDir = await makeTempState();
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        payload: {
          messages: [
            {
              channel: "C0B0AK14B7X",
              ts: "1780021947.219859",
              user: "U012ETLV6NQ",
              text: "<@U0B0BS18D70> the task was 10 examples. 10.",
            },
          ],
        },
      })
      .mockResolvedValueOnce({ payload: { messageId: "1780022050.000100" } });

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        botUser: "U0B0BS18D70",
        replyMissed: true,
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
        now: new Date("2026-05-29T02:35:00.000Z"),
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
          accountId: "soylei",
          params: expect.objectContaining({
            to: "channel:C0B0AK14B7X",
            accountId: "soylei",
            threadId: "1780021947.219859",
            message: expect.stringContaining("OpenClaw missed this message before it reached"),
          }),
        }),
      }),
    );
    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      sourceReplies?: {
        sent?: number;
        skippedKnown?: number;
        records?: Array<{ sourceReplyTs?: string; threadTs?: string }>;
      };
    };
    expect(report.sourceReplies?.sent).toBe(1);
    expect(report.sourceReplies?.skippedKnown).toBe(0);
    expect(report.sourceReplies?.records?.[0]).toEqual(
      expect.objectContaining({
        threadTs: "1780021947.219859",
        sourceReplyTs: "1780022050.000100",
      }),
    );

    const secondRuntime = createRuntime();
    callGateway.mockClear();
    callGateway.mockResolvedValueOnce({
      payload: {
        messages: [
          {
            channel: "C0B0AK14B7X",
            ts: "1780021947.219859",
            thread_ts: "1780021947.219859",
            user: "U012ETLV6NQ",
            text: "<@U0B0BS18D70> the task was 10 examples. 10.",
          },
        ],
      },
    });

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        botUser: "U0B0BS18D70",
        replyMissed: true,
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
        now: new Date("2026-05-29T02:36:00.000Z"),
        callGateway,
      },
    );

    expect(callGateway).toHaveBeenCalledTimes(1);
    const secondReport = JSON.parse(secondRuntime.logs[0] ?? "{}") as {
      sourceReplies?: { sent?: number; skippedKnown?: number };
    };
    expect(secondReport.sourceReplies?.sent).toBe(0);
    expect(secondReport.sourceReplies?.skippedKnown).toBe(1);
  });

  it("renders missed-message replies in dry-run mode without sending", async () => {
    const runtime = createRuntime();
    const callGateway = vi.fn(async () => ({
      payload: {
        messages: [
          {
            channel: "C0B0AK14B7X",
            ts: "1780021947.219859",
            thread_ts: "1780021000.000000",
            user: "U012ETLV6NQ",
            text: "<@U0B0BS18D70> missed thread reply",
          },
        ],
      },
    }));

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        botUser: "U0B0BS18D70",
        dryRunReplies: true,
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

    expect(callGateway).toHaveBeenCalledTimes(1);
    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      sourceReplies?: {
        dryRun?: boolean;
        sent?: number;
        records?: Array<{ threadTs?: string; message?: string }>;
      };
    };
    expect(report.sourceReplies?.dryRun).toBe(true);
    expect(report.sourceReplies?.sent).toBe(0);
    expect(report.sourceReplies?.records?.[0]).toEqual(
      expect.objectContaining({
        threadTs: "1780021000.000000",
        message: expect.stringContaining("flagged it for recovery"),
      }),
    );
  });

  it("preflights a guarded replay without starting an agent turn", async () => {
    const runtime = createRuntime();
    const agentCommandFromIngress = vi.fn(async () => undefined);
    const callGateway = vi.fn(async () => ({
      payload: {
        messages: [
          {
            channel: "C0B0AK14B7X",
            ts: "1780021947.219859",
            user: "U012ETLV6NQ",
            text: "<@U0B0BS18D70> the task was 10 examples. 10.",
          },
        ],
      },
    }));

    await channelsSlackWatchdogReplayCommand(
      {
        account: "soylei",
        permalink: "https://polycy.slack.com/archives/C0B0AK14B7X/p1780021947219859",
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
        now: new Date("2026-05-29T02:40:00.000Z"),
        callGateway,
        agentCommandFromIngress,
      },
    );

    expect(agentCommandFromIngress).not.toHaveBeenCalled();
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          params: expect.objectContaining({
            to: "channel:C0B0AK14B7X",
            after: "1779935547.219",
          }),
        }),
      }),
    );
    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      outcome?: string;
      dispatched?: boolean;
      delivery?: { threadId?: string };
      sessionKey?: string;
    };
    expect(report.outcome).toBe("dry-run");
    expect(report.dispatched).toBe(false);
    expect(report.delivery?.threadId).toBe("1780021947.219859");
    expect(report.sessionKey).toBe("agent:main:slack:channel:c0b0ak14b7x:thread:1780021947.219859");
  });

  it("dispatches a guarded replay through ingress and dedupes dispatched recovery", async () => {
    const stateDir = await makeTempState();
    const runtime = createRuntime();
    const agentCommandFromIngress = vi.fn(async () => undefined);
    const callGateway = vi.fn(async () => ({
      payload: {
        messages: [
          {
            channel: "C0B0AK14B7X",
            ts: "1780021947.219859",
            user: "U012ETLV6NQ",
            text: "<@U0B0BS18D70> recover me",
          },
        ],
      },
    }));
    const cfg = {
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
    } as never;

    await channelsSlackWatchdogReplayCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        ts: "1780021947.219859",
        botUser: "U0B0BS18D70",
        execute: true,
        json: true,
      },
      runtime,
      {
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
        now: new Date("2026-05-29T02:41:00.000Z"),
        callGateway,
        agentCommandFromIngress,
      },
    );

    expect(agentCommandFromIngress).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "<@U0B0BS18D70> recover me",
        channel: "slack",
        accountId: "soylei",
        to: "channel:C0B0AK14B7X",
        threadId: "1780021947.219859",
        sessionKey: "agent:main:slack:channel:c0b0ak14b7x:thread:1780021947.219859",
        allowModelOverride: false,
        senderIsOwner: false,
      }),
      runtime,
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "message.action",
        params: expect.objectContaining({
          channel: "slack",
          action: "send",
          accountId: "soylei",
          params: expect.objectContaining({
            to: "channel:C0B0AK14B7X",
            accountId: "soylei",
            threadId: "1780021947.219859",
            message: expect.stringContaining("Recovery complete"),
          }),
        }),
      }),
    );
    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      outcome?: string;
      dispatched?: boolean;
      recoveryReply?: { sent?: boolean; threadTs?: string };
    };
    expect(report.outcome).toBe("dispatched");
    expect(report.dispatched).toBe(true);
    expect(report.recoveryReply).toEqual(
      expect.objectContaining({
        sent: true,
        threadTs: "1780021947.219859",
      }),
    );

    const ledgerPath = resolveSlackWatchdogLedgerPath({
      accountId: "soylei",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });
    const ledgerRows = (await fs.readFile(ledgerPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { outcome?: string; reason?: string; text?: string });
    expect(ledgerRows.map((row) => row.outcome)).toEqual(["replay-attempted", "replay-dispatched"]);
    expect(ledgerRows.map((row) => row.reason)).toEqual([
      "watchdog-replay-attempted",
      "watchdog-replay-dispatched",
    ]);
    expect(JSON.stringify(ledgerRows)).not.toContain("recover me");

    const secondRuntime = createRuntime();
    await channelsSlackWatchdogReplayCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        ts: "1780021947.219859",
        botUser: "U0B0BS18D70",
        execute: true,
        json: true,
      },
      secondRuntime,
      {
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
        now: new Date("2026-05-29T02:42:00.000Z"),
        callGateway,
        agentCommandFromIngress,
      },
    );

    expect(agentCommandFromIngress).toHaveBeenCalledTimes(1);
    const secondReport = JSON.parse(secondRuntime.logs[0] ?? "{}") as { outcome?: string };
    expect(secondReport.outcome).toBe("blocked-already-replayed");
  });
});
