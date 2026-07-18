/**
 * Detects providers whose model selections are backed by CLI runtimes.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackendDescriptor } from "../plugins/setup-registry.runtime.js";
import { normalizeProviderId } from "./model-selection-normalize.js";

function cliProviderCandidates(provider: string): string[] {
  const normalized = normalizeProviderId(provider);
  return normalized === "anthropic-cli" ? [normalized, "claude-cli"] : [normalized];
}

/** Return true when a provider id resolves to a configured or plugin CLI backend. */
export function isCliProvider(
  provider: string,
  cfg?: OpenClawConfig,
  opts: { allowPluginRuntime?: boolean } = {},
): boolean {
  const candidates = cliProviderCandidates(provider);
  const backends = cfg?.agents?.defaults?.cliBackends ?? {};
  if (Object.keys(backends).some((key) => candidates.includes(normalizeProviderId(key)))) {
    return true;
  }
  if (opts.allowPluginRuntime === false) {
    return false;
  }
  const cliBackends = resolveRuntimeCliBackends();
  if (cliBackends.some((backend) => candidates.includes(normalizeProviderId(backend.id)))) {
    return true;
  }
  if (
    candidates.some((candidate) =>
      resolvePluginSetupCliBackendDescriptor({ backend: candidate, config: cfg }),
    )
  ) {
    return true;
  }
  return false;
}
