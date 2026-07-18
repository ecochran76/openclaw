// Slack plugin module implements doctor contract behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  archiveLegacyStateSource,
  asObjectRecord,
  defineChannelAliasMigration,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor";
import {
  normalizeSlackAdmissionRecord,
  openSlackAdmissionLedgerStore,
  slackAdmissionRecordKey,
  SLACK_ADMISSION_LEDGER_NAMESPACE,
  type SlackAdmissionRecord,
} from "./monitor/admission-ledger.js";
import {
  normalizeSlackReconciliationState,
  openSlackReconciliationStateStore,
  SLACK_RECONCILIATION_STATE_NAMESPACE,
  type SlackReconciliationState,
} from "./monitor/reconciliation-state.js";
import { resolveSlackNativeStreaming, resolveSlackStreamingMode } from "./streaming-compat.js";

const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "slack",
  streaming: {
    // Slack maps its legacy draft stream modes (replace/status_final/append)
    // through its own resolver instead of the generic mode parser.
    defaultMode: "partial",
    resolveMode: resolveSlackStreamingMode,
    resolveNativeTransport: resolveSlackNativeStreaming,
  },
  dm: { root: true, accounts: true },
});

function hasLegacySlackChannelAllowAlias(value: unknown): boolean {
  const channels = asObjectRecord(asObjectRecord(value)?.channels);
  if (!channels) {
    return false;
  }
  return Object.values(channels).some((channel) =>
    Object.hasOwn(asObjectRecord(channel) ?? {}, "allow"),
  );
}

