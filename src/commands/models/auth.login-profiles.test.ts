import { describe, expect, it } from "vitest";
import { normalizeRequestedProfileId, resolveLoginProfiles } from "./auth.js";

describe("normalizeRequestedProfileId", () => {
  it("returns undefined when no profile id is provided", () => {
    expect(normalizeRequestedProfileId("openai-codex", undefined)).toBeUndefined();
    expect(normalizeRequestedProfileId("openai-codex", "   ")).toBeUndefined();
  });

  it("prefixes provider when bare profile label is passed", () => {
    expect(normalizeRequestedProfileId("openai-codex", "work")).toBe("openai-codex:work");
  });

  it("keeps explicit provider profile ids unchanged", () => {
    expect(normalizeRequestedProfileId("openai-codex", "openai-codex:work")).toBe(
      "openai-codex:work",
    );
  });
});

describe("resolveLoginProfiles", () => {
  it("returns original profiles when --profile-id is not provided", () => {
    const profiles = [
      {
        profileId: "openai-codex:default",
        credential: {
          type: "oauth" as const,
          provider: "openai-codex",
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
      requestedProfileId: "openai-codex:work",
      result: {
        profiles: [
          {
            profileId: "openai-codex:default",
            credential: {
              type: "oauth" as const,
              provider: "openai-codex",
              access: "a",
              refresh: "r",
              expires: Date.now() + 60_000,
            },
          },
        ],
      },
    });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.profileId).toBe("openai-codex:work");
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
