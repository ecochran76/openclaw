// Model auth login profile tests cover login profile selection for provider auth.
import { describe, expect, it } from "vitest";
import { normalizeRequestedProfileId, resolveLoginProfiles } from "./auth.js";

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

describe("resolveLoginProfiles", () => {
  it("returns original profiles when --profile-id is not provided", () => {
    const profiles = [
      {
        profileId: "openai:default",
        credential: {
          type: "oauth" as const,
          provider: "openai",
          access: "a",
          refresh: "r",
          expires: Date.now() + 60_000,
        },
      },
    ];

    const resolved = resolveLoginProfiles({
      result: { profiles },
    });

    expect(resolved).toEqual(profiles);
  });

  it("overrides profile id when exactly one profile is returned", () => {
    const resolved = resolveLoginProfiles({
      requestedProfileId: "openai:work",
      result: {
        profiles: [
          {
            profileId: "openai:default",
            credential: {
              type: "oauth" as const,
              provider: "openai",
              access: "a",
              refresh: "r",
              expires: Date.now() + 60_000,
            },
          },
        ],
      },
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.profileId).toBe("openai:work");
  });

  it("throws when --profile-id is used with multi-profile auth responses", () => {
    expect(() =>
      resolveLoginProfiles({
        requestedProfileId: "provider:manual",
        result: {
          profiles: [
            {
              profileId: "provider:one",
              credential: { type: "api_key" as const, provider: "provider", key: "k1" },
            },
            {
              profileId: "provider:two",
              credential: { type: "api_key" as const, provider: "provider", key: "k2" },
            },
          ],
        },
      }),
    ).toThrow(/--profile-id requires exactly one returned auth profile/i);
  });
});