function normalizeSlackChannelAllowAliases(params: {
  channels: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { channels: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextChannels = { ...params.channels };
  for (const [channelId, channelValue] of Object.entries(params.channels)) {
    const channel = asObjectRecord(channelValue);
    if (!channel || !Object.hasOwn(channel, "allow")) {
      continue;
    }
    const nextChannel = { ...channel };
    if (nextChannel.enabled === undefined) {
      nextChannel.enabled = channel.allow;
      params.changes.push(
        `Moved ${params.pathPrefix}.${channelId}.allow → ${params.pathPrefix}.${channelId}.enabled.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.${channelId}.allow (${params.pathPrefix}.${channelId}.enabled already set).`,
      );
    }
    delete nextChannel.allow;
    nextChannels[channelId] = nextChannel;
    changed = true;
  }
  return { channels: nextChannels, changed };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.channels.<id>.allow is legacy; use channels.slack.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacySlackChannelAllowAlias,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.channels.<id>.allow is legacy; use channels.slack.accounts.<id>.channels.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => {
      const accounts = asObjectRecord(value);
      if (!accounts) {
        return false;
      }
      return Object.values(accounts).some((account) => hasLegacySlackChannelAllowAlias(account));
    },
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  const aliases = streamingAliasMigration.normalizeChannelConfig({ cfg, changes });
  const rawEntry = asObjectRecord(
    (aliases.config.channels as Record<string, unknown> | undefined)?.slack,
  );
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }
  let updated = rawEntry;
  let changed = aliases.config !== cfg;

  const channels = asObjectRecord(updated.channels);
  if (channels) {
    const normalized = normalizeSlackChannelAllowAliases({
      channels,
      pathPrefix: "channels.slack.channels",
      changes,
    });
    if (normalized.changed) {
      updated = { ...updated, channels: normalized.channels };
      changed = true;
    }
  }

  const accounts = asObjectRecord(updated.accounts);
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts = { ...accounts };
    for (const [accountId, accountValue] of Object.entries(accounts)) {
      const account = asObjectRecord(accountValue);
      const channelEntries = asObjectRecord(account?.channels);
      if (!account || !channelEntries) {
        continue;
      }
      const normalized = normalizeSlackChannelAllowAliases({
        channels: channelEntries,
        pathPrefix: `channels.slack.accounts.${accountId}.channels`,
        changes,
      });
      if (!normalized.changed) {
        continue;
      }
      nextAccounts[accountId] = { ...account, channels: normalized.channels };
      accountsChanged = true;
    }
    if (accountsChanged) {
      updated = { ...updated, accounts: nextAccounts };
      changed = true;
    }
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...aliases.config,
      channels: {
        ...aliases.config.channels,
        slack: updated as unknown as NonNullable<OpenClawConfig["channels"]>["slack"],
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}

type LegacyStateFile = {
  filePath: string;
  name: string;
};

async function listLegacyStateFiles(
  directory: string,
  extension: string,
): Promise<LegacyStateFile[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
      .map((entry) => ({ filePath: path.join(directory, entry.name), name: entry.name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function readLegacyAdmissionRecords(filePath: string): Promise<{
  records: SlackAdmissionRecord[];
  malformedRows: number;
}> {
  const lines = (await fs.readFile(filePath, "utf8"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
  const records: SlackAdmissionRecord[] = [];
  let malformedRows = 0;
  for (const line of lines) {
    try {
      const record = normalizeSlackAdmissionRecord(JSON.parse(line));
      if (record) {
        records.push(record);
      } else {
        malformedRows++;
      }
    } catch {
      malformedRows++;
    }
  }
  return { records, malformedRows };
}

async function readLegacyReconciliationState(
  filePath: string,
): Promise<SlackReconciliationState | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(filePath, "utf8"),
    ) as Partial<SlackReconciliationState>;
    const accountId = typeof parsed.accountId === "string" ? parsed.accountId.trim() : "";
    const channels = asObjectRecord(parsed.channels);
    const candidates = asObjectRecord(parsed.candidates);
    if (
      parsed.version !== 1 ||
      !accountId ||
      parsed.accountId !== accountId ||
      !channels ||
      !candidates
    ) {
      return undefined;
    }
    const normalized = normalizeSlackReconciliationState(parsed, accountId);
    // Runtime reads may repair cache state, but migration archives its only source.
    // Require an exact semantic round trip so nested coercion or omission cannot lose data.
    if (!isDeepStrictEqual(parsed, normalized)) {
      return undefined;
    }
    return normalized;
  } catch {
    return undefined;
  }
}

export const stateMigrations: PluginDoctorStateMigration[] = [
  {
    id: "slack-runtime-state-to-plugin-state",
    label: "Slack admission and reconciliation state",
    async detectLegacyState(params) {
      const [admissionFiles, reconciliationFiles] = await Promise.all([
        listLegacyStateFiles(path.join(params.stateDir, "slack", "admission-ledger"), ".jsonl"),
        listLegacyStateFiles(path.join(params.stateDir, "slack", "reconciliation"), ".json"),
      ]);
      if (admissionFiles.length === 0 && reconciliationFiles.length === 0) {
        return null;
      }
      const preview: string[] = [];
      if (admissionFiles.length > 0) {
        preview.push(
          `- Slack admission ledgers: ${admissionFiles.length} file(s) -> plugin state (${SLACK_ADMISSION_LEDGER_NAMESPACE})`,
        );
      }
      if (reconciliationFiles.length > 0) {
        preview.push(
          `- Slack reconciliation state: ${reconciliationFiles.length} file(s) -> plugin state (${SLACK_RECONCILIATION_STATE_NAMESPACE})`,
        );
      }
      return { preview };
    },
    async migrateLegacyState(params) {
      const changes: string[] = [];
      const warnings: string[] = [];
      const [admissionFiles, reconciliationFiles] = await Promise.all([
        listLegacyStateFiles(path.join(params.stateDir, "slack", "admission-ledger"), ".jsonl"),
        listLegacyStateFiles(path.join(params.stateDir, "slack", "reconciliation"), ".json"),
      ]);
      const admissionStore = openSlackAdmissionLedgerStore(
        params.context.openPluginStateKeyedStore,
      );
      for (const source of admissionFiles) {
        const { records, malformedRows } = await readLegacyAdmissionRecords(source.filePath);
        let imported = 0;
        let alreadyPresent = 0;
        for (const record of records) {
          if (await admissionStore.registerIfAbsent(slackAdmissionRecordKey(record), record)) {
            imported++;
          } else {
            alreadyPresent++;
          }
        }
        changes.push(
          `Migrated Slack admission records -> plugin state (${imported} imported, ${alreadyPresent} already present)`,
        );
        if (malformedRows > 0) {
          warnings.push(
            `Left Slack admission legacy source in place because it contains ${malformedRows} malformed row(s): ${source.filePath}`,
          );
          continue;
        }
        await archiveLegacyStateSource({
          filePath: source.filePath,
          label: "Slack admission-ledger",
          changes,
          warnings,
        });
      }

      const reconciliationStore = openSlackReconciliationStateStore(
        params.context.openPluginStateKeyedStore,
      );
      for (const source of reconciliationFiles) {
        const legacyState = await readLegacyReconciliationState(source.filePath);
        if (!legacyState) {
          warnings.push(
            `Left malformed Slack reconciliation legacy source in place: ${source.filePath}`,
          );
          continue;
        }
        const existingState = await reconciliationStore.lookup(legacyState.accountId);
        if (existingState) {
          changes.push(
            `Kept existing Slack reconciliation plugin state for ${legacyState.accountId}`,
          );
          warnings.push(
            `Left Slack reconciliation legacy source in place because plugin state already exists for ${legacyState.accountId}: ${source.filePath}`,
          );
          continue;
        }
        const inserted = await reconciliationStore.registerIfAbsent(
          legacyState.accountId,
          legacyState,
        );
        if (!inserted) {
          changes.push(
            `Kept concurrently created Slack reconciliation plugin state for ${legacyState.accountId}`,
          );
          warnings.push(
            `Left Slack reconciliation legacy source in place because plugin state was created concurrently for ${legacyState.accountId}: ${source.filePath}`,
          );
          continue;
        }
        changes.push(
          `Migrated Slack reconciliation state for ${legacyState.accountId} -> plugin state`,
        );
        await archiveLegacyStateSource({
          filePath: source.filePath,
          label: "Slack reconciliation",
          changes,
          warnings,
        });
      }
      return { changes, warnings };
    },
  },
];
