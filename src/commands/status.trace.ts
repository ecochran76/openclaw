const STATUS_TRACE_ENV = "OPENCLAW_STATUS_TRACE";

export function traceStatusPhase(phase: string): void {
  if (process.env[STATUS_TRACE_ENV] !== "1") {
    return;
  }
  process.stderr.write(`[status] ${new Date().toISOString()} ${phase}\n`);
}
