// Normalizes installed plugin config and install records.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { buildNpmResolutionFields, type NpmSpecResolution } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";

/** Plugin install record update with the target plugin id attached. */
export type PluginInstallUpdate = PluginInstallRecord & { pluginId: string };

const CLAWHUB_TRUST_INSTALL_RECORD_FIELDS = [
  "clawhubTrustDisposition",
  "clawhubTrustScanStatus",
  "clawhubTrustModerationState",
  "clawhubTrustReasons",
  "clawhubTrustPending",
  "clawhubTrustStale",
  "clawhubTrustCheckedAt",
  "clawhubTrustAcknowledgedAt",
] as const satisfies readonly (keyof PluginInstallRecord)[];

const INSTALL_RECORD_DERIVED_FIELDS = [
  "resolvedName",
  "resolvedVersion",
  "resolvedSpec",
  "integrity",
  "shasum",
  "resolvedAt",
  "artifactKind",
  "artifactFormat",
  "npmIntegrity",
  "npmShasum",
  "npmTarballName",
  "clawhubUrl",
  "clawhubPackage",
  "clawhubFamily",
  "clawhubChannel",
  "clawpackSha256",
  "clawpackSpecVersion",
  "clawpackManifestSha256",
  "clawpackSize",
  "gitUrl",
  "gitRef",
  "gitCommit",
] as const satisfies readonly (keyof PluginInstallRecord)[];

const INSTALL_RECORD_CLEAR_WHEN_OMITTED_FIELDS = [
  ...INSTALL_RECORD_DERIVED_FIELDS,
  ...CLAWHUB_TRUST_INSTALL_RECORD_FIELDS,
] as const satisfies readonly (keyof PluginInstallRecord)[];

function mergePluginInstallRecord(
  previous: PluginInstallRecord | undefined,
  next: PluginInstallRecord,
): PluginInstallRecord {
  const merged: PluginInstallRecord = {
    ...previous,
    ...next,
  };
  for (const field of INSTALL_RECORD_CLEAR_WHEN_OMITTED_FIELDS) {
    if (next[field] === undefined) {
      delete merged[field];
    }
  }
  return merged;
}

/** Builds install record fields from resolved npm package metadata. */
export function buildNpmResolutionInstallFields(
  resolution?: NpmSpecResolution,
): Pick<
  PluginInstallRecord,
  "resolvedName" | "resolvedVersion" | "resolvedSpec" | "integrity" | "shasum" | "resolvedAt"
> {
  return buildNpmResolutionFields(resolution);
}

function isExactRegistryNpmSpec(spec: string | undefined): spec is string {
  const parsed = spec ? parseRegistryNpmSpec(spec) : null;
  return parsed?.selectorKind === "exact-version";
}

export function resolveNpmInstallRecordSpec(params: {
  requestedSpec?: string;
  resolution?: NpmSpecResolution;
  pinResolvedRegistrySpec?: boolean;
}): string | undefined {
  const resolvedSpec = params.resolution?.resolvedSpec;
  if (!params.pinResolvedRegistrySpec || !isExactRegistryNpmSpec(resolvedSpec)) {
    return params.requestedSpec;
  }
  return resolvedSpec;
}

/** Records or updates a plugin install record in OpenClaw config. */
export function recordPluginInstall(
  cfg: OpenClawConfig,
  update: PluginInstallUpdate,
): OpenClawConfig {
  const { pluginId, ...record } = update;
  const installs = {
    ...cfg.plugins?.installs,
    [pluginId]: mergePluginInstallRecord(cfg.plugins?.installs?.[pluginId], {
      ...record,
      installedAt: record.installedAt ?? new Date().toISOString(),
    }),
  };

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      installs: {
        ...installs,
        [pluginId]: installs[pluginId],
      },
    },
  };
}
