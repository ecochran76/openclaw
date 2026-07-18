/**
 * Plans which core, bundle MCP, and bundle LSP tools an attempt should build.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { TOOL_NAME_SEPARATOR } from "../../agent-bundle-mcp-names.js";
import { resolveEffectiveToolPolicy } from "../../agent-tools.policy.js";
import {
  type CoreToolFactoryFamily,
  type OpenClawCodingToolConstructionPlan,
  resolveCoreToolFactoryFamily,
} from "../../core-tool-factory-descriptors.js";
import { isToolAllowedByPolicyName } from "../../tool-policy-match.js";
import {
  buildPluginToolGroups,
  expandPolicyWithPluginGroups,
  expandToolGroups,
  mergeAlsoAllowPolicy,
  normalizeToolList,
  normalizeToolName,
  resolveToolProfilePolicy,
} from "../../tool-policy.js";

const ALL_CODING_TOOL_CONSTRUCTION_PLAN: OpenClawCodingToolConstructionPlan = {
  includeBaseCodingTools: true,
  includeShellTools: true,
  includeChannelTools: true,
  includeOpenClawTools: true,
  includePluginTools: true,
};

const NO_CODING_TOOL_CONSTRUCTION_PLAN: OpenClawCodingToolConstructionPlan = {
  includeBaseCodingTools: false,
  includeShellTools: false,
  includeChannelTools: false,
  includeOpenClawTools: false,
  includePluginTools: false,
};

function cloneCodingToolConstructionPlan(
  plan: OpenClawCodingToolConstructionPlan,
): OpenClawCodingToolConstructionPlan {
  return { ...plan };
}

function isBundleMcpAllowlistName(normalized: string): boolean {
  // Bundle MCP tools use the synthetic bundle name or `bundle__tool` separator form.
  return normalized === "bundle-mcp" || normalized.includes(TOOL_NAME_SEPARATOR);
}

function isPluginGroupAllowlistName(normalized: string): boolean {
  return normalized === "group:plugins";
}

type BundleMcpPolicyParams = {
  toolsAllow?: string[];
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
};

function resolveBundleMcpPolicyContext(params: BundleMcpPolicyParams) {
  const effective = resolveEffectiveToolPolicy({
    config: params.config,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const policies = [
    params.toolsAllow ? { allow: params.toolsAllow } : undefined,
    mergeAlsoAllowPolicy(resolveToolProfilePolicy(effective.profile), effective.profileAlsoAllow),
    mergeAlsoAllowPolicy(
      resolveToolProfilePolicy(effective.providerProfile),
      effective.providerProfileAlsoAllow,
    ),
    effective.globalPolicy,
    effective.globalProviderPolicy,
    effective.agentPolicy,
    effective.agentProviderPolicy,
  ];
  const candidates = policies.flatMap((policy) => policy?.allow ?? []).map(normalizeToolName);
  return { candidates, policies };
}

function isBroadBundleMcpPolicyName(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return normalized === "*" || normalized === "bundle-mcp" || normalized === "group:plugins";
}

function isBundleMcpCandidateAllowedByPolicy(
  toolName: string,
  policy: { allow?: string[]; deny?: string[] } | undefined,
): boolean {
  if (!policy) {
    return true;
  }
  if (policy.deny?.some(isBroadBundleMcpPolicyName)) {
    return false;
  }
  if (!isToolAllowedByPolicyName(toolName, { deny: policy.deny })) {
    return false;
  }
  if (!policy.allow || policy.allow.length === 0) {
    return true;
  }
  return (
    policy.allow.some(isBroadBundleMcpPolicyName) ||
    isToolAllowedByPolicyName(toolName, { allow: policy.allow })
  );
}

function doesPolicyAllowAllBundleMcpTools(
  policy: { allow?: string[]; deny?: string[] } | undefined,
): boolean {
  if (!policy) {
    return true;
  }
  if (policy.deny?.some(isBroadBundleMcpPolicyName)) {
    return false;
  }
  return (
    !policy.allow || policy.allow.length === 0 || policy.allow.some(isBroadBundleMcpPolicyName)
  );
}

function resolveAllowedBundleMcpCandidates(params: BundleMcpPolicyParams) {
  const { candidates, policies } = resolveBundleMcpPolicyContext(params);
  const specificCandidates = [...new Set(candidates)]
    .filter((toolName) => toolName.includes(TOOL_NAME_SEPARATOR))
    .filter((toolName) =>
      policies.every((policy) => isBundleMcpCandidateAllowedByPolicy(toolName, policy)),
    );
  return {
    allowsAll: policies.every(doesPolicyAllowAllBundleMcpTools),
    specificCandidates,
  };
}

export function collectSpecificBundleMcpServerAllowlist(
  params: BundleMcpPolicyParams,
): string[] | undefined {
  const { allowsAll, specificCandidates } = resolveAllowedBundleMcpCandidates(params);
  if (allowsAll) {
    return undefined;
  }
  const servers = new Set<string>();
  for (const toolName of specificCandidates) {
    const separatorIndex = toolName.indexOf(TOOL_NAME_SEPARATOR);
    if (separatorIndex > 0) {
      servers.add(toolName.slice(0, separatorIndex));
    }
  }
  return [...servers].sort();
}

function hasWildcardToolAllowlist(toolsAllow: string[]): boolean {
  return toolsAllow.some((entry) => normalizeToolName(entry) === "*");
}

/**
 * Applies a runtime allowlist to a concrete tool list after expanding tool and
 * plugin groups. Undefined allowlists keep all tools; an explicit empty list
 * intentionally disables all runtime tools.
 */
