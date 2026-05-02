import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePluginCacheInputs, resolvePluginSourceRoots } from "./roots.js";

const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-roots-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin roots", () => {
  it("keeps source roots stable for workspace plugin discovery", () => {
    const workspaceDir = makeTempDir();

    expect(resolvePluginSourceRoots({ workspaceDir }).workspace).toBe(
      path.join(workspaceDir, ".openclaw", "extensions"),
    );
  });

  it("omits missing workspace plugin roots from cache inputs", () => {
    const workspaceDir = makeTempDir();

    expect(resolvePluginCacheInputs({ workspaceDir }).roots.workspace).toBeUndefined();
  });

  it("includes existing workspace plugin roots in cache inputs", () => {
    const workspaceDir = makeTempDir();
    const workspacePluginRoot = path.join(workspaceDir, ".openclaw", "extensions");
    fs.mkdirSync(workspacePluginRoot, { recursive: true });

    expect(resolvePluginCacheInputs({ workspaceDir }).roots.workspace).toBe(workspacePluginRoot);
  });
});
