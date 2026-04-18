import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureAuthProfileStore = vi.hoisted(() => vi.fn());
const resolveAuthProfileOrder = vi.hoisted(() => vi.fn());
const resolveAuthProfileDisplayLabel = vi.hoisted(() => vi.fn());
const resolveMainAgentDir = vi.hoisted(() => vi.fn());
const loadPersistedAuthProfileState = vi.hoisted(() => vi.fn());
const resolveModelAuthLabel = vi.hoisted(() => vi.fn());

vi.mock("../agents/auth-profiles/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles/store.js")>()),
  ensureAuthProfileStore,
}));

vi.mock("../agents/auth-profiles/display.js", () => ({
  resolveAuthProfileDisplayLabel,
}));

vi.mock("../agents/auth-profiles/order.js", () => ({
  resolveAuthProfileOrder,
}));

vi.mock("../agents/auth-profiles/paths.js", () => ({
  resolveMainAgentDir,
}));

vi.mock("../agents/auth-profiles/state.js", () => ({
  loadPersistedAuthProfileState,
}));

vi.mock("../agents/model-auth-label.js", () => ({
  resolveModelAuthLabel,
}));

describe("resolveStatusModelAuthLabel", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    resolveModelAuthLabel.mockReturnValue("oauth (openai:pcg)");
    ensureAuthProfileStore.mockReturnValue({
      profiles: {
        "openai:pcg": {
          provider: "openai",
          type: "oauth",
        },
      },
    });
    resolveAuthProfileOrder.mockReturnValue(["openai:pcg", "openai:soylei"]);
    resolveAuthProfileDisplayLabel.mockImplementation(({ profileId }) => profileId);
    resolveMainAgentDir.mockReturnValue("/main-agent");
    loadPersistedAuthProfileState.mockImplementation((agentDir?: string) =>
      agentDir === "/ops-agent"
        ? {
            order: { openai: ["openai:pcg"] },
            lastGood: { openai: "openai:ecochran76" },
          }
        : {
            lastGood: { openai: "openai:soylei" },
          },
    );
  });

  it("surfaces agent-local auth order drift from main", async () => {
    const { resolveStatusModelAuthLabel } = await import("./status-text.js");
    expect(
      resolveStatusModelAuthLabel({
        provider: "openai",
        acceptedProviderIds: ["openai", "openai-codex"],
        cfg: {
          auth: {
            order: {
              openai: ["openai:soylei"],
            },
          },
        },
        agentDir: "/ops-agent",
      }),
    ).toBe(
      "oauth (openai:pcg) · agent order prefers openai:pcg; main last-good openai:soylei",
    );
  });

  it("omits the drift note for the main agent", async () => {
    const { resolveStatusModelAuthLabel } = await import("./status-text.js");
    expect(
      resolveStatusModelAuthLabel({
        provider: "openai",
        cfg: {},
        agentDir: "/main-agent",
      }),
    ).toBe("oauth (openai:pcg)");
  });
});