export function applyEmbeddedAttemptToolsAllow<T extends { name: string }>(
  tools: T[],
  toolsAllow?: string[],
  options?: {
    toolMeta?: (tool: T) => { pluginId: string } | undefined;
  },
): T[] {
  if (!toolsAllow) {
    return tools;
  }
  if (toolsAllow.length === 0) {
    return [];
  }
  if (hasWildcardToolAllowlist(toolsAllow)) {
    return tools;
  }
  const pluginGroups = options?.toolMeta
    ? buildPluginToolGroups({ tools, toolMeta: options.toolMeta })
    : undefined;
  const policy = pluginGroups
    ? expandPolicyWithPluginGroups({ allow: toolsAllow }, pluginGroups)
    : { allow: toolsAllow };
  return tools.filter((tool) => isToolAllowedByPolicyName(tool.name, policy));
}

/**
 * Adds the message tool to a narrowed allowlist when the caller must support
 * forced source-reply delivery. Wildcard and undefined allowlists already cover
 * message, while an empty allowlist becomes message-only.
 */
export function mergeForcedEmbeddedAttemptToolsAllow(
  toolsAllow: string[] | undefined,
  params: { forceMessageTool?: boolean },
): string[] | undefined {
  if (
    !params.forceMessageTool ||
    toolsAllow === undefined ||
    hasWildcardToolAllowlist(toolsAllow)
  ) {
    return toolsAllow;
  }
  if (toolsAllow.length === 0) {
    return ["message"];
  }
  const normalized = new Set(toolsAllow.map((entry) => normalizeToolName(entry)));
  return normalized.has("message") ? toolsAllow : [...toolsAllow, "message"];
}

