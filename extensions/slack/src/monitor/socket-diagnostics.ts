import { monitorEventLoopDelay } from "node:perf_hooks";

type EventLoopDelayMonitor = ReturnType<typeof monitorEventLoopDelay>;

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

const NS_PER_MS = 1_000_000;
const BYTES_PER_MB = 1024 * 1024;

function round(value: number, digits = 1): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function bytesToMb(value: number): number {
  return round(value / BYTES_PER_MB);
}

function nanosecondsToMs(value: number): number {
  return round(value / NS_PER_MS, 2);
}

export function createSlackSocketRuntimeDiagnostics() {
  let monitor: EventLoopDelayMonitor | undefined;
  try {
    monitor = monitorEventLoopDelay({ resolution: 20 });
    monitor.enable();
  } catch {
    monitor = undefined;
  }

  return {
    sample(): SlackSocketRuntimeDiagnostics {
      const memory = process.memoryUsage();
      const diagnostics: SlackSocketRuntimeDiagnostics = {
        uptimeSeconds: round(process.uptime(), 1),
        rssMb: bytesToMb(memory.rss),
        heapUsedMb: bytesToMb(memory.heapUsed),
      };

      if (monitor && monitor.max > 0) {
        diagnostics.eventLoopLag = {
          meanMs: nanosecondsToMs(Number.isFinite(monitor.mean) ? monitor.mean : 0),
          maxMs: nanosecondsToMs(monitor.max),
          p95Ms: nanosecondsToMs(monitor.percentile(95)),
          p99Ms: nanosecondsToMs(monitor.percentile(99)),
        };
        monitor.reset();
      }

      return diagnostics;
    },
    stop() {
      monitor?.disable();
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
