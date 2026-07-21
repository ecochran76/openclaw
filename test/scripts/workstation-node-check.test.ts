import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkstationNodeInventory,
  checkWorkstationNodeInventory,
} from "../../scripts/lib/workstation-node-check.mjs";
import { parseWorkstationNodeCheckArgs } from "../../scripts/workstation-node-check.mjs";
import { makeTempDir, cleanupTempDirs } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];

afterEach(async () => {
  cleanupTempDirs(tempDirs);
});

async function fixture(version = "24.18.0") {
  const root = makeTempDir(tempDirs, "openclaw-node-check-");
  const cellar = path.join(root, "brew", "Cellar", "node@24", "24.18.0");
  const canonical = path.join(root, "brew", "opt", "node@24");
  const switchpoint = path.join(root, "stable", "current");
  await fs.mkdir(path.join(cellar, "bin"), { recursive: true });
  await fs.writeFile(
    path.join(cellar, "bin", "node"),
    `#!/bin/sh\nprintf 'v${version}\\n'\n`,
    "utf8",
  );
  await fs.chmod(path.join(cellar, "bin", "node"), 0o755);
  await fs.mkdir(path.dirname(canonical), { recursive: true });
  await fs.symlink(cellar, canonical);
  await fs.mkdir(path.dirname(switchpoint), { recursive: true });
  await fs.symlink(canonical, switchpoint);
  return { root, canonical, switchpoint, canonicalNode: path.join(canonical, "bin", "node") };
}

function canonicalObservations(canonicalNode: string) {
  return {
    defaultNodePath: canonicalNode,
    shells: [{ name: "zsh-login", nodePath: canonicalNode }],
    pnpm: {
      dispatcher: {
        path: "/stable/bin/pnpm",
        owner: "corepack",
        outsideDefaultVersion: "11.2.2",
        resolvedOutsideVersion: "11.2.2",
      },
      repositories: [
        {
          repoPath: "/work/openclaw",
          declaredPackageManager: "pnpm@11.2.2",
          resolvedPackageManager: "pnpm@11.2.2",
        },
      ],
    },
  };
}