function resolveCodingToolConstructionPlanForAllowlist(
  toolsAllow?: string[],
): OpenClawCodingToolConstructionPlan {
  if (!toolsAllow) {
    return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  if (toolsAllow.length === 0) {
    return cloneCodingToolConstructionPlan(NO_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  if (hasWildcardToolAllowlist(toolsAllow)) {
    return cloneCodingToolConstructionPlan(ALL_CODING_TOOL_CONSTRUCTION_PLAN);
  }
  const expanded = expandToolGroups(toolsAllow);
  const normalized = normalizeToolList(expanded);
  const coreFamilies = new Set<CoreToolFactoryFamily>();
  let includePluginTools = false;
  for (const name of normalized) {
    const family = resolveCoreToolFactoryFamily(name);
    if (family) {
      coreFamilies.add(family);
      continue;
    }
    // Plugin ids/tool names are not known to the local factory catalog.
    if (!isBundleMcpAllowlistName(name)) {
      includePluginTools = true;
    }
  }
  const includeBaseCodingTools = coreFamilies.has("base-coding");
  const includeShellTools = coreFamilies.has("shell");
  const includeOpenClawTools = coreFamilies.has("openclaw");
  // Channel delivery tools are constructed through plugin-capable runtime setup.
  const includeChannelTools = includePluginTools;

  return {
    includeBaseCodingTools,
    includeShellTools,
    includeChannelTools,
    includeOpenClawTools,
    includePluginTools,
  };
}

/**
 * Decides which tool families need to be constructed for an embedded attempt.
 * This keeps allowlisted plugin/channel tools available without forcing every
 * local core tool factory to run for narrow plugin-only configurations.
 */
export function resolveEmbeddedAttemptToolConstructionPlan(params: {
  disableTools?: boolean;
  isRawModelRun?: boolean;
  toolsEnabled?: boolean;
  toolsAllow?: string[];
  forceMessageTool?: boolean;
}): {
  constructTools: boolean;
  includeCoreTools: boolean;
  runtimeToolAllowlist?: string[];
  codingToolConstructionPlan: OpenClawCodingToolConstructionPlan;
} {
  // Model capability is authoritative: forced delivery cannot materialize a
  // tool the selected model cannot call.
  if (
    params.disableTools === true ||
    params.isRawModelRun === true ||
    params.toolsEnabled === false
  ) {
    return {
      constructTools: false,
      includeCoreTools: false,
      codingToolConstructionPlan: cloneCodingToolConstructionPlan(NO_CODING_TOOL_CONSTRUCTION_PLAN),
    };
  }
  const toolsAllow = mergeForcedEmbeddedAttemptToolsAllow(params.toolsAllow, {
    forceMessageTool: params.forceMessageTool,
  });
  const codingToolConstructionPlan = resolveCodingToolConstructionPlanForAllowlist(toolsAllow);
  const includeCoreTools =
    codingToolConstructionPlan.includeBaseCodingTools ||
    codingToolConstructionPlan.includeShellTools ||
    codingToolConstructionPlan.includeOpenClawTools;
  const constructTools =
    includeCoreTools ||
    codingToolConstructionPlan.includeChannelTools ||
    codingToolConstructionPlan.includePluginTools;

  return {
    constructTools,
    includeCoreTools,
    ...(toolsAllow ? { runtimeToolAllowlist: toolsAllow } : {}),
    codingToolConstructionPlan,
  };
}

function shouldCreateBundleRuntimeForAttempt(
  params: {
    toolsEnabled: boolean;
    disableTools?: boolean;
    toolsAllow?: string[];
  },
  matchesAllowlist: (normalizedToolName: string) => boolean,
): boolean {
  if (!params.toolsEnabled || params.disableTools === true) {
    return false;
  }
  if (!params.toolsAllow) {
    return true;
  }
  if (params.toolsAllow.length === 0) {
    return false;
  }
  if (hasWildcardToolAllowlist(params.toolsAllow)) {
    return true;
  }
  return params.toolsAllow.some((toolName) => matchesAllowlist(normalizeToolName(toolName)));
}

/**
 * Decides whether the bundled MCP runtime is needed for this attempt. Bundle
 * runtime creation follows explicit bundle/plugin allowlist names rather than
 * generic local tool names.
 */
export function shouldCreateBundleMcpRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
}): boolean {
  if (
    !shouldCreateBundleRuntimeForAttempt(params, (normalized) => {
      return isBundleMcpAllowlistName(normalized) || isPluginGroupAllowlistName(normalized);
    })
  ) {
    return false;
  }
  const { allowsAll, specificCandidates } = resolveAllowedBundleMcpCandidates(params);
  return allowsAll || specificCandidates.length > 0;
}

/**
 * Decides whether the bundled LSP runtime is needed for this attempt. LSP tools
 * are enabled by default/wildcard and by allowlist entries with the `lsp_`
 * prefix.
 */
export function shouldCreateBundleLspRuntimeForAttempt(params: {
  toolsEnabled: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
}): boolean {
  return shouldCreateBundleRuntimeForAttempt(params, (normalized) => {
    return normalized.startsWith("lsp_");
  });
}
