import { describe, expect, it } from "vitest";
import { normalizeRequestedProfileId, resolveAuthProfileProviderId } from "./profile-id.js";

describe("normalizeRequestedProfileId", () => {
  it("returns undefined when no profile id is provided", () => {
    expect(normalizeRequestedProfileId("openai", undefined)).toBeUndefined();
    expect(normalizeRequestedProfileId("openai", "   ")).toBeUndefined();
  });

  it("prefixes provider when bare profile label is passed", () => {
    expect(normalizeRequestedProfileId("openai", "work")).toBe("openai:work");
  });

  it("keeps explicit provider profile ids unchanged", () => {
    expect(normalizeRequestedProfileId("openai", "openai:work")).toBe("openai:work");
  });
});

describe("resolveAuthProfileProviderId", () => {
  it("extracts the provider prefix from a profile id", () => {
    expect(resolveAuthProfileProviderId("openai:dillan")).toBe("openai");
  });

  it("returns undefined when the profile id is missing or bare", () => {
    expect(resolveAuthProfileProviderId(undefined)).toBeUndefined();
    expect(resolveAuthProfileProviderId("dillan")).toBeUndefined();
  });
});
