import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import {
  appendSlackAdmissionRecord,
  buildSlackAdmissionRecord,
  normalizeSlackAdmissionRecord,
  readSlackAdmissionRecords,
  recordSlackAdmission,
} from "./admission-ledger.js";

const tempDirs: string[] = [];

async function createOpenKeyedStore() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-ledger-"));
  tempDirs.push(stateDir);
  const env = { OPENCLAW_STATE_DIR: stateDir };
  return <T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("slack", { ...options, env });
}

afterEach(async () => {
  resetPluginStateStoreForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function slackMessage(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    type: "message",
    channel: "C123",
    user: "U123",
    text: "<@UOPENCLAW> hello",
    ts: "1779124819.383009",
    thread_ts: "1779054888.591249",
    client_msg_id: "client-1",
    ...overrides,
  } as SlackMessageEvent;
}

describe("slack admission ledger", () => {
  it.each([
    ["blank account", { accountId: " " }],
    ["invalid timestamp", { recordedAt: "not-a-timestamp" }],
    ["unknown outcome", { outcome: "accepted-ish" }],
  ])("rejects a legacy record with %s", (_label, override) => {
    expect(
      normalizeSlackAdmissionRecord({
        version: 1,
        recordedAt: "2026-05-18T18:00:00.000Z",
        accountId: "soylei",
        outcome: "accepted",
        ...override,
      }),
    ).toBeUndefined();
  });

  it("normalizes legacy records through the supported field allowlist", () => {
    const record = normalizeSlackAdmissionRecord({
      version: 1,
      recordedAt: " 2026-05-18T18:00:00.000Z ",
      accountId: " soylei ",
      channel: " C123 ",
      source: "message",
      outcome: "accepted",
      textHash: "hash",
      textLength: 12,
      text: "raw legacy message",
      unknownField: "do not retain",
    });

    expect(record).toEqual({
      version: 1,
      recordedAt: "2026-05-18T18:00:00.000Z",
      accountId: "soylei",
      channel: "C123",
      source: "message",
      outcome: "accepted",
      textHash: "hash",
      textLength: 12,
    });
    expect(JSON.stringify(record)).not.toContain("raw legacy message");
  });

  it("builds redacted admission records with text hash metadata", () => {
    const record = buildSlackAdmissionRecord({
      accountId: "soylei",
      message: slackMessage(),
      source: "app_mention",
      outcome: "accepted",
      routeAgentId: "soylei-website",
      sessionKey: "agent:soylei-website:slack:thread",
      now: new Date("2026-05-18T18:00:00.000Z"),
    });

    expect(record).toMatchObject({
      version: 1,
      recordedAt: "2026-05-18T18:00:00.000Z",
      accountId: "soylei",
      channel: "C123",
      ts: "1779124819.383009",
      threadTs: "1779054888.591249",
      clientMsgId: "client-1",
      source: "app_mention",
      outcome: "accepted",
      routeAgentId: "soylei-website",
      sessionKey: "agent:soylei-website:slack:thread",
      user: "U123",
    });
    expect(record.textHash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.textLength).toBe("<@UOPENCLAW> hello".length);
    expect(JSON.stringify(record)).not.toContain("<@UOPENCLAW> hello");
  });

  it("persists records in plugin state for watchdog scans", async () => {
    const openKeyedStore = await createOpenKeyedStore();
    const record = buildSlackAdmissionRecord({
      accountId: "soylei",
      message: slackMessage(),
      outcome: "dropped",
      reason: "no-mention",
      now: new Date("2026-05-18T18:00:00.000Z"),
    });

    await expect(
      appendSlackAdmissionRecord({ accountId: "soylei", record, openKeyedStore }),
    ).resolves.toBe(true);
    await expect(
      readSlackAdmissionRecords({ accountId: "soylei", openKeyedStore }),
    ).resolves.toEqual([
      expect.objectContaining({
        accountId: "soylei",
        outcome: "dropped",
        reason: "no-mention",
        ts: "1779124819.383009",
      }),
    ]);
  });

  it("builds replay outcome records without storing raw message text", () => {
    const record = buildSlackAdmissionRecord({
      accountId: "soylei",
      message: slackMessage({ text: "<@UOPENCLAW> replay this" }),
      outcome: "replay-dispatched",
      reason: "watchdog-replay-dispatched",
      routeAgentId: "main",
      sessionKey: "agent:main:slack:channel:c123:thread:1779124819.383009",
      now: new Date("2026-05-29T02:41:00.000Z"),
    });

    expect(record).toMatchObject({
      outcome: "replay-dispatched",
      reason: "watchdog-replay-dispatched",
      routeAgentId: "main",
      sessionKey: "agent:main:slack:channel:c123:thread:1779124819.383009",
    });
    expect(record.textHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain("replay this");
  });

  it("reads recent plugin-state records for watchdog scans", async () => {
    const openKeyedStore = await createOpenKeyedStore();
    const first = buildSlackAdmissionRecord({
      accountId: "soylei",
      message: slackMessage({ ts: "1.000001" }),
      outcome: "accepted",
      now: new Date("2026-05-18T18:00:00.000Z"),
    });
    const second = buildSlackAdmissionRecord({
      accountId: "soylei",
      message: slackMessage({ ts: "1.000002" }),
      outcome: "dropped",
      reason: "slack-no-mention",
      now: new Date("2026-05-18T18:01:00.000Z"),
    });
    await appendSlackAdmissionRecord({ accountId: "soylei", record: first, openKeyedStore });
    await appendSlackAdmissionRecord({ accountId: "soylei", record: second, openKeyedStore });

    await expect(
      readSlackAdmissionRecords({ accountId: "soylei", openKeyedStore, limit: 1 }),
    ).resolves.toEqual([expect.objectContaining({ ts: "1.000002", outcome: "dropped" })]);
  });

  it("logs and returns false when plugin state cannot be written", async () => {
    const logger = { warn: vi.fn() };
    const openKeyedStore = vi.fn(() => {
      throw new Error("state unavailable");
    });

    await expect(
      recordSlackAdmission({
        accountId: "soylei",
        message: slackMessage(),
        outcome: "accepted",
        openKeyedStore,
        logger,
      }),
    ).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "soylei" }),
      "failed writing slack admission state",
    );
  });

  it("rejects when plugin state cannot be read", async () => {
    const logger = { warn: vi.fn() };
    const openKeyedStore = vi.fn(() => {
      throw new Error("state unavailable");
    });

    await expect(
      readSlackAdmissionRecords({ accountId: "soylei", openKeyedStore, logger }),
    ).rejects.toThrow("state unavailable");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "soylei" }),
      "failed reading slack admission state",
    );
  });
});
