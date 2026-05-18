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
const CONFIG_FILE = "_config.json";
const SESSIONS_FILE = "_sessions.json";
const DEFAULTS = {
  timeoutMinutes: 60,
  maxAttempts: 1,
  maxAutomatedResumes: 1,
  cooldownSeconds: 300,
  timeoutSeconds: 600,
};
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
  wake-trigger.mjs ack --session-key <key> [--state-dir <dir>]
  wake-trigger.mjs defaults show [--state-dir <dir>] [--session-key <key>]
  wake-trigger.mjs defaults set [--scope global|session] [--session-key <key>] [limit options]

Set options:
  --success-cmd <cmd>       Shell predicate that exits 0 on success.
  --failure-cmd <cmd>       Shell predicate that exits 0 on failure.
  --timeout-minutes <n>     Fire timeout after n minutes. Default: 60.
  --max-attempts <n>        Max resume attempts after a terminal condition. Default: 1.
  --max-automated-resumes <n>
                            Max automatic wake resumes per session before human ack. Default: 1.
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

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return fallback;
  }
}

function writeJson(path, value) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function configPath(dir) {
  return join(dir, CONFIG_FILE);
}

function sessionsPath(dir) {
  return join(dir, SESSIONS_FILE);
}

function loadConfig(dir) {
  ensureStateDir(dir);
  const config = readJson(configPath(dir), {
    schema: "openclaw.wake_trigger.config.v1",
    global: {},
    sessions: {},
  });
  config.global ||= {};
  config.sessions ||= {};
  return config;
}

function saveConfig(dir, config) {
  ensureStateDir(dir);
  config.schema = "openclaw.wake_trigger.config.v1";
  config.updatedAt = nowIso();
  writeJson(configPath(dir), config);
}

function loadSessions(dir) {
  ensureStateDir(dir);
  const sessions = readJson(sessionsPath(dir), {
    schema: "openclaw.wake_trigger.sessions.v1",
    sessions: {},
  });
  sessions.sessions ||= {};
  return sessions;
}

function saveSessions(dir, sessions) {
  ensureStateDir(dir);
  sessions.schema = "openclaw.wake_trigger.sessions.v1";
  sessions.updatedAt = nowIso();
  writeJson(sessionsPath(dir), sessions);
}

function recordPaths(dir) {
  ensureStateDir(dir);
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".tmp") && !name.startsWith("_"))
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

function readOptionalInt(args, key, min) {
  const raw = args[key];
  if (raw === undefined) return undefined;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`--${key} must be an integer >= ${min}`);
  }
  return value;
}

