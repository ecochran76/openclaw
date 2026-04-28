import { describe, expect, it } from "vitest";
import { formatSlackSocketRuntimeDiagnostics } from "./socket-diagnostics.js";

describe("slack socket runtime diagnostics", () => {
  it("formats memory and uptime without event loop data", () => {
    expect(
      formatSlackSocketRuntimeDiagnostics({
        uptimeSeconds: 12.3,
        rssMb: 456.7,
        heapUsedMb: 89.1,
      }),
    ).toBe("uptime=12.3s rss=456.7MiB heap=89.1MiB");
  });

  it("formats recent event loop lag when sampled", () => {
    expect(
      formatSlackSocketRuntimeDiagnostics({
        uptimeSeconds: 12.3,
        rssMb: 456.7,
        heapUsedMb: 89.1,
        eventLoopLag: {
          meanMs: 2.1,
          p95Ms: 8.2,
          p99Ms: 15.3,
          maxMs: 21.4,
        },
      }),
    ).toBe(
      "uptime=12.3s rss=456.7MiB heap=89.1MiB eventLoopLagMs(mean=2.1,p95=8.2,p99=15.3,max=21.4)",
    );
  });
});
