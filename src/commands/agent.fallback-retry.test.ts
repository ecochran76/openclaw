import { describe, expect, it } from "vitest";
import { resolveFallbackRetryPrompt } from "./agent.js";

describe("resolveFallbackRetryPrompt", () => {
  it("keeps original body on first attempt", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "hello",
        isFallbackRetry: false,
      }),
    ).toBe("hello");
  });

  it("preserves original message for inter-session sessions_send retries", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "Reply with EXACTLY: RECEIVED handoff-123",
        isFallbackRetry: true,
        provenanceKind: "inter_session",
        sourceTool: "sessions_send",
      }),
    ).toBe("Reply with EXACTLY: RECEIVED handoff-123");
  });

  it("uses recovery prompt for non-inter-session retries", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "hello",
        isFallbackRetry: true,
      }),
    ).toBe("Continue where you left off. The previous model attempt failed or timed out.");
  });
});
