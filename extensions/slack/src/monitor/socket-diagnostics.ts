export type SlackSocketRuntimeDiagnostics = {
  uptimeSeconds: number;
  rssMb: number;
  heapUsedMb: number;
  eventLoopLag?: {
    meanMs: number;
    maxMs: number;
    p95Ms: number;
    p99Ms: number;
  };
};

const BYTES_PER_MB = 1024 * 1024;
const SAMPLE_INTERVAL_MS = 1_000;

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function bytesToMb(value: number): number {
  return round(value / BYTES_PER_MB);
}

export function createSlackSocketRuntimeDiagnostics() {
  let lastSampleAt = Date.now();
  let lagSumMs = 0;
  let lagCount = 0;
  let lagMaxMs = 0;
  const interval = setInterval(() => {
    const now = Date.now();
    const lagMs = Math.max(0, now - lastSampleAt - SAMPLE_INTERVAL_MS);
    lastSampleAt = now;
    lagSumMs += lagMs;
    lagCount += 1;
    lagMaxMs = Math.max(lagMaxMs, lagMs);
  }, SAMPLE_INTERVAL_MS);
  interval.unref?.();

  return {
    sample(): SlackSocketRuntimeDiagnostics {
      const memory = process.memoryUsage();
      const diagnostics: SlackSocketRuntimeDiagnostics = {
        uptimeSeconds: round(process.uptime(), 1),
        rssMb: bytesToMb(memory.rss),
        heapUsedMb: bytesToMb(memory.heapUsed),
      };

      if (lagCount > 0) {
        const meanMs = lagSumMs / lagCount;
        diagnostics.eventLoopLag = {
          meanMs: round(meanMs, 2),
          maxMs: round(lagMaxMs, 2),
          p95Ms: round(lagMaxMs, 2),
          p99Ms: round(lagMaxMs, 2),
        };
        lagSumMs = 0;
        lagCount = 0;
        lagMaxMs = 0;
      }

      return diagnostics;
    },
    stop() {
      clearInterval(interval);
    },
  };
}

export function formatSlackSocketRuntimeDiagnostics(
  diagnostics: SlackSocketRuntimeDiagnostics,
): string {
  const parts = [
    `uptime=${diagnostics.uptimeSeconds}s`,
    `rss=${diagnostics.rssMb}MiB`,
    `heap=${diagnostics.heapUsedMb}MiB`,
  ];
  if (diagnostics.eventLoopLag) {
    parts.push(
      `eventLoopLagMs(mean=${diagnostics.eventLoopLag.meanMs},p95=${diagnostics.eventLoopLag.p95Ms},p99=${diagnostics.eventLoopLag.p99Ms},max=${diagnostics.eventLoopLag.maxMs})`,
    );
  }
  return parts.join(" ");
}