describe("workstation Node checker", () => {
  it("detects hard pins, shell/default divergence, direct pnpm, dangling links, and exceptions", async () => {
    const { root, switchpoint } = await fixture();
    const configs = path.join(root, "configs");
    await fs.mkdir(configs);
    await fs.writeFile(
      path.join(configs, "service.conf"),
      [
        "ExecStart=/home/test/.nvm/versions/node/v24.14.0/bin/node app.js",
        "PATH=/home/linuxbrew/.linuxbrew/Cellar/node@24/24.18.0/bin:/usr/bin",
      ].join("\n"),
      "utf8",
    );
    await fs.symlink(path.join(root, "missing-package"), path.join(configs, "dangling-package"));

    const inventory = await buildWorkstationNodeInventory({
      roots: [configs],
      targetPath: switchpoint,
      expectedVersion: "24.18.0",
      observations: {
        defaultNodePath: "/usr/bin/node",
        shells: [
          { name: "zsh-login", nodePath: "/home/test/.nvm/versions/node/v24.14.0/bin/node" },
        ],
        pnpm: {
          dispatcher: {
            path: "/home/test/.local/bin/pnpm",
            owner: "direct",
            outsideDefaultVersion: "9.15.5",
            resolvedOutsideVersion: "10.15.1",
          },
          repositories: [
            {
              repoPath: "/work/openclaw",
              declaredPackageManager: "pnpm@11.2.2",
              resolvedPackageManager: "pnpm@10.15.1",
            },
          ],
        },
        nativeAddons: [{ packageName: "better-sqlite3", owner: "openclaw", rebuilt: false }],
        exceptions: [{ consumer: "legacy-tool", invocationPath: "/usr/bin/node" }],
        env: { OPENAI_API_KEY: "must-never-appear" },
      },
    });

    const checked = checkWorkstationNodeInventory(inventory);
    expect(checked.ok).toBe(false);
    expect(checked.findings.map((finding) => finding.code)).toEqual([
      "corepack-repo-package-manager-mismatch",
      "dangling-link",
      "default-node-divergence",
      "native-addon-rebuild-unresolved",
      "pnpm-bypasses-corepack",
      "pnpm-outside-default-mismatch",
      "shell-node-divergence",
      "unowned-exception",
      "versioned-cellar-path",
      "versioned-nvm-path",
    ]);
    expect(JSON.stringify(checked)).not.toContain("must-never-appear");
    expect(
      checked.findings.find((finding) => finding.code === "versioned-cellar-path"),
    ).toMatchObject({
      stableCandidate: "/home/linuxbrew/.linuxbrew/opt/node@24/bin",
    });
  });

  it("is deterministic and passes canonical secret-safe observations", async () => {
    const { root, switchpoint, canonicalNode } = await fixture();
    const configs = path.join(root, "configs");
    await fs.mkdir(configs);
    await fs.writeFile(path.join(configs, "z.conf"), "PATH=/usr/local/bin\n", "utf8");
    await fs.writeFile(path.join(configs, "a.conf"), "ExecStart=/usr/bin/tool\n", "utf8");
    const params = {
      roots: [configs],
      targetPath: switchpoint,
      expectedVersion: "24.18.0",
      observations: {
        defaultNodePath: canonicalNode,
        shells: [{ name: "bash-login", nodePath: canonicalNode }],
        pnpm: {
          dispatcher: {
            path: "/stable/bin/pnpm",
            owner: "corepack",
            outsideDefaultVersion: "10.15.1",
            resolvedOutsideVersion: "10.15.1",
          },
          repositories: [
            {
              repoPath: "/work/a",
              declaredPackageManager: "pnpm@10.15.1",
              resolvedPackageManager: "pnpm@10.15.1",
            },
            {
              repoPath: "/work/b",
              declaredPackageManager: "pnpm@11.2.2",
              resolvedPackageManager: "pnpm@11.2.2",
            },
          ],
        },
        exceptions: [
          {
            owner: "codegraph",
            consumer: "indexer",
            requiredVersion: "<25",
            invocationPath: "/stable/bin/node",
            validation: "version probe",
            reviewCondition: "engine range changes",
            environment: { TOKEN: "never-output" },
          },
        ],
      },
    };
    const first = checkWorkstationNodeInventory(await buildWorkstationNodeInventory(params));
    const second = checkWorkstationNodeInventory(await buildWorkstationNodeInventory(params));
    expect(second).toEqual(first);
    expect(first.ok).toBe(true);
    expect(first.filesScanned.map((entry) => path.basename(entry))).toEqual(["a.conf", "z.conf"]);
    expect(JSON.stringify(first)).not.toContain("never-output");
  });

  it("parses explicit roots, target, observations, JSON, and dry-run", () => {
    expect(
      parseWorkstationNodeCheckArgs([
        "inventory",
        "--root",
        "/one",
        "--root",
        "/two",
        "--target",
        "/stable/current",
        "--expected-version",
        "24.18.0",
        "--observations",
        "/tmp/observations.json",
        "--json",
        "--dry-run",
      ]),
    ).toMatchObject({
      mode: "inventory",
      roots: ["/one", "/two"],
      targetPath: "/stable/current",
      expectedVersion: "24.18.0",
      observationsPath: "/tmp/observations.json",
      json: true,
    });
  });

  it("returns nonzero in check mode and zero in inventory mode without mutating fixtures", async () => {
    const { root, switchpoint } = await fixture();
    const configs = path.join(root, "configs");
    await fs.mkdir(configs);
    const configPath = path.join(configs, "service.conf");
    const source = "ExecStart=/home/test/.nvm/versions/node/v24.14.0/bin/node app.js\n";
    await fs.writeFile(configPath, source, "utf8");
    const script = path.resolve("scripts/workstation-node-check.mjs");
    const observationsPath = path.join(root, "observations.json");
    await fs.writeFile(observationsPath, JSON.stringify({ canonicalNodeVersion: "24.18.0" }));
    const args = [
      "--root",
      configs,
      "--target",
      switchpoint,
      "--expected-version",
      "24.18.0",
      "--observations",
      observationsPath,
      "--json",
      "--dry-run",
    ];
    const inventory = spawnSync(process.execPath, [script, "inventory", ...args], {
      encoding: "utf8",
    });
    const check = spawnSync(process.execPath, [script, "check", ...args], { encoding: "utf8" });
    expect(inventory.status).toBe(0);
    expect(check.status).toBe(1);
    expect(JSON.parse(inventory.stdout)).toMatchObject({ readOnly: true, schemaVersion: 1 });
    await expect(fs.readFile(configPath, "utf8")).resolves.toBe(source);
  });

  it("fails closed for missing, non-file, and non-executable canonical Node targets", async () => {
    const root = makeTempDir(tempDirs, "openclaw-node-target-");
    const configs = path.join(root, "configs");
    await fs.mkdir(configs);

    const missing = path.join(root, "missing", "node");
    const missingInventory = await buildWorkstationNodeInventory({
      roots: [configs],
      targetPath: missing,
      expectedVersion: "24.18.0",
      observations: { defaultNodePath: missing },
    });
    expect(checkWorkstationNodeInventory(missingInventory).ok).toBe(false);
    expect(missingInventory.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "canonical-node-unavailable",
        "canonical-node-version-probe-failed",
        "canonical-target-unavailable",
        "default-node-divergence",
      ]),
    );

    const directory = path.join(root, "directory-target");
    await fs.mkdir(path.join(directory, "bin", "node"), { recursive: true });
    const directoryInventory = await buildWorkstationNodeInventory({
      roots: [configs],
      targetPath: directory,
      expectedVersion: "24.18.0",
    });
    expect(directoryInventory.findings).toContainEqual(
      expect.objectContaining({ code: "canonical-node-unavailable", state: "directory" }),
    );

    const nonExecutable = path.join(root, "non-executable-node");
    await fs.writeFile(nonExecutable, "#!/bin/sh\n", { mode: 0o644 });
    const nonExecutableInventory = await buildWorkstationNodeInventory({
      roots: [configs],
      targetPath: nonExecutable,
      expectedVersion: "24.18.0",
    });
    expect(nonExecutableInventory.findings).toContainEqual(
      expect.objectContaining({ code: "canonical-node-unavailable", executable: false }),
    );
  });

  it("uses the resolved executable version and ignores a lying observation", async () => {
    const { root, switchpoint, canonicalNode } = await fixture("24.17.0");
    const configs = path.join(root, "configs");
    await fs.mkdir(configs);
    const inventory = await buildWorkstationNodeInventory({
      roots: [configs],
      targetPath: switchpoint,
      expectedVersion: "24.18.0",
      observations: {
        ...canonicalObservations(canonicalNode),
        canonicalNodeVersion: "24.18.0",
      },
    });
    expect(checkWorkstationNodeInventory(inventory).ok).toBe(false);
    expect(inventory.findings).toContainEqual(
      expect.objectContaining({
        code: "canonical-node-version-mismatch",
        expected: "24.18.0",
        observed: "24.17.0",
      }),
    );
  });

  it("cannot green an empty executable target", async () => {
    const { root, switchpoint, canonicalNode } = await fixture();
    const configs = path.join(root, "configs");
    await fs.mkdir(configs);
    await fs.writeFile(await fs.realpath(canonicalNode), "", "utf8");

    const checked = checkWorkstationNodeInventory(
      await buildWorkstationNodeInventory({
        roots: [configs],
        targetPath: switchpoint,
        expectedVersion: "24.18.0",
        observations: canonicalObservations(canonicalNode),
      }),
    );
    expect(checked.ok).toBe(false);
    expect(checked.findings).toContainEqual(
      expect.objectContaining({ code: "canonical-node-version-probe-failed" }),
    );
  });

  it("records oversized and non-regular entries as incomplete scan coverage", async () => {
    const { root, switchpoint, canonicalNode } = await fixture();
    const configs = path.join(root, "configs");
    await fs.mkdir(configs);
    const oversized = path.join(configs, "oversized.conf");
    await fs.writeFile(oversized, Buffer.alloc(1024 * 1024 + 1, 0x20));
    const fifo = path.join(configs, "runtime.pipe");
    expect(spawnSync("mkfifo", [fifo], { encoding: "utf8" }).status).toBe(0);

    const checked = checkWorkstationNodeInventory(
      await buildWorkstationNodeInventory({
        roots: [configs],
        targetPath: switchpoint,
        expectedVersion: "24.18.0",
        observations: canonicalObservations(canonicalNode),
      }),
    );
    expect(checked.ok).toBe(false);
    expect(checked.scanSkips).toEqual([
      { path: oversized, code: "file-too-large", size: 1024 * 1024 + 1 },
      { path: fifo, code: "non-regular-entry" },
    ]);
    expect(checked.summary.incompleteCoverage).toBe(2);
  });

  it("records binary files and symlink target content as incomplete coverage", async () => {
    const { root, switchpoint, canonicalNode } = await fixture();
    const configs = path.join(root, "configs");
    const linkedTarget = path.join(root, "linked-target.conf");
    await fs.mkdir(configs);
    await fs.writeFile(path.join(configs, "binary.conf"), Buffer.from([0x41, 0x00, 0x42]));
    await fs.writeFile(linkedTarget, "ExecStart=/usr/bin/node\n", "utf8");
    await fs.symlink(linkedTarget, path.join(configs, "linked.conf"));

    const checked = checkWorkstationNodeInventory(
      await buildWorkstationNodeInventory({
        roots: [configs],
        targetPath: switchpoint,
        expectedVersion: "24.18.0",
        observations: canonicalObservations(canonicalNode),
      }),
    );
    expect(checked.ok).toBe(false);
    expect(checked.scanSkips).toEqual([
      { path: path.join(configs, "binary.conf"), code: "binary-file" },
      {
        path: path.join(configs, "linked.conf"),
        code: "symlink-content-not-scanned",
        resolvedPath: linkedTarget,
      },
    ]);
  });

  it("fails check coverage when required observation sections are absent or incomplete", async () => {
    const { root, switchpoint } = await fixture();
    const configs = path.join(root, "configs");
    await fs.mkdir(configs);

    const inventory = await buildWorkstationNodeInventory({
      roots: [configs],
      targetPath: switchpoint,
      expectedVersion: "24.18.0",
      observations: {
        shells: [{ name: "invalid-without-node-path" }],
        pnpm: { dispatcher: { owner: "corepack" }, repositories: [] },
      },
    });
    expect(checkWorkstationNodeInventory(inventory).ok).toBe(false);
    expect(inventory.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "observation-default-node-missing",
        "observation-pnpm-dispatcher-incomplete",
        "observation-pnpm-repositories-incomplete",
        "observation-shell-coverage-incomplete",
      ]),
    );
  });
});
