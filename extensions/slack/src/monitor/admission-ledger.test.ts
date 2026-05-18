import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import {
  appendSlackAdmissionRecord,
  buildSlackAdmissionRecord,
  recordSlackAdmission,
  resolveSlackAdmissionLedgerPath,
} from "./admission-ledger.js";

const tempDirs: string[] = [];

async function makeTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-ledger-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
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
  it("resolves the ledger path under OPENCLAW_STATE_DIR", () => {
    expect(
      resolveSlackAdmissionLedgerPath({
        accountId: "Soy Lei/Main",
        env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      }),
    ).toBe("/tmp/openclaw-state/slack/admission-ledger/Soy_Lei_Main.jsonl");
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

  it("appends JSONL records for watchdog scans", async () => {
    const stateDir = await makeTempDir();
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const record = buildSlackAdmissionRecord({
      accountId: "soylei",
      message: slackMessage(),
      outcome: "dropped",
      reason: "no-mention",
      now: new Date("2026-05-18T18:00:00.000Z"),
    });

    await expect(appendSlackAdmissionRecord({ accountId: "soylei", record, env })).resolves.toBe(
      true,
    );

    const ledgerPath = resolveSlackAdmissionLedgerPath({ accountId: "soylei", env });
    const lines = (await fs.readFile(ledgerPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      accountId: "soylei",
      outcome: "dropped",
      reason: "no-mention",
      ts: "1779124819.383009",
    });
  });

  it("logs and returns false when the ledger cannot be written", async () => {
    const stateDir = await makeTempDir();
    await fs.writeFile(path.join(stateDir, "slack"), "not a directory");
    const logger = { warn: vi.fn() };

    await expect(
      recordSlackAdmission({
        accountId: "soylei",
        message: slackMessage(),
        outcome: "accepted",
        env: { OPENCLAW_STATE_DIR: stateDir },
        logger,
      }),
    ).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "soylei" }),
      "failed writing slack admission ledger",
    );
  });
});
