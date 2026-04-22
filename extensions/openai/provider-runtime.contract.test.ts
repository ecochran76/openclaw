// Openai tests cover provider runtime.contract plugin behavior.
import { describeOpenAIProviderRuntimeContract } from "openclaw/plugin-sdk/provider-test-contracts";
import { vi } from "vitest";

vi.mock("./openai-codex-provider.runtime.js", () => ({
  refreshOpenAICodexToken: vi.fn(async () => {
    throw new Error("Failed to extract accountId from token");
  }),
}));

describeOpenAIProviderRuntimeContract(() => import("./index.js"));
