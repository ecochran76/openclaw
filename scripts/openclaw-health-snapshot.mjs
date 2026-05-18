#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 20_000;

function usage(exitCode = 0) {
  console.log(`Usage:
  openclaw-health-snapshot.mjs [--json] [options]

Options:
  --openclaw-bin <path>       OpenClaw CLI. Default: openclaw.
  --wake-script <path>        wake-trigger.mjs path. Default: installed script when present.
  --state-dir <dir>           Wake trigger state dir. Default: ~/.openclaw/wake-triggers.
  --gateway-timeout-ms <n>    Gateway command timeout. Default: 30000.
  --command-timeout-ms <n>    Other command timeout. Default: 20000.
  --skip-gateway              Skip gateway status probe.
  --skip-channels             Skip channels list probe.
  --skip-cron                 Skip cron list probe.
  --skip-wake                 Skip wake-trigger status probe.
  --skip-timers               Skip wake-trigger timer probe.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") {
      usage(0);
    }
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    if (
      ["json", "skip-gateway", "skip-channels", "skip-cron", "skip-wake", "skip-timers"].includes(
        key,
      )
    ) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function expandHome(value) {
  if (!value) {
    return value;
  }
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function resolvePath(value) {
  return resolve(expandHome(value));
}

function findWakeScript(args) {
  if (args["wake-script"]) {
    return resolvePath(args["wake-script"]);
  }
  const installed = resolvePath("~/.openclaw/workspace/scripts/wake-trigger.mjs");
  if (existsSync(installed)) {
    return installed;
  }
  return resolvePath("scripts/wake-trigger.mjs");
}

function intArg(args, key, defaultValue) {
  if (!args[key]) {
    return defaultValue;
  }
  const value = Number.parseInt(args[key], 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`invalid --${key}: ${args[key]}`);
  }
  return value;
}

function run(command, args, timeoutMs) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: "pipe",
    timeout: timeoutMs,
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  return {
    command: [command, ...args],
    startedAt,
    finishedAt: new Date().toISOString(),
    timeoutMs,
    status: timedOut ? null : result.status,
    signal: result.signal || null,
    timedOut,
    ok: !timedOut && result.status === 0,
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
    error: result.error && !timedOut ? result.error.message : "",
  };
}

function trimOutput(value) {
  return String(value || "").trim();
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function wakeSummary(result) {
  if (!result.ok) {
    return null;
  }
  const parsed = parseJson(result.stdout);
  if (!parsed) {
    return null;
  }
  const counts = parsed.counts || parsed;
  return {
    ok: parsed.ok === true,
    total: counts.total ?? 0,
    pending: counts.pending ?? 0,
    attention: counts.attention ?? 0,
    failed: counts.failed ?? counts.resumeFailed ?? 0,
    requiresHumanAck: counts.requiresHumanAck ?? 0,
    resumeExhausted: counts.resumeExhausted ?? counts.exhausted ?? 0,
    overdue: counts.overdue ?? counts.timeoutOverdue ?? 0,
    stale: counts.stale ?? 0,
  };
}

function cronSummary(result) {
  if (!result.ok) {
    return null;
  }
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const jobLines = lines.filter((line) => /^[0-9a-f-]{36}\s/.test(line));
  const errorLines = jobLines.filter((line) => /\s(error|failed)\s/i.test(` ${line} `));
  return {
    total: jobLines.length,
    errors: errorLines.length,
    ok: errorLines.length === 0,
  };
}

function statusLine(name, result, details = "") {
  if (result.skipped) {
    return `${name}: skipped`;
  }
  const status = result.ok ? "ok" : "fail";
  const code = result.timedOut ? "timeout" : result.status;
  const suffix = details ? ` ${details}` : "";
  return `${name}: ${status} status=${code}${suffix}`;
}

function buildSnapshot(args) {
  const openclawBin = args["openclaw-bin"] || "openclaw";
  const wakeScript = findWakeScript(args);
  const stateDir = resolvePath(args["state-dir"] || "~/.openclaw/wake-triggers");
  const commandTimeoutMs = intArg(args, "command-timeout-ms", DEFAULT_TIMEOUT_MS);
  const gatewayTimeoutMs = intArg(args, "gateway-timeout-ms", 30_000);
  const snapshot = {
    generatedAt: new Date().toISOString(),
    ok: true,
    commands: {},
    wakeSummary: null,
  };

  if (args["skip-gateway"]) {
    snapshot.commands.gateway = { skipped: true, ok: true };
  } else {
    snapshot.commands.gateway = run(
      openclawBin,
      ["gateway", "status", "--deep", "--require-rpc"],
      gatewayTimeoutMs,
    );
  }

  if (args["skip-channels"]) {
    snapshot.commands.channels = { skipped: true, ok: true };
  } else {
    snapshot.commands.channels = run(openclawBin, ["channels", "list"], commandTimeoutMs);
  }

  if (args["skip-cron"]) {
    snapshot.commands.cron = { skipped: true, ok: true };
  } else {
    snapshot.commands.cron = run(openclawBin, ["cron", "list"], commandTimeoutMs);
    snapshot.cronSummary = cronSummary(snapshot.commands.cron);
    if (snapshot.cronSummary && !snapshot.cronSummary.ok) {
      snapshot.commands.cron.ok = false;
    }
  }

  if (args["skip-wake"]) {
    snapshot.commands.wakeTriggers = { skipped: true, ok: true };
  } else {
    snapshot.commands.wakeTriggers = run(
      process.execPath,
      [wakeScript, "status", "--state-dir", stateDir, "--json"],
      commandTimeoutMs,
    );
    snapshot.wakeSummary = wakeSummary(snapshot.commands.wakeTriggers);
    if (snapshot.wakeSummary && !snapshot.wakeSummary.ok) {
      snapshot.commands.wakeTriggers.ok = false;
    }
  }

  if (args["skip-timers"]) {
    snapshot.commands.wakeTimers = { skipped: true, ok: true };
  } else {
    snapshot.commands.wakeTimers = run(
      "systemctl",
      ["--user", "list-timers", "openclaw-wake-trigger-*", "--all", "--no-pager"],
      commandTimeoutMs,
    );
  }

  snapshot.ok = Object.values(snapshot.commands).every((result) => result.ok === true);
  return snapshot;
}

function printText(snapshot) {
  console.log(`openclaw health snapshot: ${snapshot.ok ? "ok" : "attention"}`);
  console.log(statusLine("gateway", snapshot.commands.gateway));
  console.log(statusLine("channels", snapshot.commands.channels));
  const cron = snapshot.cronSummary;
  const cronDetails = cron ? `jobs=${cron.total} errors=${cron.errors}` : "";
  console.log(statusLine("cron", snapshot.commands.cron, cronDetails));
  const wake = snapshot.wakeSummary;
  const wakeDetails = wake
    ? `total=${wake.total} pending=${wake.pending} attention=${wake.attention}`
    : "";
  console.log(statusLine("wakeTriggers", snapshot.commands.wakeTriggers, wakeDetails));
  console.log(statusLine("wakeTimers", snapshot.commands.wakeTimers));
}

try {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = buildSnapshot(args);
  if (args.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    printText(snapshot);
  }
  process.exit(snapshot.ok ? 0 : 1);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
