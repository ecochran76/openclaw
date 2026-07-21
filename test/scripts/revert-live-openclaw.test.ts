import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const revertScript = path.join(repoRoot, "scripts/revert-live-openclaw.sh");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeFixture(options: { brokenBackupCli?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-revert-test-"));
  roots.push(root);
  const prefix = path.join(root, "prefix");
  const packageDir = path.join(prefix, "lib/node_modules/openclaw");
  const backupRoot = path.join(root, "backup-root");
  const backupPackage = path.join(backupRoot, "openclaw");
  mkdirSync(path.join(packageDir, "node_modules/current-only"), { recursive: true });
  writeFileSync(path.join(packageDir, "current.txt"), "current\n");
  writeFileSync(path.join(packageDir, "node_modules/current-only/index.js"), "current\n");
  mkdirSync(path.join(backupPackage, "node_modules/backup-only"), { recursive: true });
  writeFileSync(
    path.join(backupPackage, "package.json"),
    '{"name":"openclaw","version":"1.0.0"}\n',
  );
  writeFileSync(path.join(backupPackage, "backup.txt"), "backup\n");
  writeFileSync(path.join(backupPackage, "node_modules/backup-only/index.js"), "backup\n");
  const backupCli = path.join(backupPackage, "openclaw.mjs");
  writeFileSync(
    backupCli,
    options.brokenBackupCli
      ? "#!/usr/bin/env node\nprocess.exit(23);\n"
      : "#!/usr/bin/env node\nconsole.log('1.0.0');\n",
  );
  chmodSync(backupCli, 0o755);
  mkdirSync(path.join(prefix, "bin"), { recursive: true });
  symlinkSync("../lib/node_modules/openclaw/openclaw.mjs", path.join(prefix, "bin/openclaw"));
  const npmMarker = path.join(root, "npm-was-run");
  const fakeNpm = path.join(root, "npm-must-not-run");
  writeFileSync(fakeNpm, `#!/usr/bin/env bash\ntouch ${JSON.stringify(npmMarker)}\nexit 99\n`);
  chmodSync(fakeNpm, 0o755);
  writeFileSync(
    path.join(backupRoot, ".openclaw-live-patch-backup-metadata"),
    `format=1\nnpm_prefix=${prefix}\npackage_dir=${packageDir}\nnpm_bin=${fakeNpm}\n`,
  );
  const archive = path.join(root, "backup.tgz");
  execFileSync("tar", [
    "-czf",
    archive,
    "-C",
    backupRoot,
    "openclaw",
    ".openclaw-live-patch-backup-metadata",
  ]);
  return { archive, npmMarker, packageDir, prefix };
}

describe("revert-live-openclaw", () => {
  it("restores the archived package tree directly without npm", () => {
    const fixture = makeFixture();
    const output = execFileSync("bash", [revertScript, fixture.archive], { encoding: "utf8" });
    expect(output).toContain("1.0.0");
    expect(readFileSync(path.join(fixture.packageDir, "backup.txt"), "utf8")).toBe("backup\n");
    expect(
      readFileSync(path.join(fixture.packageDir, "node_modules/backup-only/index.js"), "utf8"),
    ).toBe("backup\n");
    expect(existsSync(path.join(fixture.packageDir, "current.txt"))).toBe(false);
    expect(existsSync(path.join(fixture.packageDir, "node_modules/current-only"))).toBe(false);
    expect(existsSync(fixture.npmMarker)).toBe(false);
    expect(lstatSync(path.join(fixture.prefix, "bin/openclaw")).isSymbolicLink()).toBe(true);
  });

  it("restores the pre-revert tree when archived CLI verification fails", () => {
    const fixture = makeFixture({ brokenBackupCli: true });
    const result = spawnSync("bash", [revertScript, fixture.archive], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("restoring the pre-revert package");
    expect(readFileSync(path.join(fixture.packageDir, "current.txt"), "utf8")).toBe("current\n");
    expect(existsSync(path.join(fixture.packageDir, "backup.txt"))).toBe(false);
  });

  it("does not mutate the installed tree during a dry run", () => {
    const fixture = makeFixture();
    const output = execFileSync("bash", [revertScript, fixture.archive, "--dry-run"], {
      encoding: "utf8",
    });
    expect(output).toContain("[dry-run]");
    expect(readFileSync(path.join(fixture.packageDir, "current.txt"), "utf8")).toBe("current\n");
    expect(existsSync(path.join(fixture.packageDir, "backup.txt"))).toBe(false);
  });
});
