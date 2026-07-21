import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendSlackAdmissionRecord,
  readSlackAdmissionRecords,
  type SlackAdmissionRecord,
} from "../../../extensions/slack/api.js";
import { addChannelAllowFromStoreEntry } from "../../pairing/pairing-store.js";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "../../plugin-sdk/plugin-state-test-runtime.js";
import {
  channelsSlackWatchdogReplayCommand,
  channelsSlackWatchdogScanCommand,
  channelsSlackWatchdogStatusCommand,
  isSlackWatchdogApiSurface,
  parseSlackWatchdogDurationMs,
  parseSlackWatchdogPermalink,
  parseSlackWatchdogTarget,
  slackWatchdogOperatorAlertIdempotencyKey,
  stableStringify,
} from "./slack-watchdog-scan.js";

const tempDirs: string[] = [];

async function makeTempState() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watchdog-scan-"));
  tempDirs.push(dir);
  return dir;
}

async function waitForTestPromise<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

afterEach(async () => {
  resetPluginStateStoreForTests();
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
  const env = { OPENCLAW_STATE_DIR: stateDir };
  for (const record of records) {
    await appendSlackAdmissionRecord({
      accountId,
      record: record as SlackAdmissionRecord,
      openKeyedStore: <T>(options) =>
        createPluginStateKeyedStoreForTests<T>("slack", { ...options, env }),
    });
  }
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

describe("slackWatchdogOperatorAlertIdempotencyKey", () => {
  it("is stable across retries and missing-record order", () => {
    const first = {
      accountId: "soylei",
      channel: "C123",
      ts: "2.000000",
      verdict: "missing-admission",
      reason: "missing ledger record",
    } as const;
    const second = { ...first, ts: "1.000000" };
    const params = { alertAccountId: "default", alertTarget: "channel:CALERT" };

    expect(slackWatchdogOperatorAlertIdempotencyKey({ ...params, records: [first, second] })).toBe(
      slackWatchdogOperatorAlertIdempotencyKey({ ...params, records: [second, first] }),
    );
  });
});

describe("stableStringify", () => {
  it("deterministically encodes root and nested non-JSON values", () => {
    expect(stableStringify(undefined)).toBe("undefined");
    expect(
      stableStringify({
        missing: undefined,
        count: 1n,
        invalid: Number.NaN,
      }),
    ).toBe('{"count":bigint:1,"invalid":number:NaN,"missing":undefined}');
  });
});

describe("isSlackWatchdogApiSurface", () => {
  const complete = {
    appendSlackAdmissionRecord: () => undefined,
    readSlackAdmissionRecords: () => undefined,
    readSlackMessages: () => undefined,
    scanSlackAdmissionGaps: () => undefined,
  };

  it("accepts only installed Slack APIs with the complete watchdog contract", () => {
    expect(isSlackWatchdogApiSurface(complete)).toBe(true);
    expect(isSlackWatchdogApiSurface({ ...complete, readSlackAdmissionRecords: undefined })).toBe(
      false,
    );
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

  it("reports source replies and replays from the shared default state", async () => {
    const stateDir = await makeTempState();
    const statePath = path.join(stateDir, "slack", "watchdog-alerts", "soylei.json");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        "soylei\u0000C1\u00001.000001\u0000client-1\u0000": {
          sourceRepliedAt: "2026-05-29T02:01:00.000Z",
          replayAttemptedAt: "2026-05-29T02:02:00.000Z",
          replayOutcome: "dispatched",
        },
      })}\n`,
    );
    const runtime = createRuntime();

    await channelsSlackWatchdogStatusCommand({ account: "soylei", json: true }, runtime, {
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(JSON.parse(runtime.logs[0] ?? "{}")).toEqual(
      expect.objectContaining({
        statePath,
        sourceReplied: 1,
        replayAttempted: 1,
        replayDispatched: 1,
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

  it("extracts the root thread timestamp from a Slack reply permalink", () => {
    expect(
      parseSlackWatchdogPermalink(
        "https://polycy.slack.com/archives/C123/p1780022048464099?thread_ts=1780021000.000000&cid=C123",
      ),
    ).toEqual({
      channelId: "C123",
      ts: "1780022048.464099",
      threadTs: "1780021000.000000",
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

  it("treats unlisted channels as eligible under an open group policy", async () => {
    const runtime = createRuntime();

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:COPEN",
        botUser: "UOPENCLAW",
        json: true,
      },
      runtime,
      {
        cfg: {
          channels: { slack: { accounts: { soylei: { groupPolicy: "open" } } } },
        } as never,
        env: { OPENCLAW_STATE_DIR: await makeTempState() },
        callGateway: vi.fn(async () => ({
          payload: {
            messages: [
              {
                channel: "COPEN",
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
    expect(report.counts?.["missing-admission"]).toBe(1);
    expect(report.counts?.["not-relevant"]).toBe(0);
  });

  it("honors an explicit disabled channel under an open group policy", async () => {
    const runtime = createRuntime();

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:CDISABLED",
        botUser: "UOPENCLAW",
        json: true,
      },
      runtime,
      {
        cfg: {
          channels: {
            slack: {
              accounts: {
                soylei: {
                  groupPolicy: "open",
                  channels: { CDISABLED: { enabled: false } },
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
                channel: "CDISABLED",
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
    expect(report.counts?.["missing-admission"]).toBe(0);
    expect(report.counts?.["not-relevant"]).toBe(1);
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
            before: "1780022048.464100",
          }),
        }),
      }),
    );
    expect(runtime.logs.join("\n")).toContain("C0AHQQCG7J4");
    expect(runtime.logs.join("\n")).toContain("1780022048.464099");
  });

  it("reads a reply permalink through its root Slack thread", async () => {
    const runtime = createRuntime();
    const readSlackMessages = vi.fn(async () => []);

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        permalink:
          "https://polycy.slack.com/archives/C123/p1780022048464099?thread_ts=1780021000.000000&cid=C123",
        json: true,
      },
      runtime,
      {
        cfg: { channels: { slack: {} } } as never,
        env: { OPENCLAW_STATE_DIR: await makeTempState() },
        readSlackMessages,
      },
    );

    expect(readSlackMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123",
        threadId: "1780021000.000000",
      }),
    );
  });

  it("passes the anchored upper bound through the Slack plugin reader", async () => {
    const runtime = createRuntime();
    const readSlackMessages = vi.fn(async () => [
      {
        channel: "C0AHQQCG7J4",
        ts: "1780022048.464099",
        text: "<@UOPENCLAW> anchored",
        user: "U1",
      },
    ]);

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
        env: { OPENCLAW_STATE_DIR: await makeTempState() },
        readSlackMessages,
      },
    );

    expect(readSlackMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C0AHQQCG7J4",
        oldest: "1780020248.464",
        latest: "1780022048.464100",
      }),
    );
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

  it("uses account DM policy and allowFrom for D targets", async () => {
    const runtime = createRuntime();

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "D0DIRECT",
        json: true,
      },
      runtime,
      {
        cfg: {
          channels: {
            slack: {
              accounts: {
                soylei: {
                  dmPolicy: "allowlist",
                  allowFrom: ["slack:U012ETLV6NQ"],
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
                channel: "D0DIRECT",
                ts: "1779318546.276599",
                user: "U012ETLV6NQ",
                text: "allowed DM",
              },
              {
                channel: "D0DIRECT",
                ts: "1779318547.276599",
                user: "UNOTLISTED",
                text: "blocked DM",
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

  it("uses account-scoped pairing state for pairing-policy DM scans", async () => {
    const stateDir = await makeTempState();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await addChannelAllowFromStoreEntry({
      channel: "slack",
      accountId: "soylei",
      entry: "UPAIRED",
      env,
    });
    const runtime = createRuntime();

    await channelsSlackWatchdogScanCommand(
      { account: "soylei", target: "D0DIRECT", json: true },
      runtime,
      {
        cfg: {
          channels: { slack: { accounts: { soylei: { dmPolicy: "pairing" } } } },
        } as never,
        env,
        callGateway: vi.fn(async () => ({
          payload: {
            messages: [
              { channel: "D0DIRECT", ts: "1.000001", user: "UPAIRED", text: "paired" },
              { channel: "D0DIRECT", ts: "1.000002", user: "UNPAIRED", text: "blocked" },
            ],
          },
        })),
      },
    );

    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      records?: Array<{ user?: string; verdict?: string; reason?: string }>;
    };
    expect(report.records).toContainEqual(
      expect.objectContaining({ user: "UPAIRED", verdict: "missing-admission" }),
    );
    expect(report.records).toContainEqual(
      expect.objectContaining({
        user: "UNPAIRED",
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
    expect(report.records?.[0]?.suggestedReplayCommand).toContain("--bot-user U0B0BS18D70");
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
              lastSocketConnectedAt: Date.parse("2026-05-21T01:25:00.000Z"),
              lastSocketEnvelopeAt: Date.parse("2026-05-21T01:29:30.000Z"),
              lastSlackEventAt: Date.parse("2026-05-21T01:29:40.000Z"),
              lastSocketError: { at: Date.parse("2026-05-21T01:20:00.000Z"), error: "old" },
              slackTelemetry: {
                rawSlackEvents: 12,
                messageEvents: 5,
                droppedEvents: 2,
                droppedPolicyEvents: 1,
                droppedSelfBotEvents: 8,
                preparedForDispatch: 3,
                admissionsRecorded: 4,
                dispatchFailures: 1,
              },
              reconciliationStatus: {
                lastScanAt: Date.parse("2026-05-21T01:29:45.000Z"),
                missingCandidates: 1,
                recoveredCandidates: 0,
                failedCandidates: 0,
              },
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
      "Nearby channel health: health=healthy, connected=true, running=true, socketEnvelope=1m ago, slackEvent=just now, socketError=10m ago, transport=1m ago, inbound=2m ago",
    );
    expect(alertMessage).toContain(
      "Slack receiver counters: raw=12, messages=5, dropped=2, policyDrops=1, selfBotDrops=8, prepared=3, admissions=4, dispatchFailures=1",
    );
    expect(alertMessage).toContain(
      "Slack reconciliation: lastScan=May 20, 2026, 8:29:45 PM CDT, missing=1, recovered=0, failed=0",
    );
    expect(alertMessage).toContain("Reason: Slack has the message, but OpenClaw has no admission");
    expect(alertMessage).toContain("Next action:");
    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      health?: {
        available?: boolean;
        healthState?: string;
        lastSocketEnvelopeAge?: string;
        lastSlackEventAge?: string;
        lastSocketErrorAge?: string;
        lastTransportActivityAge?: string;
        slackTelemetry?: Record<string, number>;
        reconciliation?: { missingCandidates?: number };
      };
      alert?: { sent?: number; skippedKnown?: number };
    };
    expect(report.health).toEqual(
      expect.objectContaining({
        available: true,
        healthState: "healthy",
        lastSocketEnvelopeAge: "1m ago",
        lastSlackEventAge: "just now",
        lastSocketErrorAge: "10m ago",
        lastTransportActivityAge: "1m ago",
        slackTelemetry: expect.objectContaining({
          rawSlackEvents: 12,
          droppedPolicyEvents: 1,
          droppedSelfBotEvents: 8,
          dispatchFailures: 1,
        }),
        reconciliation: expect.objectContaining({
          missingCandidates: 1,
        }),
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

  it("serializes overlapping alert batches before selecting unalerted records", async () => {
    const stateDir = await makeTempState();
    const firstMessage = {
      channel: "C0B0AK14B7X",
      ts: "1779322434.225859",
      user: "U012ETLV6NQ",
      text: "<@U0B0BS18D70> first",
    };
    const secondMessage = {
      channel: "C0B0AK14B7X",
      ts: "1779322435.225860",
      user: "U012ETLV6NQ",
      text: "<@U0B0BS18D70> second",
    };
    let releaseFirstAlert!: () => void;
    const firstAlertGate = new Promise<void>((resolve) => {
      releaseFirstAlert = resolve;
    });
    let markFirstAlertStarted!: () => void;
    const firstAlertStarted = new Promise<void>((resolve) => {
      markFirstAlertStarted = resolve;
    });
    const firstGateway = vi
      .fn()
      .mockResolvedValueOnce({ payload: { messages: [firstMessage] } })
      .mockResolvedValueOnce({
        channelAccounts: { slack: [{ accountId: "soylei", running: true, connected: true }] },
      })
      .mockImplementationOnce(async () => {
        markFirstAlertStarted();
        await firstAlertGate;
        return { payload: { ok: true } };
      });
    const secondGateway = vi
      .fn()
      .mockResolvedValueOnce({ payload: { messages: [firstMessage, secondMessage] } })
      .mockResolvedValueOnce({
        channelAccounts: { slack: [{ accountId: "soylei", running: true, connected: true }] },
      })
      .mockResolvedValueOnce({ payload: { ok: true } });
    const options = {
      account: "soylei",
      target: "channel:C0B0AK14B7X",
      botUser: "U0B0BS18D70",
      alertAccount: "default",
      alertTarget: "channel:C0AHQQ123",
      json: true,
    } as const;
    const cfg = {
      channels: {
        slack: {
          accounts: {
            soylei: {
              channels: {
                C0B0AK14B7X: { requireMention: true, users: ["U012ETLV6NQ"] },
              },
            },
          },
        },
      },
    } as never;
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();

    const firstScan = channelsSlackWatchdogScanCommand(options, firstRuntime, {
      cfg,
      env: { OPENCLAW_STATE_DIR: stateDir },
      callGateway: firstGateway,
    });
    await firstAlertStarted;
    const secondScan = channelsSlackWatchdogScanCommand(options, secondRuntime, {
      cfg,
      env: { OPENCLAW_STATE_DIR: stateDir },
      callGateway: secondGateway,
    });
    await vi.waitFor(() => expect(secondGateway).toHaveBeenCalledTimes(2));
    releaseFirstAlert();
    await Promise.all([firstScan, secondScan]);

    const firstReport = JSON.parse(firstRuntime.logs[0] ?? "{}") as {
      alert?: { sent?: number; skippedKnown?: number };
    };
    const secondReport = JSON.parse(secondRuntime.logs[0] ?? "{}") as {
      alert?: { sent?: number; skippedKnown?: number };
    };
    expect(firstReport.alert).toMatchObject({ sent: 1, skippedKnown: 0 });
    expect(secondReport.alert).toMatchObject({ sent: 1, skippedKnown: 1 });
    expect(firstGateway).toHaveBeenCalledTimes(3);
    expect(secondGateway).toHaveBeenCalledTimes(3);
  });

  it("does not let a stale alert update erase overlapping dispatched replay state", async () => {
    const stateDir = await makeTempState();
    const statePath = path.join(stateDir, "slack", "watchdog-alerts", "soylei.json");
    const message = {
      channel: "C0B0AK14B7X",
      ts: "1779322434.225859",
      user: "U012ETLV6NQ",
      text: "<@U0B0BS18D70> preserve replay state",
    };
    let resolveAlertStarted!: () => void;
    const alertStarted = new Promise<void>((resolve) => {
      resolveAlertStarted = resolve;
    });
    let resolveAlertSend!: (value: { payload: { ok: boolean } }) => void;
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ payload: { messages: [message] } })
      .mockResolvedValueOnce({
        channelAccounts: {
          slack: [{ accountId: "soylei", running: true, connected: true }],
        },
      })
      .mockImplementationOnce(
        () =>
          new Promise<{ payload: { ok: boolean } }>((resolve) => {
            resolveAlertSend = resolve;
            resolveAlertStarted();
          }),
      );

    const scan = channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        botUser: "U0B0BS18D70",
        alertAccount: "default",
        alertTarget: "channel:C0AHQQ123",
        json: true,
      },
      createRuntime(),
      {
        cfg: {
          channels: {
            slack: {
              accounts: {
                soylei: {
                  channels: {
                    C0B0AK14B7X: { requireMention: true, users: ["U012ETLV6NQ"] },
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
    await alertStarted;

    const key = ["soylei", message.channel, message.ts, "", ""].join("\0");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        [key]: {
          replayAttemptedAt: "2026-05-21T01:29:00.000Z",
          replayOutcome: "dispatched",
          replayAgentReplyPlan: ["stable-part-hash"],
        },
      })}\n`,
    );
    resolveAlertSend({ payload: { ok: true } });
    await scan;

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      {
        operatorAlertedAt?: string;
        replayOutcome?: string;
        replayAgentReplyPlan?: string[];
      }
    >;
    expect(state[key]).toEqual(
      expect.objectContaining({
        operatorAlertedAt: "2026-05-21T01:30:00.000Z",
        replayOutcome: "dispatched",
        replayAgentReplyPlan: ["stable-part-hash"],
      }),
    );
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
    const failedAlertIdempotencyKey = callGateway.mock.calls[2]?.[0]?.params?.idempotencyKey;
    expect(failedAlertIdempotencyKey).toMatch(/^channels-watchdog-alert:[a-f0-9]{64}$/);

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
    expect(callGateway.mock.calls[2]?.[0]?.params?.idempotencyKey).toBe(failedAlertIdempotencyKey);
  });

  it("does not alert or reply when the admission ledger window is truncated", async () => {
    const runtime = createRuntime();
    const stateDir = await makeTempState();
    await writeLedger(stateDir, "soylei", [
      {
        version: 1,
        recordedAt: "2026-05-29T02:30:00.000Z",
        accountId: "soylei",
        channel: "COTHER",
        ts: "1780021800.000001",
        outcome: "accepted",
      },
      {
        version: 1,
        recordedAt: "2026-05-29T02:31:00.000Z",
        accountId: "soylei",
        channel: "COTHER",
        ts: "1780021860.000001",
        outcome: "accepted",
      },
    ]);
    const callGateway = vi.fn().mockResolvedValue({
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
    });

    await channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        botUser: "U0B0BS18D70",
        ledgerLimit: "1",
        alertTarget: "channel:CALERT",
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

    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      records?: Array<{ replayEligible?: boolean; replayBlockedReason?: string }>;
      alert?: unknown;
      sourceReplies?: unknown;
    };
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(report.records?.[0]).toMatchObject({
      replayEligible: false,
      replayBlockedReason: "admission-ledger-window-truncated",
    });
    expect(report.alert).toBeUndefined();
    expect(report.sourceReplies).toBeUndefined();
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
          idempotencyKey:
            "channels-watchdog-source-reply:adde1989176d9f04252531a97610f01a8d941531107b5f6351cb4d01c3bfd4f8",
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

  it("does not let a stale source-reply update erase dispatched replay state", async () => {
    const stateDir = await makeTempState();
    const statePath = path.join(stateDir, "slack", "watchdog-alerts", "soylei.json");
    const message = {
      channel: "C0B0AK14B7X",
      ts: "1780021947.219859",
      user: "U012ETLV6NQ",
      text: "<@U0B0BS18D70> preserve replay during reply",
    };
    let resolveReplyStarted!: () => void;
    const replyStarted = new Promise<void>((resolve) => {
      resolveReplyStarted = resolve;
    });
    let resolveReplySend!: (value: { payload: { messageId: string } }) => void;
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({ payload: { messages: [message] } })
      .mockImplementationOnce(
        () =>
          new Promise<{ payload: { messageId: string } }>((resolve) => {
            resolveReplySend = resolve;
            resolveReplyStarted();
          }),
      );

    const scan = channelsSlackWatchdogScanCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        botUser: "U0B0BS18D70",
        replyMissed: true,
        json: true,
      },
      createRuntime(),
      {
        cfg: {
          channels: {
            slack: {
              accounts: {
                soylei: {
                  channels: {
                    C0B0AK14B7X: { requireMention: true, users: ["U012ETLV6NQ"] },
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
    await replyStarted;

    const key = ["soylei", message.channel, message.ts, "", ""].join("\0");
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      `${JSON.stringify({
        [key]: {
          replayAttemptedAt: "2026-05-29T02:34:00.000Z",
          replayOutcome: "dispatched",
          replayAgentReplyPlan: ["stable-part-hash"],
        },
      })}\n`,
    );
    resolveReplySend({ payload: { messageId: "1780022050.000100" } });
    await scan;

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      { sourceRepliedAt?: string; replayOutcome?: string; replayAgentReplyPlan?: string[] }
    >;
    expect(state[key]).toEqual(
      expect.objectContaining({
        sourceRepliedAt: "2026-05-29T02:35:00.000Z",
        replayOutcome: "dispatched",
        replayAgentReplyPlan: ["stable-part-hash"],
      }),
    );
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
    const agentCommandFromIngress = vi.fn(async () => ({
      payloads: [{ text: "Recovered answer." }],
      meta: {},
    }));
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
            before: "1780021947.219860",
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

  it("rejects rich Slack messages instead of replaying a lossy text projection", async () => {
    const runtime = createRuntime();
    const agentCommandFromIngress = vi.fn();
    await channelsSlackWatchdogReplayCommand(
      {
        account: "soylei",
        target: "channel:C123",
        ts: "1780021947.219859",
        botUser: "U_BOT",
        execute: true,
        json: true,
      },
      runtime,
      {
        cfg: {
          channels: {
            slack: {
              accounts: {
                soylei: { channels: { C123: { requireMention: true, users: ["U1"] } } },
              },
            },
          },
        } as never,
        env: { OPENCLAW_STATE_DIR: await makeTempState() },
        readSlackMessages: async () => [
          {
            channel: "C123",
            ts: "1780021947.219859",
            user: "U1",
            text: "<@U_BOT> inspect attachment",
            files: [{ id: "F1" }],
          },
        ],
        agentCommandFromIngress,
      },
    );

    const report = JSON.parse(runtime.logs[0] ?? "{}") as { outcome?: string; reason?: string };
    expect(report.outcome).toBe("blocked-not-missing");
    expect(report.reason).toContain("text-only Slack messages");
    expect(agentCommandFromIngress).not.toHaveBeenCalled();
  });

  it("bounds a direct Slack history reader and propagates its abort signal", async () => {
    const runtime = createRuntime();
    let capturedSignal: AbortSignal | undefined;
    await expect(
      channelsSlackWatchdogScanCommand(
        { account: "soylei", target: "channel:C123", timeout: "10", json: true },
        runtime,
        {
          cfg: { channels: { slack: {} } } as never,
          env: { OPENCLAW_STATE_DIR: await makeTempState() },
          readSlackMessages: async ({ signal }) => {
            capturedSignal = signal;
            await new Promise<void>(() => {});
            return [];
          },
        },
      ),
    ).rejects.toThrow("Slack history read timed out after 10ms");
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("dispatches a guarded replay through ingress and dedupes dispatched recovery", async () => {
    const stateDir = await makeTempState();
    const runtime = createRuntime();
    const agentCommandFromIngress = vi.fn(
      async (_args: unknown, agentRuntime: { log: (message: string) => void }) => {
        agentRuntime.log("Recovered answer.");
        return {
          payloads: [{ text: "Recovered answer." }],
          meta: {},
        };
      },
    );
    const callGateway = vi.fn(async () => ({
      payload: {
        messages: [
          {
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
        deliver: false,
        allowModelOverride: false,
        senderIsOwner: false,
      }),
      expect.objectContaining({
        log: expect.any(Function),
        writeStdout: expect.any(Function),
        writeJson: expect.any(Function),
      }),
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
            message: "Recovered answer.",
          }),
          idempotencyKey:
            "channels-watchdog-replay-agent-reply:soylei:C0B0AK14B7X:1780021947.219859:0",
        }),
      }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      3,
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
          idempotencyKey: expect.stringMatching(/^channels-watchdog-replay-complete:[0-9a-f]{64}$/),
        }),
      }),
    );
    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      outcome?: string;
      dispatched?: boolean;
      agentReply?: { sent?: boolean; threadTs?: string };
      recoveryReply?: { sent?: boolean; threadTs?: string };
    };
    expect(runtime.logs).toHaveLength(1);
    expect(report.outcome).toBe("dispatched");
    expect(report.dispatched).toBe(true);
    expect(report.agentReply).toEqual(
      expect.objectContaining({
        sent: true,
        threadTs: "1780021947.219859",
        payloadCount: 1,
        sentCount: 1,
      }),
    );
    expect(report.recoveryReply).toEqual(
      expect.objectContaining({
        sent: true,
        threadTs: "1780021947.219859",
      }),
    );

    const env = { OPENCLAW_STATE_DIR: stateDir };
    const ledgerRows = await readSlackAdmissionRecords({
      accountId: "soylei",
      openKeyedStore: <T>(options) =>
        createPluginStateKeyedStoreForTests<T>("slack", { ...options, env }),
    });
    expect(ledgerRows.map((row) => row.outcome)).toEqual(["replay-attempted", "replay-dispatched"]);
    expect(ledgerRows.map((row) => row.reason)).toEqual([
      "watchdog-replay-attempted",
      "watchdog-replay-dispatched",
    ]);
    expect(ledgerRows.map((row) => row.channel)).toEqual(["C0B0AK14B7X", "C0B0AK14B7X"]);
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
    expect(callGateway).toHaveBeenCalledTimes(4);
    const secondReport = JSON.parse(secondRuntime.logs[0] ?? "{}") as {
      outcome?: string;
      recoveryReply?: { attempted?: boolean; sent?: boolean };
    };
    expect(secondReport.outcome).toBe("blocked-already-replayed");
    expect(secondReport.recoveryReply).toMatchObject({ attempted: false, sent: true });
  });

  it("retries only a failed recovery-complete reply with a stable idempotency key", async () => {
    const stateDir = await makeTempState();
    const firstRuntime = createRuntime();
    const retryRuntime = createRuntime();
    const agentCommandFromIngress = vi.fn(async () => ({
      payloads: [{ text: "Recovered answer." }],
      meta: {},
    }));
    const historyPayload = {
      payload: {
        messages: [
          {
            channel: "C0B0AK14B7X",
            ts: "1780021947.219859",
            user: "U012ETLV6NQ",
            text: "<@U0B0BS18D70> recover completion notice",
          },
        ],
      },
    };
    const completionIdempotencyKeys: string[] = [];
    let completionAttempts = 0;
    const callGateway = vi.fn(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: {
          action?: string;
          idempotencyKey?: string;
          params?: { message?: string };
        };
      };
      if (request.method !== "message.action" || request.params?.action !== "send") {
        return historyPayload;
      }
      if (request.params.params?.message?.includes("Recovery complete")) {
        completionAttempts += 1;
        completionIdempotencyKeys.push(request.params.idempotencyKey ?? "");
        if (completionAttempts === 1) {
          throw new Error("completion reply unavailable");
        }
        return { payload: { ts: "1780022050.000200" } };
      }
      return { payload: { ts: "1780022050.000100" } };
    });
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
    const options = {
      account: "soylei",
      target: "channel:C0B0AK14B7X",
      ts: "1780021947.219859",
      botUser: "U0B0BS18D70",
      execute: true,
      json: true,
    } as const;

    await channelsSlackWatchdogReplayCommand(options, firstRuntime, {
      cfg,
      env: { OPENCLAW_STATE_DIR: stateDir },
      now: new Date("2026-05-29T02:41:00.000Z"),
      callGateway,
      agentCommandFromIngress,
    });

    expect(JSON.parse(firstRuntime.logs[0] ?? "{}")).toMatchObject({
      outcome: "dispatched",
      dispatched: true,
      recoveryReply: {
        attempted: true,
        sent: false,
        error: "completion reply unavailable",
      },
    });
    const statePath = path.join(stateDir, "slack", "watchdog-alerts", "soylei.json");
    const failedState = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      {
        replayOutcome?: string;
        replayCompleteReply?: { attemptedAt?: string; sentAt?: string; error?: string };
      }
    >;
    expect(Object.values(failedState)[0]).toMatchObject({
      replayOutcome: "dispatched",
      replayCompleteReply: {
        attemptedAt: "2026-05-29T02:41:00.000Z",
        error: "completion reply unavailable",
      },
    });
    expect(Object.values(failedState)[0]?.replayCompleteReply?.sentAt).toBeUndefined();

    await channelsSlackWatchdogReplayCommand(options, retryRuntime, {
      cfg,
      env: { OPENCLAW_STATE_DIR: stateDir },
      now: new Date("2026-05-29T02:42:00.000Z"),
      callGateway,
      agentCommandFromIngress,
    });

    expect(agentCommandFromIngress).toHaveBeenCalledTimes(1);
    expect(completionAttempts).toBe(2);
    expect(completionIdempotencyKeys).toHaveLength(2);
    expect(completionIdempotencyKeys[0]).toMatch(
      /^channels-watchdog-replay-complete:[0-9a-f]{64}$/,
    );
    expect(completionIdempotencyKeys[1]).toBe(completionIdempotencyKeys[0]);
    expect(JSON.parse(retryRuntime.logs[0] ?? "{}")).toMatchObject({
      outcome: "blocked-already-replayed",
      attempted: false,
      dispatched: false,
      recoveryReply: {
        attempted: true,
        sent: true,
        sourceReplyTs: "1780022050.000200",
      },
    });
    const recoveredState = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      {
        replayCompleteReply?: {
          attemptedAt?: string;
          sentAt?: string;
          sourceReplyTs?: string;
          error?: string;
        };
      }
    >;
    expect(Object.values(recoveredState)[0]?.replayCompleteReply).toEqual({
      attemptedAt: "2026-05-29T02:42:00.000Z",
      sentAt: "2026-05-29T02:42:00.000Z",
      sourceReplyTs: "1780022050.000200",
    });
  });

  it("durably reserves replay execution before concurrent agent side effects", async () => {
    const stateDir = await makeTempState();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    await readSlackAdmissionRecords({
      accountId: "soylei",
      openKeyedStore: <T>(options) =>
        createPluginStateKeyedStoreForTests<T>("slack", { ...options, env }),
    });
    const firstRuntime = createRuntime();
    const secondRuntime = createRuntime();
    const agentStarted = Promise.withResolvers<void>();
    const releaseAgent = Promise.withResolvers<void>();
    const agentCommandFromIngress = vi.fn(async () => {
      agentStarted.resolve();
      await releaseAgent.promise;
      return { payloads: [{ text: "Recovered once." }], meta: {} };
    });
    const historyPayload = {
      payload: {
        messages: [
          {
            channel: "C0B0AK14B7X",
            ts: "1780021947.219859",
            user: "U012ETLV6NQ",
            text: "<@U0B0BS18D70> recover me once",
          },
        ],
      },
    };
    const callGateway = vi.fn(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { action?: string } };
      return request.method === "message.action" && request.params?.action === "send"
        ? { payload: { messageId: "replay-send" } }
        : historyPayload;
    });
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
    const options = {
      account: "soylei",
      target: "channel:C0B0AK14B7X",
      ts: "1780021947.219859",
      botUser: "U0B0BS18D70",
      execute: true,
      json: true,
    } as const;
    const deps = {
      cfg,
      env,
      now: new Date("2026-05-29T02:41:00.000Z"),
      callGateway,
      agentCommandFromIngress,
    };

    const firstExecution = channelsSlackWatchdogReplayCommand(options, firstRuntime, deps);
    await waitForTestPromise(agentStarted.promise, "first replay agent start");
    const statePath = path.join(stateDir, "slack", "watchdog-alerts", "soylei.json");
    const reservedState = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      { replayOutcome?: string; replayReservationId?: string }
    >;
    expect(Object.values(reservedState)[0]).toMatchObject({
      replayOutcome: "in-progress",
      replayReservationId: expect.any(String),
    });
    const secondExecution = channelsSlackWatchdogReplayCommand(options, secondRuntime, deps);
    let secondSettled = false;
    try {
      await waitForTestPromise(secondExecution, "concurrent replay reservation rejection");
      secondSettled = true;
    } finally {
      // Always release the deliberately blocked first agent so a failed assertion cannot hang.
      releaseAgent.resolve();
    }
    await waitForTestPromise(
      Promise.all([firstExecution, secondExecution]),
      "reserved replay completion",
    );

    expect(secondSettled).toBe(true);
    expect(agentCommandFromIngress).toHaveBeenCalledTimes(1);
    expect(JSON.parse(secondRuntime.logs[0] ?? "{}")).toMatchObject({
      outcome: "blocked-already-replaying",
      attempted: false,
      dispatched: false,
    });
    expect(JSON.parse(firstRuntime.logs[0] ?? "{}")).toMatchObject({
      outcome: "dispatched",
      dispatched: true,
    });
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      { replayOutcome?: string; replayReservationId?: string; replayReservedAt?: string }
    >;
    expect(Object.values(state)[0]).toMatchObject({ replayOutcome: "dispatched" });
    expect(Object.values(state)[0]?.replayReservationId).toBeUndefined();
    expect(Object.values(state)[0]?.replayReservedAt).toBeUndefined();
  });

  it("replays structured Slack payloads with stable per-part idempotency keys", async () => {
    const stateDir = await makeTempState();
    const runtime = createRuntime();
    const agentCommandFromIngress = vi.fn(async () => ({
      payloads: [
        {
          mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
          channelData: { slack: { blocks: [{ type: "divider" }] } },
        },
      ],
      meta: {},
    }));
    const callGateway = vi.fn(async () => ({
      payload: {
        messages: [
          {
            channel: "C0B0AK14B7X",
            ts: "1780021947.219859",
            user: "U012ETLV6NQ",
            text: "<@U0B0BS18D70> recover structured reply",
          },
        ],
      },
    }));

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
        now: new Date("2026-05-29T02:41:00.000Z"),
        callGateway,
        agentCommandFromIngress,
      },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "message.action",
        params: expect.objectContaining({
          params: expect.objectContaining({
            media: "https://example.com/one.png",
            threadId: "1780021947.219859",
          }),
          idempotencyKey:
            "channels-watchdog-replay-agent-reply:soylei:C0B0AK14B7X:1780021947.219859:0",
        }),
      }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: "message.action",
        params: expect.objectContaining({
          params: expect.objectContaining({
            media: "https://example.com/two.png",
            threadId: "1780021947.219859",
          }),
          idempotencyKey:
            "channels-watchdog-replay-agent-reply:soylei:C0B0AK14B7X:1780021947.219859:1",
        }),
      }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        method: "message.action",
        params: expect.objectContaining({
          params: expect.objectContaining({
            presentation: { blocks: [{ type: "divider" }] },
            threadId: "1780021947.219859",
          }),
          idempotencyKey:
            "channels-watchdog-replay-agent-reply:soylei:C0B0AK14B7X:1780021947.219859:2",
        }),
      }),
    );
    const report = JSON.parse(runtime.logs[0] ?? "{}") as {
      outcome?: string;
      agentReply?: { sent?: boolean; payloadCount?: number; sentCount?: number };
    };
    expect(report.outcome).toBe("dispatched");
    expect(report.agentReply).toEqual(
      expect.objectContaining({
        sent: true,
        payloadCount: 1,
        sentCount: 3,
      }),
    );
  });

  it("records replay parts durably and returns JSON failure reports", async () => {
    const stateDir = await makeTempState();
    const runtime = createRuntime();
    const agentCommandFromIngress = vi.fn(async () => ({
      payloads: [
        {
          mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
        },
      ],
      meta: {},
    }));
    const historyPayload = {
      payload: {
        messages: [
          {
            channel: "C0B0AK14B7X",
            ts: "1780021947.219859",
            user: "U012ETLV6NQ",
            text: "<@U0B0BS18D70> recover partial reply",
          },
        ],
      },
    };
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce(historyPayload)
      .mockResolvedValueOnce({ payload: { messageId: "reply-part-0" } })
      .mockRejectedValueOnce(new Error("second part failed"));
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

    const failedReport = JSON.parse(runtime.logs[0] ?? "{}") as {
      outcome?: string;
      reason?: string;
      agentReply?: { sent?: boolean; error?: string };
    };
    expect(failedReport.outcome).toBe("failed");
    expect(failedReport.reason).toBe("second part failed");
    expect(failedReport.agentReply).toEqual(
      expect.objectContaining({ sent: false, error: "second part failed" }),
    );
    const statePath = path.join(stateDir, "slack", "watchdog-alerts", "soylei.json");
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as Record<
      string,
      { replayAgentReplyParts?: Record<string, { attemptedAt?: string; sentAt?: string }> }
    >;
    expect(Object.values(state)[0]?.replayAgentReplyParts).toEqual(
      expect.objectContaining({
        "0": expect.objectContaining({
          attemptedAt: "2026-05-29T02:41:00.000Z",
          sentAt: "2026-05-29T02:41:00.000Z",
        }),
        "1": expect.objectContaining({ attemptedAt: "2026-05-29T02:41:00.000Z" }),
      }),
    );

    const retryRuntime = createRuntime();
    const retryGateway = vi
      .fn()
      .mockResolvedValueOnce(historyPayload)
      .mockResolvedValueOnce({ payload: { messageId: "reply-part-1" } })
      .mockResolvedValueOnce({ payload: { messageId: "recovery-complete" } });
    await channelsSlackWatchdogReplayCommand(
      {
        account: "soylei",
        target: "channel:C0B0AK14B7X",
        ts: "1780021947.219859",
        botUser: "U0B0BS18D70",
        execute: true,
        json: true,
      },
      retryRuntime,
      {
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
        now: new Date("2026-05-29T02:42:00.000Z"),
        callGateway: retryGateway,
        agentCommandFromIngress,
      },
    );

    expect(retryGateway).toHaveBeenCalledTimes(1);
    expect(agentCommandFromIngress).toHaveBeenCalledTimes(1);
    const retryReport = JSON.parse(retryRuntime.logs[0] ?? "{}") as {
      outcome?: string;
      reason?: string;
    };
    expect(retryReport.outcome).toBe("blocked-already-attempted");
    expect(retryReport.reason).toContain("manual repair is required");
  });
});
