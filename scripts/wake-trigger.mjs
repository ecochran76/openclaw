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
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const VERSION = 1;
const CONFIG_FILE = "_config.json";
const SESSIONS_FILE = "_sessions.json";
const ALERTS_FILE = "_alerts.json";
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
  wake-trigger.mjs status [--state-dir <dir>] [--json] [--stale-minutes <n>]
  wake-trigger.mjs alert-slack [--state-dir <dir>] [--channel-id <id>] [--account <id>]
  wake-trigger.mjs show --id <id> [--state-dir <dir>]
  wake-trigger.mjs rm --id <id> [--state-dir <dir>]
  wake-trigger.mjs ack --session-key <key> [--state-dir <dir>]
  wake-trigger.mjs defaults show [--state-dir <dir>] [--session-key <key>]
  wake-trigger.mjs defaults set [--scope global|session] [--session-key <key>] [limit options]
  wake-trigger.mjs smoke-slack --agent <id> --channel-id <id> [--account <id>]

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
  --allow-non-agent-session-key
                            Allow a non-agent-prefixed session key. Avoid unless debugging.
  --reply-channel <name>    Optional delivery channel, for example slack.
  --reply-account <id>      Optional delivery account id.
  --reply-to <target>       Optional delivery target.
  --active-reaction <emoji> Optional reaction to set while the trigger is active.
  --reaction-message-id <id>
                            Message id/ts to react to while active.
  --reaction-target <target>
                            Reaction target/channel. Defaults to --reply-to.
  --reaction-channel <name> Reaction channel. Defaults to --reply-channel.
  --reaction-account <id>   Reaction account id. Defaults to --reply-account.
  --human-ack-reaction <emoji>
                            Optional reaction to set when human ack is required.
  --no-announce             Skip the best-effort thread acknowledgement when armed.
  --announce-message <text> Optional custom thread acknowledgement text.
  --env-file <path>        Optional env file for acknowledgement tokens.
                            Default: ~/credentials/API-keys.env when present.
  --deliver                 Pass --deliver to openclaw agent when resuming.
  --state-dir <dir>         Default: ~/.openclaw/wake-triggers

Status options:
  --stale-minutes <n>       Mark non-terminal records stale after n minutes. Default: 15.

Alert options:
  --channel-id <id>         Slack alert channel id. Default: oc-main-agent C0AHQQCG7J4.
  --account <id>            Slack account id. Default: default.
  --cooldown-minutes <n>    Suppress repeated identical alerts for n minutes. Default: 30.
  --force                   Send alert even if cooldown/signature would suppress it.

Smoke options:
  --agent <id>              Agent to resume.
  --channel-id <id>         Slack channel id for the disposable smoke.
  --account <id>            Slack account id. Default: soylei.
  --wait-seconds <n>        Max seconds to wait for systemd checker. Default: 210.
  --keep-record             Keep the delivered smoke record instead of removing it.
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
    if (
      [
        "deliver",
        "dry-run",
        "json",
        "no-announce",
        "allow-non-agent-session-key",
        "keep-record",
        "force",
      ].includes(key)
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

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function configPath(dir) {
  return join(dir, CONFIG_FILE);
}

function sessionsPath(dir) {
  return join(dir, SESSIONS_FILE);
}

function alertsPath(dir) {
  return join(dir, ALERTS_FILE);
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

function loadAlerts(dir) {
  ensureStateDir(dir);
  const alerts = readJson(alertsPath(dir), {
    schema: "openclaw.wake_trigger.alerts.v1",
    slack: {},
  });
  alerts.slack ||= {};
  return alerts;
}

function saveAlerts(dir, alerts) {
  ensureStateDir(dir);
  alerts.schema = "openclaw.wake_trigger.alerts.v1";
  alerts.updatedAt = nowIso();
  writeJson(alertsPath(dir), alerts);
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
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`--${key} must be an integer >= ${min}`);
  }
  return value;
}

