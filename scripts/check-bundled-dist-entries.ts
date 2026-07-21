#!/usr/bin/env -S node --import tsx

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type DistPackageJson = {
  openclaw?: {
    extensions?: unknown;
    setupEntry?: unknown;
  };
};

function collectAdvertisedEntries(pkg: DistPackageJson): string[] {
  const manifest = pkg.openclaw;
  if (!manifest) {
    return [];
  }

  const entries: string[] = [];
  if (Array.isArray(manifest.extensions)) {
    for (const entry of manifest.extensions) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        entries.push(entry);
      }
    }
  }
  if (typeof manifest.setupEntry === "string" && manifest.setupEntry.trim().length > 0) {
    entries.push(manifest.setupEntry);
  }
  return [...new Set(entries)];
}

export function collectBundledDistEntryErrors(repoRoot = process.cwd()): string[] {
  const distExtensionsRoot = resolve(repoRoot, "dist", "extensions");
  if (!existsSync(distExtensionsRoot)) {
    return ["dist/extensions directory not found (run pnpm build first)."];
  }

  const errors: string[] = [];
  for (const dirent of readdirSync(distExtensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const pluginId = dirent.name;
    const packageJsonPath = join(distExtensionsRoot, pluginId, "package.json");
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    let packageJson: DistPackageJson;
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as DistPackageJson;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(
        `bundled dist package invalid | plugin '${pluginId}' package.json unreadable: ${message}`,
      );
      continue;
    }

    for (const rawEntry of collectAdvertisedEntries(packageJson)) {
      const relativeEntry = rawEntry.replace(/^\.\//u, "");
      const entryPath = join(distExtensionsRoot, pluginId, relativeEntry);
      if (!existsSync(entryPath)) {
        errors.push(
          `bundled dist entry missing | plugin '${pluginId}' advertises '${rawEntry}' in dist/extensions/${pluginId}/package.json but '${entryPath}' is missing`,
        );
      }
    }
  }

  return errors;
}

function main() {
  const errors = collectBundledDistEntryErrors();
  if (errors.length === 0) {
    console.log("bundled dist entry check: OK");
    return;
  }

  console.error("bundled dist entry check failed:");
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
