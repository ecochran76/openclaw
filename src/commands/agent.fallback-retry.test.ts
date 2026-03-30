import { describe, expect, it } from "vitest";
import { resolveFallbackRetryPrompt } from "../agents/command/attempt-execution.helpers.js";

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
        sessionHasHistory: false,
      }),
    ).toBe("Reply with EXACTLY: RECEIVED handoff-123");
  });

  it("uses recovery prompt for non-inter-session retries", () => {
    expect(
      resolveFallbackRetryPrompt({
        body: "hello",
        isFallbackRetry: true,
        sessionHasHistory: true,
      }),
    ).toBe("[Retry after the previous model attempt failed or timed out]\n\nhello");
  });
});
