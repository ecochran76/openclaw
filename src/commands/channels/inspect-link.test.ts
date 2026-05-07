import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  buildInspectLinkIngressReport,
  buildRelatedSlackMessages,
  buildSessionMatches,
  parseSlackPermalink,
  summarizeTrajectoryFile,
} from "./inspect-link.js";

let tempDir: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inspect-link-"));
});

afterEach(async () => {
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
  tempDir = undefined;
});

describe("parseSlackPermalink", () => {
  it("parses Slack channel, message timestamp, and thread timestamp", () => {
    expect(
      parseSlackPermalink(
        "https://soyleiinnovations.slack.com/archives/C06L8DVBWQP/p1778010362706599?thread_ts=1778010362.706599&cid=C06L8DVBWQP",
      ),
    ).toMatchObject({
      host: "soyleiinnovations.slack.com",
      channelId: "C06L8DVBWQP",
      target: "channel:C06L8DVBWQP",
      messageTs: "1778010362.706599",
      rawMessageTs: "1778010362706599",
      threadTs: "1778010362.706599",
    });
  });

  it("rejects non-Slack-permalink shapes", () => {
    expect(() => parseSlackPermalink("https://example.com/not-slack")).toThrow(
      "/archives/<channel>/p<ts>",
    );
  });
});

describe("buildRelatedSlackMessages", () => {
  it("finds the linked bot message and nearby human prompt", () => {
    const parsed = parseSlackPermalink(
      "https://soyleiinnovations.slack.com/archives/C123/p1778010362706599",
    );
    const related = buildRelatedSlackMessages({
      parsed,
      messages: [
        {
          ts: "1778010362.706599",
          bot_id: "B123",
          subtype: "bot_message",
          text: "working: preparing reply",
        },
        {
          ts: "1778010360.683399",
          user: "U123",
          text: "please investigate this thread",
        },
        {
          ts: "1778010300.000000",
          user: "U999",
          text: "too old",
        },
      ],
    });

    expect(related).toMatchObject([
      { role: "linked", ts: "1778010362.706599", botId: "B123" },
      { role: "nearby-human-prompt", ts: "1778010360.683399", user: "U123" },
    ]);
  });
});

describe("buildSessionMatches", () => {
  it("scores thread and channel session-store entries", () => {
    const parsed = parseSlackPermalink(
      "https://soyleiinnovations.slack.com/archives/C123/p1778010362706599?thread_ts=1778010362.706599",
    );
    const threadEntry: SessionEntry = {
      sessionId: "thread-session",
      updatedAt: 1_778_010_370_000,
      sessionFile: "/tmp/thread.jsonl",
      deliveryContext: {
        channel: "slack",
        to: "channel:C123",
        accountId: "soylei",
        threadId: "1778010362.706599",
      },
    };
    const channelEntry: SessionEntry = {
      sessionId: "channel-session",
      updatedAt: 1_778_010_365_000,
      sessionFile: "/tmp/channel.jsonl",
      deliveryContext: {
        channel: "slack",
        to: "channel:C123",
        accountId: "soylei",
      },
    };

    const matches = buildSessionMatches({
      targets: [
        {
          agentId: "soylei-website",
          storePath: "/tmp/sessions.json",
          store: {
            "agent:soylei-website:slack:channel:c123:thread:1778010362.706599": threadEntry,
            "agent:soylei-website:slack:channel:c123": channelEntry,
          },
        },
      ],
      parsed,
      accountId: "soylei",
      relatedSlackMessages: [{ role: "linked", ts: "1778010362.706599" }],
    });

    expect(matches[0]).toMatchObject({
      sessionId: "thread-session",
      score: expect.any(Number),
    });
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
    expect(matches[0]!.reasons).toContain("thread id matches");
  });
});

describe("buildInspectLinkIngressReport", () => {
  it("flags a linked message newer than account inbound activity", () => {
    const report = buildInspectLinkIngressReport({
      accountId: "soylei",
      target: "channel:C123",
      now: 1_778_010_370_000,
      linkedMessage: {
        ts: "1778010362.706599",
        user: "U123",
        text: "please investigate",
      },
      account: {
        accountId: "soylei",
        running: true,
        connected: true,
        lastStartAt: 1_778_000_000_000,
        lastInboundAt: 1_778_010_000_000,
        lastTransportActivityAt: 1_778_010_300_000,
      },
    });

    expect(report.verdict).toBe("likely-not-ingested");
    expect(report.linkedMessage).toMatchObject({
      ts: "1778010362.706599",
      user: "U123",
      textPreview: "please investigate",
    });
  });
});

describe("summarizeTrajectoryFile", () => {
  it("flags a started run that never ended", async () => {
    const filePath = path.join(tempDir!, "session.trajectory.jsonl");
    await fs.writeFile(
      filePath,
      [
        JSON.stringify({
          type: "session.started",
          timestamp: "2026-05-05T19:46:10.591Z",
          runId: "run-1",
        }),
        JSON.stringify({
          type: "prompt.submitted",
          runId: "run-1",
        }),
      ].join("\n"),
    );

    await expect(summarizeTrajectoryFile(filePath)).resolves.toMatchObject({
      events: 2,
      runs: 1,
      incompleteRuns: [{ runId: "run-1", startedAt: "2026-05-05T19:46:10.591Z" }],
    });
  });
});
