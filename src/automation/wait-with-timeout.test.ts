import { describe, expect, it, vi } from "vitest";
import { waitWithTimeout } from "./wait-with-timeout.js";

describe("waitWithTimeout", () => {
  it("chunks delays beyond Node's maximum timer range", async () => {
    vi.useFakeTimers();
    try {
      const timeoutMs = 2_147_483_647 + 10_000;
      const result = waitWithTimeout({
        work: new Promise<never>(() => undefined),
        timeoutMs,
        createError: () => new Error("timed out"),
      });
      const rejection = expect(result).rejects.toThrow("timed out");

      await vi.advanceTimersByTimeAsync(2_147_483_647);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
