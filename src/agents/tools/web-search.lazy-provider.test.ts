import { describe, expect, it, vi } from "vitest";

const pluginRegistry = vi.hoisted(() => ({
  loadPluginRegistrySnapshotWithMetadata: vi.fn(() => ({
    source: "derived",
    snapshot: { plugins: [] },
    diagnostics: [],
  })),
  resolveManifestContractOwnerPluginId: vi.fn(() => undefined),
}));

vi.mock("../../plugins/plugin-registry.js", () => pluginRegistry);

describe("web_search provider resolution", () => {
  it("defers manifest-owner lookup until execution", async () => {
    const { createWebSearchTool } = await import("./web-search.js");

    const tool = createWebSearchTool({
      runtimeWebSearch: {
        providerConfigured: "custom",
        providerSource: "configured",
        selectedProvider: "custom",
        selectedProviderKeySource: "config",
        diagnostics: [],
      },
    });

    expect(tool?.name).toBe("web_search");
    expect(pluginRegistry.resolveManifestContractOwnerPluginId).not.toHaveBeenCalled();
  });
});
