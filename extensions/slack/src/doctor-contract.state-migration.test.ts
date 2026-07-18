import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { PluginDoctorStateMigrationContext } from "openclaw/plugin-sdk/runtime-doctor";
import { afterEach, describe, expect, it } from "vitest";
import { stateMigrations } from "./doctor-contract.js";
import {
  openSlackAdmissionLedgerStore,
  SLACK_ADMISSION_LEDGER_NAMESPACE,
} from "./monitor/admission-ledger.js";
import {
  openSlackReconciliationStateStore,
  SLACK_RECONCILIATION_STATE_NAMESPACE,
} from "./monitor/reconciliation-state.js";

const tempDirs: string[] = [];

afterEach(async () => {
  resetPluginStateStoreForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("Slack doctor state migration", () => {
  it("imports legacy admission and reconciliation files into plugin state and archives them", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-migration-"));
    tempDirs.push(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const admissionPath = path.join(stateDir, "slack", "admission-ledger", "work.jsonl");
    const reconciliationPath = path.join(stateDir, "slack", "reconciliation", "work.json");
    await fs.mkdir(path.dirname(admissionPath), { recursive: true });
    await fs.mkdir(path.dirname(reconciliationPath), { recursive: true });
    await fs.writeFile(
      admissionPath,
      `${JSON.stringify({
        version: 1,
        recordedAt: "2026-07-14T12:00:00.000Z",
        accountId: "work",
        channel: "C123",
        ts: "1.000001",
        outcome: "accepted",
      })}\n`,
    );
    await fs.writeFile(
      reconciliationPath,
      JSON.stringify({
        version: 1,
        accountId: "work",
        channels: {
          C123: {
            counts: { scanned: 2, skipped: 0, missing: 1, dropped: 0, replayed: 1, failed: 0 },
          },
        },
        candidates: {},
      }),
    );

    const openPluginStateKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("slack", { ...options, env });
    const context: PluginDoctorStateMigrationContext = { openPluginStateKeyedStore };
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("expected Slack state migration");
    }
    const params = {
      config: {} as OpenClawConfig,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context,
    };

    await expect(migration.detectLegacyState(params)).resolves.toEqual({
      preview: [
        `- Slack admission ledgers: 1 file(s) -> plugin state (${SLACK_ADMISSION_LEDGER_NAMESPACE})`,
        `- Slack reconciliation state: 1 file(s) -> plugin state (${SLACK_RECONCILIATION_STATE_NAMESPACE})`,
      ],
    });
    const result = await migration.migrateLegacyState(params);

    expect(result.warnings).toEqual([]);
    await expect(fs.stat(`${admissionPath}.migrated`)).resolves.toBeDefined();
    await expect(fs.stat(`${reconciliationPath}.migrated`)).resolves.toBeDefined();
    await expect(
      openSlackAdmissionLedgerStore(openPluginStateKeyedStore).entries(),
    ).resolves.toEqual([
      expect.objectContaining({
        value: expect.objectContaining({ accountId: "work", ts: "1.000001" }),
      }),
    ]);
    await expect(
      openSlackReconciliationStateStore(openPluginStateKeyedStore).lookup("work"),
    ).resolves.toEqual(
      expect.objectContaining({
        accountId: "work",
        channels: {
          C123: expect.objectContaining({ counts: expect.objectContaining({ scanned: 2 }) }),
        },
      }),
    );
  });

  it("retains legacy sources when admission rows or reconciliation entries are malformed", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-migration-bad-"));
    tempDirs.push(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const admissionPath = path.join(stateDir, "slack", "admission-ledger", "work.jsonl");
    const reconciliationChannelPath = path.join(
      stateDir,
      "slack",
      "reconciliation",
      "work-bad-channel.json",
    );
    const reconciliationCandidatePath = path.join(
      stateDir,
      "slack",
      "reconciliation",
      "work-bad-candidate.json",
    );
    await fs.mkdir(path.dirname(admissionPath), { recursive: true });
    await fs.mkdir(path.dirname(reconciliationChannelPath), { recursive: true });
    await fs.writeFile(
      admissionPath,
      `${JSON.stringify({
        version: 1,
        recordedAt: "not-a-timestamp",
        accountId: "work",
        outcome: "accepted-ish",
      })}\n`,
    );
    await fs.writeFile(
      reconciliationChannelPath,
      JSON.stringify({
        version: 1,
        accountId: "work",
        channels: {
          C123: {
            counts: { scanned: 2, skipped: 0, missing: 1, dropped: 0, replayed: 1, failed: 0 },
          },
          CINVALID: null,
        },
        candidates: {},
      }),
    );
    await fs.writeFile(
      reconciliationCandidatePath,
      JSON.stringify({
        version: 1,
        accountId: "work",
        channels: {
          C123: {
            counts: { scanned: 2, skipped: 0, missing: 1, dropped: 0, replayed: 1, failed: 0 },
          },
        },
        candidates: {
          invalid: { channel: "C123", ts: "1.000001", status: "missing-admission" },
        },
      }),
    );

    const openPluginStateKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("slack", { ...options, env });
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("expected Slack state migration");
    }
    const result = await migration.migrateLegacyState({
      config: {} as OpenClawConfig,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: { openPluginStateKeyedStore },
    });

    expect(result.warnings).toHaveLength(3);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("contains 1 malformed row(s)"),
        expect.stringContaining(reconciliationChannelPath),
        expect.stringContaining(reconciliationCandidatePath),
      ]),
    );
    await expect(fs.stat(admissionPath)).resolves.toBeDefined();
    await expect(fs.stat(reconciliationChannelPath)).resolves.toBeDefined();
    await expect(fs.stat(reconciliationCandidatePath)).resolves.toBeDefined();
    await expect(fs.stat(`${admissionPath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${reconciliationChannelPath}.migrated`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(`${reconciliationCandidatePath}.migrated`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      openSlackAdmissionLedgerStore(openPluginStateKeyedStore).entries(),
    ).resolves.toEqual([]);
    await expect(
      openSlackReconciliationStateStore(openPluginStateKeyedStore).lookup("work"),
    ).resolves.toBeUndefined();
  });

  it("retains a partial legacy reconciliation source when canonical account state exists", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-migration-existing-"));
    tempDirs.push(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const reconciliationPath = path.join(stateDir, "slack", "reconciliation", "work.json");
    await fs.mkdir(path.dirname(reconciliationPath), { recursive: true });
    await fs.writeFile(
      reconciliationPath,
      JSON.stringify({
        version: 1,
        accountId: "work",
        channels: {
          CLEGACY: {
            counts: { scanned: 4, skipped: 0, missing: 1, dropped: 0, replayed: 0, failed: 0 },
          },
        },
        candidates: {
          "CLEGACY:1.000001": {
            channel: "CLEGACY",
            ts: "1.000001",
            status: "missing-admission",
            reason: "activation-without-ledger-record",
            firstSeenAt: "2026-07-14T12:00:00.000Z",
            lastSeenAt: "2026-07-14T12:00:00.000Z",
          },
        },
      }),
    );

    const openPluginStateKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("slack", { ...options, env });
    const reconciliationStore = openSlackReconciliationStateStore(openPluginStateKeyedStore);
    const canonicalState = {
      version: 1 as const,
      accountId: "work",
      channels: {
        CEXISTING: {
          counts: { scanned: 9, skipped: 1, missing: 0, dropped: 0, replayed: 0, failed: 0 },
        },
      },
      candidates: {},
    };
    await reconciliationStore.register("work", canonicalState);
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("expected Slack state migration");
    }

    const result = await migration.migrateLegacyState({
      config: {} as OpenClawConfig,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: { openPluginStateKeyedStore },
    });

    expect(result.changes).toContain("Kept existing Slack reconciliation plugin state for work");
    expect(result.warnings).toEqual([
      expect.stringContaining("plugin state already exists for work"),
    ]);
    await expect(fs.stat(reconciliationPath)).resolves.toBeDefined();
    await expect(fs.stat(`${reconciliationPath}.migrated`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(reconciliationStore.lookup("work")).resolves.toEqual(canonicalState);
  });

  it("retains legacy reconciliation sources with lossy nested normalization", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slack-migration-lossy-"));
    tempDirs.push(stateDir);
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const reconciliationDir = path.join(stateDir, "slack", "reconciliation");
    await fs.mkdir(reconciliationDir, { recursive: true });
    const counts = {
      scanned: 2,
      skipped: 0,
      missing: 1,
      dropped: 0,
      replayed: 0,
      failed: 0,
    };
    const cases = [
      {
        accountId: "pending-roots",
        filePath: path.join(reconciliationDir, "pending-roots.json"),
        channels: {
          C123: {
            counts,
            pendingThreadRoots: [{ ts: "1.000001" }, { cursor: "lost-without-ts" }],
          },
        },
        candidates: {},
      },
      {
        accountId: "counter",
        filePath: path.join(reconciliationDir, "counter.json"),
        channels: {
          C123: { counts: { ...counts, scanned: -4 } },
        },
        candidates: {},
      },
      {
        accountId: "candidate",
        filePath: path.join(reconciliationDir, "candidate.json"),
        channels: { C123: { counts } },
        candidates: {
          "C123:1.000001": {
            channel: "C123",
            ts: "1.000001",
            status: "missing-admission",
            reason: "activation-without-ledger-record",
            firstSeenAt: "2026-07-14T12:00:00.000Z",
            lastSeenAt: "2026-07-14T12:00:00.000Z",
            textLength: -5,
          },
        },
      },
    ];
    await Promise.all(
      cases.map((entry) =>
        fs.writeFile(
          entry.filePath,
          JSON.stringify({
            version: 1,
            accountId: entry.accountId,
            channels: entry.channels,
            candidates: entry.candidates,
          }),
        ),
      ),
    );

    const openPluginStateKeyedStore = <T>(options: OpenKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests<T>("slack", { ...options, env });
    const migration = stateMigrations[0];
    if (!migration) {
      throw new Error("expected Slack state migration");
    }
    const result = await migration.migrateLegacyState({
      config: {} as OpenClawConfig,
      env,
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
      context: { openPluginStateKeyedStore },
    });

    expect(result.warnings).toHaveLength(cases.length);
    for (const entry of cases) {
      expect(result.warnings).toContainEqual(expect.stringContaining(entry.filePath));
      await expect(fs.stat(entry.filePath)).resolves.toBeDefined();
      await expect(fs.stat(`${entry.filePath}.migrated`)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        openSlackReconciliationStateStore(openPluginStateKeyedStore).lookup(entry.accountId),
      ).resolves.toBeUndefined();
    }
  });
});