function normalizeLimitKey(key) {
  return key.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function effectiveDefaults(dir, sessionKey = "") {
  const config = loadConfig(dir);
  return {
    ...DEFAULTS,
    ...config.global,
    ...(sessionKey && config.sessions[sessionKey] ? config.sessions[sessionKey] : {}),
  };
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
  if (record.state === "requires_human_ack") {
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
  const sessionKey = requireString(args, "session-key");
  const defaults = effectiveDefaults(dir, sessionKey);
  const timeoutMinutes = readInt(args, "timeout-minutes", defaults.timeoutMinutes, 1);
  const maxAttempts = readInt(args, "max-attempts", defaults.maxAttempts, 1);
  const maxAutomatedResumes = readInt(
    args,
    "max-automated-resumes",
    defaults.maxAutomatedResumes,
    0,
  );
  const cooldownSeconds = readInt(args, "cooldown-seconds", defaults.cooldownSeconds, 1);
  const createdAt = nowIso();
  const id = args.id || `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const record = {
    schema: "openclaw.wake_trigger.v1",
    version: VERSION,
    id,
    name: requireString(args, "name"),
    agent: requireString(args, "agent"),
    sessionKey,
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
    timeoutSeconds: readInt(args, "agent-timeout-seconds", defaults.timeoutSeconds, 1),
    maxAttempts,
    maxAutomatedResumes,
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
  const sessions = loadSessions(dir);
  const sessionState = sessions.sessions[record.sessionKey] || {
    automatedResumes: 0,
    humanAckCount: 0,
  };
  const maxAutomatedResumes =
    typeof record.maxAutomatedResumes === "number"
      ? record.maxAutomatedResumes
      : effectiveDefaults(dir, record.sessionKey).maxAutomatedResumes;
  if (sessionState.automatedResumes >= maxAutomatedResumes) {
    if (args["dry-run"]) {
      return {
        id: record.id,
        state: record.state,
        action: "would-require-human-ack",
        reason,
        maxAutomatedResumes,
      };
    }
    record.state = "requires_human_ack";
    record.updatedAt = nowIso();
    record.lastFireReason = reason;
    record.humanAckRequiredAt = record.updatedAt;
    record.humanAckReason = `maxAutomatedResumes ${maxAutomatedResumes} reached for session`;
    writeRecord(dir, record);
    return {
      id: record.id,
      state: record.state,
      action: "requires-human-ack",
      reason,
      maxAutomatedResumes,
    };
  }
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
    sessionState.automatedResumes += 1;
    sessionState.lastAutomatedResumeAt = record.deliveredAt;
    sessionState.lastTriggerId = record.id;
    sessions.sessions[record.sessionKey] = sessionState;
    saveSessions(dir, sessions);
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

function ackCommand(args) {
  const dir = stateDir(args);
  const sessionKey = requireString(args, "session-key");
  const sessions = loadSessions(dir);
  const current = sessions.sessions[sessionKey] || {};
  sessions.sessions[sessionKey] = {
    ...current,
    automatedResumes: 0,
    humanAckCount: Number(current.humanAckCount || 0) + 1,
    lastHumanAckAt: nowIso(),
  };
  let rearmed = 0;
  for (const path of recordPaths(dir)) {
    const record = readRecord(path);
    if (record.sessionKey === sessionKey && record.state === "requires_human_ack") {
      record.state = "pending";
      record.updatedAt = nowIso();
      record.humanAckedAt = record.updatedAt;
      writeRecord(dir, record);
      rearmed += 1;
    }
  }
  saveSessions(dir, sessions);
  console.log(JSON.stringify({ ok: true, sessionKey, rearmed }, null, 2));
}

function limitUpdateFromArgs(args) {
  const updates = {};
  for (const key of [
    "timeout-minutes",
    "max-attempts",
    "max-automated-resumes",
    "cooldown-seconds",
    "agent-timeout-seconds",
  ]) {
    const value = readOptionalInt(args, key, key === "max-automated-resumes" ? 0 : 1);
    if (value !== undefined) {
      const normalized =
        key === "agent-timeout-seconds" ? "timeoutSeconds" : normalizeLimitKey(key);
      updates[normalized] = value;
    }
  }
  return updates;
}

function defaultsCommand(args) {
  const subcommand = args._[0] || "show";
  const dir = stateDir(args);
  const config = loadConfig(dir);
  if (subcommand === "show") {
    const sessionKey = args["session-key"] || "";
    console.log(
      JSON.stringify(
        {
          ok: true,
          defaults: effectiveDefaults(dir, sessionKey),
          global: config.global,
          sessionKey,
          session: sessionKey ? config.sessions[sessionKey] || {} : undefined,
          path: configPath(dir),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (subcommand !== "set") {
    throw new Error(`unknown defaults subcommand: ${subcommand}`);
  }
  const scope = args.scope || "session";
  const updates = limitUpdateFromArgs(args);
  if (Object.keys(updates).length === 0) {
    throw new Error("defaults set requires at least one limit option");
  }
  if (scope === "global") {
    config.global = { ...config.global, ...updates };
  } else if (scope === "session") {
    const sessionKey = requireString(args, "session-key");
    config.sessions[sessionKey] = { ...(config.sessions[sessionKey] || {}), ...updates };
  } else {
    throw new Error("--scope must be global or session");
  }
  saveConfig(dir, config);
  console.log(JSON.stringify({ ok: true, scope, updates, path: configPath(dir) }, null, 2));
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
    case "ack":
      ackCommand(args);
      break;
    case "defaults":
      defaultsCommand(args);
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
