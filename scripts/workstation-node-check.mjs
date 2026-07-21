#!/usr/bin/env node
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildWorkstationNodeInventory,
  checkWorkstationNodeInventory,
} from "./lib/workstation-node-check.mjs";

function usage() {
  return [
    "Usage: node scripts/workstation-node-check.mjs <inventory|check> --root <path>... --target <path> --expected-version <version> [options]",
    "",
    "Read-only workstation Node inventory and consistency checker.",
    "",
    "Options:",
    "  --root <path>          Maintained configuration/package root to scan (repeatable)",
    "  --target <path>        Canonical stable Node switchpoint or node executable",
    "  --expected-version <v> Expected canonical Node version (probed from the target executable)",
    "  --observations <json>  Secret-safe observed shell/package/exception records",
    "  --json                 Emit deterministic JSON",
    "  --dry-run              Explicitly affirm read-only operation (always enforced)",
    "  --help                 Show this help text",
  ].join("\n");
}

export function parseWorkstationNodeCheckArgs(argv) {
  const parsed = {
    mode: null,
    roots: [],
    targetPath: null,
    expectedVersion: null,
    observationsPath: null,
    json: false,
  };
  const args = [...argv];
  if (args[0] === "inventory" || args[0] === "check") {
    parsed.mode = args.shift();
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      return { ...parsed, help: true };
    }
    if (arg === "--json" || arg === "--dry-run") {
      if (arg === "--json") {
        parsed.json = true;
      }
      continue;
    }
    if (
      arg === "--root" ||
      arg === "--target" ||
      arg === "--expected-version" ||
      arg === "--observations"
    ) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--root") {
        parsed.roots.push(value);
      } else if (arg === "--target") {
        parsed.targetPath = value;
      } else if (arg === "--expected-version") {
        parsed.expectedVersion = value;
      } else {
        parsed.observationsPath = value;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.mode) {
    throw new Error("mode must be inventory or check");
  }
  if (parsed.roots.length === 0) {
    throw new Error("at least one --root is required");
  }
  if (!parsed.targetPath) {
    throw new Error("--target is required");
  }
  if (!parsed.expectedVersion) {
    throw new Error("--expected-version is required");
  }
  return parsed;
}

async function main() {
  const options = parseWorkstationNodeCheckArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const observations = options.observationsPath
    ? JSON.parse(await fs.readFile(options.observationsPath, "utf8"))
    : {};
  const inventory = await buildWorkstationNodeInventory({
    roots: options.roots,
    targetPath: options.targetPath,
    expectedVersion: options.expectedVersion,
    observations,
  });
  const output = options.mode === "check" ? checkWorkstationNodeInventory(inventory) : inventory;
  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    const status = options.mode === "check" ? (output.ok ? "ok" : "failed") : "inventory";
    console.log(
      `[workstation-node-check] ${status}: ${output.summary.errors} finding(s), ${output.summary.incompleteCoverage} incomplete scan item(s), ${output.summary.filesScanned} file(s), ${output.summary.links} link(s)`,
    );
  }
  if (options.mode === "check" && !output.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(
      `[workstation-node-check] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  });
}
