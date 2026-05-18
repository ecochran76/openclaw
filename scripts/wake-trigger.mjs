#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const VERSION = 1;
const TERMINAL_STATES = new Set([
  "delivered_success",
  "delivered_failure",
  "delivered_timeout",
  "cancelled",
  "resume_exhausted",
]);

function usage(exitCode = 0) {
  const text = `Usage:
  wake-trigger.mjs set --name <name> --agent <id> --session-key <key> [options]
  wake-trigger.mjs check [--dry-run] [--state-dir <dir>]
  wake-trigger.mjs list [--state-dir <dir>] [--json]
  wake-trigger.mjs show --id <id> [--state-dir <dir>]
  wake-trigger.mjs rm --id <id> [--state-dir <dir>]

Set options:
  --success-cmd <cmd>       Shell predicate that exits 0 on success.
  --failure-cmd <cmd>       Shell predicate that exits 0 on failure.
  --timeout-minutes <n>     Fire timeout after n minutes. Default: 60.
  --max-attempts <n>        Max resume attempts after a terminal condition. Default: 1.
  --cooldown-seconds <n>    Delay before retrying failed resume. Default: 300.
  --on-success <text>       Resume prompt for success.
  --on-failure <text>       Resume prompt for failure.
  --on-timeout <text>       Resume prompt for timeout.
  --openclaw-bin <path>     OpenClaw CLI. Default: openclaw.
  --reply-channel <name>    Optional delivery channel, for example slack.
  --reply-account <id>      Optional delivery account id.
  --reply-to <target>       Optional delivery target.
  --deliver                 Pass --deliver to openclaw agent when resuming.
  --state-dir <dir>         Default: ~/.openclaw/wake-triggers
`;
  console.log(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (["deliver", "dry-run", "json"].includes(key)) {
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
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function stateDir(args) {
  return resolve(expandHome(args["state-dir"] || "~/.openclaw/wake-triggers"));
}

function ensureStateDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function readRecord(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeRecord(dir, record) {
  ensureStateDir(dir);
  const path = join(dir, `${record.id}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

function recordPaths(dir) {
  ensureStateDir(dir);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"))
    .map((name) => join(dir, name));
}

function requireString(args, key) {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`--${key} is required`);
  }
  return value.trim();
}

function readInt(args, key, fallback, min) {
  const raw = args[key];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`--${key} must be an integer >= ${min}`);
  }
  return value;
}

function commandPassed(command) {
  if (!command) return false;
  const result = spawnSync(command, {
    shell: true,
    stdio: "ignore",
    timeout: 30_000,
  });
  return result.status === 0;
}

function classify(record, nowMs) {
  if (TERMINAL_STATES.has(record.state)) {
    return null;
  }
  if (record.state === "resume_failed") {
    const nextEligible = Date.parse(
      record.nextEligibleAt || record.updatedAt || record.createdAt || 0,
    );
    if (Number.isFinite(nextEligible) && nowMs < nextEligible) {
      return null;
    }
    return record.lastFireReason || "timeout";
  }
  if (commandPassed(record.failureCmd)) return "failure";
  if (commandPassed(record.successCmd)) return "success";
  const timeoutAt = Date.parse(record.timeoutAt);
  if (Number.isFinite(timeoutAt) && nowMs >= timeoutAt) return "timeout";
  return null;
}

function resumePrompt(record, reason) {
  const configured = {
    success: record.onSuccess,
    failure: record.onFailure,
    timeout: record.onTimeout,
  }[reason];
  if (configured) return configured;
  return `Wake trigger "${record.name}" fired with reason=${reason}. Continue the prior task in this session and report current state.`;
}

function resumeArgs(record, reason) {
  const args = [
    "agent",
    "--agent",
    record.agent,
    "--session-key",
    record.sessionKey,
    "--message",
    resumePrompt(record, reason),
  ];
  if (record.deliver) args.push("--deliver");
  if (record.replyChannel) args.push("--reply-channel", record.replyChannel);
  if (record.replyAccount) args.push("--reply-account", record.replyAccount);
  if (record.replyTo) args.push("--reply-to", record.replyTo);
  if (record.timeoutSeconds) args.push("--timeout", String(record.timeoutSeconds));
  return args;
}

function setCommand(args) {
  const dir = stateDir(args);
  const timeoutMinutes = readInt(args, "timeout-minutes", 60, 1);
  const maxAttempts = readInt(args, "max-attempts", 1, 1);
  const cooldownSeconds = readInt(args, "cooldown-seconds", 300, 1);
  const createdAt = nowIso();
  const id = args.id || `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const record = {
    schema: "openclaw.wake_trigger.v1",
    version: VERSION,
    id,
    name: requireString(args, "name"),
    agent: requireString(args, "agent"),
    sessionKey: requireString(args, "session-key"),
    state: "pending",
    successCmd: args["success-cmd"] || "",
    failureCmd: args["failure-cmd"] || "",
    onSuccess: args["on-success"] || "",
    onFailure: args["on-failure"] || "",
    onTimeout: args["on-timeout"] || "",
    openclawBin: args["openclaw-bin"] || "openclaw",
    deliver: Boolean(args.deliver),
    replyChannel: args["reply-channel"] || "",
    replyAccount: args["reply-account"] || "",
    replyTo: args["reply-to"] || "",
    timeoutSeconds: readInt(args, "agent-timeout-seconds", 600, 1),
    maxAttempts,
    attempts: 0,
    cooldownSeconds,
    createdAt,
    updatedAt: createdAt,
    timeoutAt: new Date(Date.parse(createdAt) + timeoutMinutes * 60_000).toISOString(),
    lastFireReason: "",
    lastResumeExitCode: null,
    lastResumeError: "",
    nextEligibleAt: "",
  };
  if (!record.successCmd && !record.failureCmd) {
    throw new Error("at least one of --success-cmd or --failure-cmd is required");
  }
  const path = writeRecord(dir, record);
  console.log(
    JSON.stringify({ ok: true, id: record.id, path, timeoutAt: record.timeoutAt }, null, 2),
  );
}

function listCommand(args) {
  const dir = stateDir(args);
  const rows = recordPaths(dir).map((path) => readRecord(path));
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const row of rows) {
    console.log(`${row.id}\t${row.state}\t${row.name}\t${row.agent}\t${row.updatedAt}`);
  }
}

function showCommand(args) {
  const dir = stateDir(args);
  const id = requireString(args, "id");
  const path = join(dir, `${basename(id, ".json")}.json`);
  console.log(JSON.stringify(readRecord(path), null, 2));
}

function rmCommand(args) {
  const dir = stateDir(args);
  const id = requireString(args, "id");
  const path = join(dir, `${basename(id, ".json")}.json`);
  const record = readRecord(path);
  record.state = "cancelled";
  record.updatedAt = nowIso();
  writeRecord(dir, record);
  unlinkSync(path);
  console.log(JSON.stringify({ ok: true, removed: id }, null, 2));
}

function checkOne(dir, record, args) {
  const nowMs = Date.now();
  const reason = classify(record, nowMs);
  if (!reason) return { id: record.id, state: record.state, action: "none" };
  if (args["dry-run"]) {
    return {
      id: record.id,
      state: record.state,
      action: "dry-run",
      reason,
      args: resumeArgs(record, reason),
    };
  }
  if (record.attempts >= record.maxAttempts) {
    record.state = "resume_exhausted";
    record.updatedAt = nowIso();
    record.lastFireReason = reason;
    writeRecord(dir, record);
    return { id: record.id, state: record.state, action: "exhausted", reason };
  }
  record.attempts += 1;
  record.lastFireReason = reason;
  record.updatedAt = nowIso();
  const result = spawnSync(record.openclawBin || "openclaw", resumeArgs(record, reason), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: (record.timeoutSeconds || 600) * 1000,
  });
  record.lastResumeExitCode = result.status;
  record.lastResumeError = result.stderr?.slice(0, 4000) || "";
  if (result.status === 0) {
    record.state = `delivered_${reason}`;
    record.deliveredAt = nowIso();
  } else {
    record.state = "resume_failed";
    record.nextEligibleAt = new Date(
      Date.now() + (record.cooldownSeconds || 300) * 1000,
    ).toISOString();
  }
  record.updatedAt = nowIso();
  writeRecord(dir, record);
  return { id: record.id, state: record.state, action: "resume", reason, exitCode: result.status };
}

function checkCommand(args) {
  const dir = stateDir(args);
  const results = recordPaths(dir).map((path) => checkOne(dir, readRecord(path), args));
  console.log(JSON.stringify({ ok: true, checked: results.length, results }, null, 2));
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") usage(0);
  const args = parseArgs(rest);
  switch (command) {
    case "set":
      setCommand(args);
      break;
    case "list":
      listCommand(args);
      break;
    case "show":
      showCommand(args);
      break;
    case "rm":
      rmCommand(args);
      break;
    case "check":
      checkCommand(args);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
