// Vitest extension channels config wires the extension channels test shard.
import {
  extensionChannelOverrideExcludeGlobs,
  extensionChannelTestInclude,
} from "./vitest.channel-paths.mjs";
import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export function createExtensionChannelsVitestConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const config = createScopedVitestConfig(extensionChannelTestInclude, {
    dir: "extensions",
    env,
    exclude: extensionChannelOverrideExcludeGlobs,
    name: "extension-channels",
    // This shard loads the large bundled channel plugin graph in one
    // non-isolated run. Use forks to avoid Vitest worker-thread heap limits
    // during full-suite runs.
    pool: "forks",
    passWithNoTests: true,
  });
  config.test = {
    ...config.test,
    // Even with OPENCLAW_VITEST_MAX_WORKERS=1, one worker can accumulate the
    // entire Discord/Slack/Signal/iMessage/Line graph and OOM. Keep this shard
    // split across a small fixed worker pool so each process owns fewer files.
    maxWorkers: 4,
    fileParallelism: true,
  };
  return config;
}

export default createExtensionChannelsVitestConfig();
