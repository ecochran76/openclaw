import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const patchScript = path.join(repoRoot, "scripts/patch-live-openclaw.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("patch-live-openclaw", () => {
  it("rejects a linked global install before build or install mutation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-linked-patch-test-"));
    roots.push(root);
    const checkout = path.join(root, "checkout");
    const prefix = path.join(root, "prefix");
    const binDir = path.join(prefix, "bin");
    const packageDir = path.join(prefix, "lib/node_modules/openclaw");
    const mutationMarker = path.join(root, "mutation-marker");
    mkdirSync(checkout, { recursive: true });
    execFileSync("git", ["init", "-q", checkout]);
    writeFileSync(path.join(checkout, "sentinel.txt"), "unchanged\n");
    mkdirSync(path.dirname(packageDir), { recursive: true });
    symlinkSync(checkout, packageDir);
    mkdirSync(binDir, { recursive: true });

    const fakeNpm = path.join(binDir, "npm");
    writeFileSync(
      fakeNpm,
      `#!/usr/bin/env bash\nif [[ \"$1\" == \"prefix\" ]]; then echo ${JSON.stringify(prefix)}; exit 0; fi\nif [[ \"$1\" == \"root\" ]]; then echo ${JSON.stringify(path.join(prefix, "lib/node_modules"))}; exit 0; fi\ntouch ${JSON.stringify(mutationMarker)}\nexit 99\n`,
    );
    chmodSync(fakeNpm, 0o755);
    const fakeOpenClaw = path.join(binDir, "openclaw");
    writeFileSync(fakeOpenClaw, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(fakeOpenClaw, 0o755);
    const fakePnpm = path.join(binDir, "pnpm");
    writeFileSync(
      fakePnpm,
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(mutationMarker)}\nexit 99\n`,
    );
    chmodSync(fakePnpm, 0o755);
    const fakeSystemctl = path.join(binDir, "systemctl");
    writeFileSync(fakeSystemctl, "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(fakeSystemctl, 0o755);

    const result = spawnSync("bash", [patchScript, "--skip-restart"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_REPO_DIR: checkout,
        OPENCLAW_PATCH_TMP_ROOT: root,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("refusing to patch linked global OpenClaw install");
    expect(existsSync(mutationMarker)).toBe(false);
    expect(readlinkSync(packageDir)).toBe(checkout);
  });
});