function readOptionalInt(args, key, min) {
  const raw = args[key];
  if (raw === undefined) {
    return undefined;
  }
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

function normalizeComparableAgentId(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function validateSessionKeyForAgent(sessionKey, agent, args) {
  const match = /^agent:([^:]+):/.exec(sessionKey);
  if (!match) {
    if (args["allow-non-agent-session-key"]) {
      return;
    }
    throw new Error(
      `--session-key must start with agent:${agent}: so OpenClaw resumes the intended agent; got ${sessionKey}`,
    );
  }
  const sessionAgent = match[1];
  if (normalizeComparableAgentId(sessionAgent) !== normalizeComparableAgentId(agent)) {
    throw new Error(
      `--agent (${agent}) must match --session-key agent (${sessionAgent}); use agent:${agent}:...`,
    );
  }
}

function commandPassed(command) {
  if (!command) {
    return false;
  }
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
  if (commandPassed(record.failureCmd)) {
    return "failure";
  }
  if (commandPassed(record.successCmd)) {
    return "success";
  }
  const timeoutAt = Date.parse(record.timeoutAt);
  if (Number.isFinite(timeoutAt) && nowMs >= timeoutAt) {
    return "timeout";
  }
  return null;
}

function resumePrompt(record, reason) {
  const configured = {
    success: record.onSuccess,
    failure: record.onFailure,
    timeout: record.onTimeout,
  }[reason];
  if (configured) {
    return configured;
  }
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
  if (record.deliver) {
    args.push("--deliver");
  }
  if (record.replyChannel) {
    args.push("--reply-channel", record.replyChannel);
  }
  if (record.replyAccount) {
    args.push("--reply-account", record.replyAccount);
  }
  if (record.replyTo) {
    args.push("--reply-to", record.replyTo);
  }
  if (record.timeoutSeconds) {
    args.push("--timeout", String(record.timeoutSeconds));
  }
  return args;
}

function reactionArgs(record, emoji, remove = false) {
  const args = [
    "message",
    "react",
    "--channel",
    record.reactionChannel || record.replyChannel,
    "--target",
    record.reactionTarget || record.replyTo,
    "--message-id",
    record.reactionMessageId,
    "--emoji",
    emoji,
    "--json",
  ];
  if (record.reactionAccount || record.replyAccount) {
    args.push("--account", record.reactionAccount || record.replyAccount);
  }
  if (remove) {
    args.push("--remove");
  }
  return args;
}

function canReact(record, emoji) {
  return Boolean(
    emoji &&
    record.reactionMessageId &&
    (record.reactionChannel || record.replyChannel) &&
    (record.reactionTarget || record.replyTo),
  );
}

function applyReaction(record, emoji, remove = false) {
  if (!canReact(record, emoji)) {
    return false;
  }
  const result = spawnSync(record.openclawBin || "openclaw", reactionArgs(record, emoji, remove), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  record.lastReactionAt = nowIso();
  record.lastReactionExitCode = result.status;
  record.lastReactionError = result.stderr?.slice(0, 2000) || "";
  if (result.status === 0) {
    if (remove) {
      if (emoji === record.activeReaction) {
        record.activeReactionState = "removed";
      }
      if (emoji === record.humanAckReaction) {
        record.humanAckReactionState = "removed";
      }
    } else {
      if (emoji === record.activeReaction) {
        record.activeReactionState = "set";
      }
      if (emoji === record.humanAckReaction) {
        record.humanAckReactionState = "set";
      }
    }
    return true;
  }
  if (emoji === record.activeReaction) {
    record.activeReactionState = remove ? "remove_failed" : "set_failed";
  }
  if (emoji === record.humanAckReaction) {
    record.humanAckReactionState = remove ? "remove_failed" : "set_failed";
  }
  return false;
}

function clearActiveReaction(record) {
  if (record.activeReactionState === "set") {
    applyReaction(record, record.activeReaction, true);
  }
}

function envNameForSlackToken(accountId) {
  const suffix = String(accountId || "")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return suffix ? `SLACK_BOT_TOKEN_${suffix}` : "SLACK_BOT_TOKEN";
}

function loadEnvFileIfPresent(path) {
  if (!path) {
    return;
  }
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) {
      continue;
    }
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function slackApiCall(method, payload, token) {
  return new Promise((resolvePromise) => {
    const body = JSON.stringify(payload);
    const req = httpsRequest(
      {
        hostname: "slack.com",
        path: `/api/${method}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolvePromise(JSON.parse(text));
          } catch {
            resolvePromise({ ok: false, error: `invalid_json_status_${res.statusCode}` });
          }
        });
      },
    );
    req.on("error", (error) => resolvePromise({ ok: false, error: error.message }));
    req.on("timeout", () => {
      req.destroy();
      resolvePromise({ ok: false, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}

function slackTokenForAccount(accountId, envFile) {
  const tokenEnv = envNameForSlackToken(accountId);
  loadEnvFileIfPresent(envFile);
  const token = process.env[tokenEnv] || process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error(`missing ${tokenEnv}`);
  }
  return token;
}

async function postSlackMessage({ channel, text, threadTs, accountId, envFile }) {
  const token = slackTokenForAccount(accountId, envFile);
  const payload = {
    channel,
    text,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  };
  const result = await slackApiCall("chat.postMessage", payload, token);
  if (!result.ok) {
    throw new Error(`Slack chat.postMessage failed: ${result.error || "unknown_error"}`);
  }
  return result;
}

async function getSlackReactions({ channel, ts, accountId, envFile }) {
  const token = slackTokenForAccount(accountId, envFile);
  const query = new URLSearchParams({ channel, timestamp: ts, full: "true" }).toString();
  const result = await new Promise((resolvePromise) => {
    const req = httpsRequest(
      {
        hostname: "slack.com",
        path: `/api/reactions.get?${query}`,
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolvePromise(JSON.parse(text));
          } catch {
            resolvePromise({ ok: false, error: `invalid_json_status_${res.statusCode}` });
          }
        });
      },
    );
    req.on("error", (error) => resolvePromise({ ok: false, error: error.message }));
    req.on("timeout", () => {
      req.destroy();
      resolvePromise({ ok: false, error: "timeout" });
    });
    req.end();
  });
  if (!result.ok) {
    throw new Error(`Slack reactions.get failed: ${result.error || "unknown_error"}`);
  }
  const reactions = Array.isArray(result.message?.reactions) ? result.message.reactions : [];
  return reactions.map((reaction) => ({
    name: String(reaction.name || ""),
    count: Number(reaction.count || 0),
  }));
}

function describePredicate(label, command) {
  return command ? `${label}: configured` : `${label}: not configured`;
}

function defaultAnnounceMessage(record) {
  const timeoutAt = record.timeoutAt || "unknown";
  const active = record.activeReaction ? `:${record.activeReaction}:` : "no reaction";
  return [
    `Wake trigger armed: ${record.name}`,
    `Watching for: ${describePredicate("success", record.successCmd)}; ${describePredicate(
      "failure",
      record.failureCmd,
    )}`,
    `Timeout: ${timeoutAt}`,
    `Limits: maxAttempts=${record.maxAttempts}, maxAutomatedResumes=${record.maxAutomatedResumes}`,
    `Active marker: ${active}`,
  ].join("\n");
}

async function announceTriggerArmed(record) {
  if (record.announce === false) {
    return false;
  }
  if ((record.replyChannel || record.reactionChannel) !== "slack") {
    return false;
  }
  const channel = record.reactionTarget || record.replyTo;
  const threadTs = record.reactionMessageId;
  if (!channel || !threadTs) {
    return false;
  }
  const accountId = record.reactionAccount || record.replyAccount || "";
  const tokenEnv = envNameForSlackToken(accountId);
  loadEnvFileIfPresent(record.envFile);
  const token = process.env[tokenEnv] || process.env.SLACK_BOT_TOKEN;
  if (!token) {
    record.announceState = "skipped";
    record.lastAnnounceError = `missing ${tokenEnv}`;
    return false;
  }
  const payload = {
    channel,
    thread_ts: threadTs,
    text: record.announceMessage || defaultAnnounceMessage(record),
  };
  const result = await slackApiCall("chat.postMessage", payload, token);
  record.lastAnnounceAt = nowIso();
  record.lastAnnounceError = result.ok ? "" : String(result.error || "unknown_error");
  record.announceState = result.ok ? "sent" : "failed";
  record.announceMessageTs = result.ok && result.ts ? String(result.ts) : "";
  return Boolean(result.ok);
}

async function setCommand(args) {
  const dir = stateDir(args);
  const sessionKey = requireString(args, "session-key");
  const agent = requireString(args, "agent");
  validateSessionKeyForAgent(sessionKey, agent, args);
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
    agent,
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
    activeReaction: args["active-reaction"] || "",
    reactionMessageId: args["reaction-message-id"] || "",
    reactionTarget: args["reaction-target"] || args["reply-to"] || "",
    reactionChannel: args["reaction-channel"] || args["reply-channel"] || "",
    reactionAccount: args["reaction-account"] || args["reply-account"] || "",
    activeReactionState: "",
    humanAckReaction: args["human-ack-reaction"] || "",
    humanAckReactionState: "",
    announce: !args["no-announce"],
    announceMessage: args["announce-message"] || "",
    envFile: expandHome(args["env-file"] || "~/credentials/API-keys.env"),
    announceState: "",
    announceMessageTs: "",
    lastAnnounceAt: "",
    lastAnnounceError: "",
    lastReactionAt: "",
    lastReactionExitCode: null,
    lastReactionError: "",
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
  if (record.activeReaction && !canReact(record, record.activeReaction)) {
    throw new Error(
      "--active-reaction requires --reaction-message-id plus reaction target/channel or reply target/channel",
    );
  }
  applyReaction(record, record.activeReaction, false);
  await announceTriggerArmed(record);
  const path = writeRecord(dir, record);
  const output = {
    ok: true,
    id: record.id,
    path,
    timeoutAt: record.timeoutAt,
    activeReactionState: record.activeReactionState,
    announceState: record.announceState,
    announceMessageTs: record.announceMessageTs,
  };
  if (!args.quiet) {
    console.log(JSON.stringify(output, null, 2));
  }
  return { record, path, output };
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

function ageMs(value, nowMs) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? nowMs - parsed : null;
}

function summarizeRecord(record, nowMs, staleMinutes) {
  const updatedAgeMs = ageMs(record.updatedAt || record.createdAt, nowMs);
  const timeoutAtMs = Date.parse(record.timeoutAt || "");
  const timeoutOverdue =
    record.state === "pending" && Number.isFinite(timeoutAtMs) && nowMs >= timeoutAtMs;
  const stale =
    !TERMINAL_STATES.has(record.state) &&
    record.state !== "requires_human_ack" &&
    updatedAgeMs !== null &&
    updatedAgeMs >= staleMinutes * 60_000;
  const attention =
    record.state === "resume_failed" ||
    record.state === "requires_human_ack" ||
    record.state === "resume_exhausted" ||
    timeoutOverdue ||
    stale;
  return {
    id: record.id,
    name: record.name,
    agent: record.agent,
    state: record.state,
    attention,
    stale,
    timeoutOverdue,
    updatedAt: record.updatedAt || "",
    timeoutAt: record.timeoutAt || "",
    lastFireReason: record.lastFireReason || "",
    lastResumeExitCode: record.lastResumeExitCode ?? null,
    lastResumeError: record.lastResumeError || "",
    nextEligibleAt: record.nextEligibleAt || "",
    humanAckReason: record.humanAckReason || "",
  };
}

function statusCommand(args) {
  const output = buildStatus(args);
  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(
    `wake-trigger status: ${output.ok ? "ok" : "attention"} total=${output.counts.total} attention=${output.counts.attention} pending=${output.counts.pending} failed=${output.counts.resumeFailed} humanAck=${output.counts.requiresHumanAck} stale=${output.counts.stale}`,
  );
  for (const record of output.records.filter((row) => row.attention)) {
    const reasons = [];
    if (record.state === "resume_failed") {
      reasons.push("resume_failed");
    }
    if (record.state === "requires_human_ack") {
      reasons.push("requires_human_ack");
    }
    if (record.state === "resume_exhausted") {
      reasons.push("resume_exhausted");
    }
    if (record.timeoutOverdue) {
      reasons.push("timeout_overdue");
    }
    if (record.stale) {
      reasons.push("stale");
    }
    console.log(`${record.id}\t${record.state}\t${record.agent}\t${reasons.join(",")}`);
  }
}

function buildStatus(args) {
  const dir = stateDir(args);
  const staleMinutes = readInt(args, "stale-minutes", 15, 1);
  const nowMs = Date.now();
  const records = recordPaths(dir).map((path) =>
    summarizeRecord(readRecord(path), nowMs, staleMinutes),
  );
  records.sort((a, b) => {
    if (a.attention !== b.attention) {
      return a.attention ? -1 : 1;
    }
    return String(a.updatedAt).localeCompare(String(b.updatedAt));
  });
  const counts = {
    total: records.length,
    attention: records.filter((record) => record.attention).length,
    pending: records.filter((record) => record.state === "pending").length,
    resumeFailed: records.filter((record) => record.state === "resume_failed").length,
    requiresHumanAck: records.filter((record) => record.state === "requires_human_ack").length,
    exhausted: records.filter((record) => record.state === "resume_exhausted").length,
    stale: records.filter((record) => record.stale).length,
    timeoutOverdue: records.filter((record) => record.timeoutOverdue).length,
  };
  const output = {
    ok: counts.attention === 0,
    stateDir: dir,
    staleMinutes,
    counts,
    records,
  };
  return output;
}

function attentionSignature(status) {
  return JSON.stringify(
    status.records
      .filter((record) => record.attention)
      .map((record) => ({
        id: record.id,
        state: record.state,
        stale: record.stale,
        timeoutOverdue: record.timeoutOverdue,
        lastResumeExitCode: record.lastResumeExitCode,
        lastResumeError: record.lastResumeError,
        humanAckReason: record.humanAckReason,
      })),
  );
}

function alertMessage(status) {
  const lines = [
    `:warning: OpenClaw wake-trigger attention needed`,
    `stateDir=${status.stateDir}`,
    `attention=${status.counts.attention} total=${status.counts.total} pending=${status.counts.pending} failed=${status.counts.resumeFailed} humanAck=${status.counts.requiresHumanAck} stale=${status.counts.stale} overdue=${status.counts.timeoutOverdue}`,
  ];
  for (const record of status.records.filter((row) => row.attention).slice(0, 8)) {
    const reasons = [];
    if (record.state === "resume_failed") {
      reasons.push("resume_failed");
    }
    if (record.state === "requires_human_ack") {
      reasons.push("requires_human_ack");
    }
    if (record.state === "resume_exhausted") {
      reasons.push("resume_exhausted");
    }
    if (record.timeoutOverdue) {
      reasons.push("timeout_overdue");
    }
    if (record.stale) {
      reasons.push("stale");
    }
    lines.push(
      `- ${record.id} agent=${record.agent} state=${record.state} reason=${reasons.join(",")}`,
    );
  }
  if (status.counts.attention > 8) {
    lines.push(`- ... ${status.counts.attention - 8} more`);
  }
  lines.push(`Run: node ~/.openclaw/workspace/scripts/wake-trigger.mjs status --json`);
  return lines.join("\n");
}

async function alertSlackCommand(args) {
  const dir = stateDir(args);
  const status = buildStatus(args);
  const channelId = args["channel-id"] || "C0AHQQCG7J4";
  const accountId = args.account || "default";
  const envFile = expandHome(args["env-file"] || "~/credentials/API-keys.env");
  const cooldownMinutes = readInt(args, "cooldown-minutes", 30, 1);
  const signature = attentionSignature(status);
  const alerts = loadAlerts(dir);
  const key = `${accountId}:${channelId}`;
  const last = alerts.slack[key] || {};
  const lastSentMs = Date.parse(last.sentAt || "");
  const cooldownActive =
    Number.isFinite(lastSentMs) && Date.now() - lastSentMs < cooldownMinutes * 60_000;
  if (status.ok) {
    alerts.slack[key] = {
      ...last,
      lastOkAt: nowIso(),
      lastAttentionSignature: "",
    };
    saveAlerts(dir, alerts);
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "none",
          reason: "no-attention",
          channelId,
          accountId,
          counts: status.counts,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!args.force && last.signature === signature && cooldownActive) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          action: "suppressed",
          reason: "cooldown",
          channelId,
          accountId,
          cooldownMinutes,
          lastSentAt: last.sentAt || "",
          counts: status.counts,
        },
        null,
        2,
      ),
    );
    return;
  }
  const sent = await postSlackMessage({
    channel: channelId,
    accountId,
    envFile,
    text: alertMessage(status),
  });
  alerts.slack[key] = {
    signature,
    sentAt: nowIso(),
    messageTs: String(sent.ts || ""),
    counts: status.counts,
  };
  saveAlerts(dir, alerts);
  console.log(
    JSON.stringify(
      {
        ok: true,
        action: "sent",
        channelId,
        accountId,
        messageTs: String(sent.ts || ""),
        counts: status.counts,
      },
      null,
      2,
    ),
  );
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
  clearActiveReaction(record);
  writeRecord(dir, record);
  unlinkSync(path);
  console.log(JSON.stringify({ ok: true, removed: id }, null, 2));
}

function checkOne(dir, record, args) {
  const nowMs = Date.now();
  const reason = classify(record, nowMs);
  if (!reason) {
    return { id: record.id, state: record.state, action: "none" };
  }
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
    clearActiveReaction(record);
    applyReaction(record, record.humanAckReaction, false);
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
    clearActiveReaction(record);
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
    clearActiveReaction(record);
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
      if (record.humanAckReactionState === "set") {
        applyReaction(record, record.humanAckReaction, true);
      }
      record.state = "pending";
      record.updatedAt = nowIso();
      record.humanAckedAt = record.updatedAt;
      applyReaction(record, record.activeReaction, false);
      writeRecord(dir, record);
      rearmed += 1;
    }
  }
  saveSessions(dir, sessions);
  console.log(JSON.stringify({ ok: true, sessionKey, rearmed }, null, 2));
}

async function waitForRecord(dir, id, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  const path = join(dir, `${basename(id, ".json")}.json`);
  let lastRecord = null;
  while (Date.now() <= deadline) {
    try {
      lastRecord = readRecord(path);
      if (TERMINAL_STATES.has(lastRecord.state) || lastRecord.state === "requires_human_ack") {
        return lastRecord;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await sleep(5000);
  }
  return lastRecord;
}

async function smokeSlackCommand(args) {
  const dir = stateDir(args);
  const agent = requireString(args, "agent");
  const channelId = requireString(args, "channel-id");
  const accountId = args.account || "soylei";
  const envFile = expandHome(args["env-file"] || "~/credentials/API-keys.env");
  const waitSeconds = readInt(args, "wait-seconds", 210, 30);
  const created = new Date();
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const triggerId = `slack-smoke-${suffix}`;
  const successFile = `/tmp/openclaw-wake-trigger-${triggerId}.done`;
  const root = await postSlackMessage({
    channel: channelId,
    accountId,
    envFile,
    text: `[wake-trigger smoke] ${triggerId}: root message for reaction, acknowledgement, timer, and cleanup validation.`,
  });
  const rootTs = String(root.ts);
  const sessionKey = `agent:${agent}:slack:channel:${channelId}:thread:${rootTs}`;
  const announceMessage = `Wake trigger smoke armed for ${triggerId}. I will resume this thread when the smoke predicate completes, fails, or times out.`;
  const setResult = await setCommand({
    ...args,
    quiet: true,
    id: triggerId,
    name: triggerId,
    agent,
    "session-key": sessionKey,
    "success-cmd": `test -f ${successFile}`,
    "failure-cmd": "false",
    "timeout-minutes": args["timeout-minutes"] || "5",
    "max-attempts": args["max-attempts"] || "1",
    "max-automated-resumes": args["max-automated-resumes"] || "3",
    "agent-timeout-seconds": args["agent-timeout-seconds"] || "180",
    "reply-channel": "slack",
    "reply-account": accountId,
    "reply-to": channelId,
    "active-reaction": args["active-reaction"] || "alarm_clock",
    "reaction-message-id": rootTs,
    "human-ack-reaction": args["human-ack-reaction"] || "warning",
    "announce-message": args["announce-message"] || announceMessage,
    "env-file": envFile,
    deliver: true,
  });
  const armedReactions = await getSlackReactions({
    channel: channelId,
    ts: rootTs,
    accountId,
    envFile,
  });
  writeFileSync(successFile, `${nowIso()}\n`);
  const finalRecord = await waitForRecord(dir, triggerId, waitSeconds);
  const finalReactions = await getSlackReactions({
    channel: channelId,
    ts: rootTs,
    accountId,
    envFile,
  });
  let removedRecord = false;
  if (finalRecord?.state === "delivered_success" && !args["keep-record"]) {
    try {
      unlinkSync(join(dir, `${triggerId}.json`));
      removedRecord = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        ok: finalRecord?.state === "delivered_success",
        triggerId,
        channelId,
        rootTs,
        sessionKey,
        stateDir: dir,
        createdAt: created.toISOString(),
        set: setResult.output,
        armedReactions,
        finalState: finalRecord?.state || "missing",
        finalReactions,
        deliveredAt: finalRecord?.deliveredAt || "",
        lastResumeExitCode: finalRecord?.lastResumeExitCode ?? null,
        lastResumeError: finalRecord?.lastResumeError || "",
        recordRemoved: removedRecord,
      },
      null,
      2,
    ),
  );
  if (finalRecord?.state !== "delivered_success") {
    process.exitCode = 1;
  }
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
    config.sessions[sessionKey] = { ...config.sessions[sessionKey], ...updates };
  } else {
    throw new Error("--scope must be global or session");
  }
  saveConfig(dir, config);
  console.log(JSON.stringify({ ok: true, scope, updates, path: configPath(dir) }, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage(0);
  }
  const args = parseArgs(rest);
  switch (command) {
    case "set":
      await setCommand(args);
      break;
    case "list":
      listCommand(args);
      break;
    case "status":
      statusCommand(args);
      break;
    case "alert-slack":
      await alertSlackCommand(args);
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
    case "smoke-slack":
      await smokeSlackCommand(args);
      break;
    case "defaults":
      defaultsCommand(args);
      break;
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
