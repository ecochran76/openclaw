#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(exitCode = 0) {
  console.log(`Usage:
  install-wake-trigger-checker.mjs [--apply] [--enable] [options]

Options:
  --node <path>            Node executable. Default: current process.execPath.
  --script <path>          wake-trigger.mjs path. Default: repo script.
  --state-dir <dir>        Wake trigger state dir. Default: ~/.openclaw/wake-triggers.
  --env-file <path>        Optional systemd EnvironmentFile for OpenClaw auth/env.
  --install-dir <dir>      systemd user unit dir. Default: ~/.config/systemd/user.
  --interval <duration>    OnUnitActiveSec duration. Default: 2min.
  --on-boot <duration>     OnBootSec duration. Default: 2min.
  --accuracy <duration>    AccuracySec duration. Default: 30s.
  --apply                  Write unit files.
  --enable                 Run systemctl --user daemon-reload and enable --now timer.
  --print                  Print rendered units. Default when --apply is omitted.
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--help" || token === "-h") usage(0);
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (["apply", "enable", "print"].includes(key)) {
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
  if (value === "~") return homedir();
  if (value?.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function resolvePath(value) {
  return resolve(expandHome(value));
}

function render(args) {
  const node = resolvePath(args.node || process.execPath);
  const script = resolvePath(args.script || join(ROOT, "scripts", "wake-trigger.mjs"));
  const stateDir = resolvePath(args["state-dir"] || "~/.openclaw/wake-triggers");
  const envFile = args["env-file"] ? resolvePath(args["env-file"]) : "";
  const pathEnv = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
  const serviceName = "openclaw-wake-trigger-checker.service";
  const timerName = "openclaw-wake-trigger-checker.timer";
  const service = `[Unit]
Description=OpenClaw wake trigger checker
Documentation=file://${ROOT}/docs/dev/plans/0006-2026-05-17-agent-wake-triggers.md

[Service]
Type=oneshot
Environment=${systemdQuote(`PATH=${pathEnv}`)}
${envFile ? `EnvironmentFile=${envFile}\n` : ""}\
ExecStart=${systemdQuote(node)} ${systemdQuote(script)} check --state-dir ${systemdQuote(stateDir)}
`;
  const timer = `[Unit]
Description=Run OpenClaw wake trigger checker

[Timer]
OnBootSec=${args["on-boot"] || "2min"}
OnUnitActiveSec=${args.interval || "2min"}
AccuracySec=${args.accuracy || "30s"}
Persistent=false
Unit=${serviceName}

[Install]
WantedBy=timers.target
`;
  return { serviceName, timerName, service, timer };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rendered = render(args);
  if (!args.apply || args.print) {
    console.log(
      `# ${rendered.serviceName}\n${rendered.service}\n# ${rendered.timerName}\n${rendered.timer}`,
    );
  }
  if (!args.apply) return;
  const installDir = resolvePath(args["install-dir"] || "~/.config/systemd/user");
  mkdirSync(installDir, { recursive: true });
  writeFileSync(join(installDir, rendered.serviceName), rendered.service);
  writeFileSync(join(installDir, rendered.timerName), rendered.timer);
  console.log(`installed ${join(installDir, rendered.serviceName)}`);
  console.log(`installed ${join(installDir, rendered.timerName)}`);
  if (args.enable) {
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", rendered.timerName]);
    console.log(`enabled ${rendered.timerName}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
