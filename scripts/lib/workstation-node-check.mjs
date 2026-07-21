import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const MAX_SCANNED_FILE_BYTES = 1024 * 1024;
const NODE_VERSION_PROBE_TIMEOUT_MS = 5_000;
const NODE_VERSION_PROBE_MAX_BYTES = 4 * 1024;
const execFileAsync = promisify(execFile);
const REQUIRED_EXCEPTION_FIELDS = [
  "owner",
  "consumer",
  "requiredVersion",
  "invocationPath",
  "validation",
  "reviewCondition",
];

const HARD_PIN_PATTERNS = [
  {
    kind: "nvm",
    pattern:
      /(?:[A-Za-z]:)?[^\s"'`=;:]*[\\/]\.nvm[\\/]versions[\\/]node[\\/]v?\d+(?:\.\d+){0,2}[^\s"'`=;:]*/giu,
  },
  {
    kind: "cellar",
    // Keep this shape aligned with src/infra/stable-node-path.ts: Cellar/<formula>/<version>.
    pattern:
      /(?:[A-Za-z]:)?[^\s"'`=;:]*[\\/]Cellar[\\/]node(?:@\d+)?[\\/]\d+(?:\.\d+){0,2}[^\s"'`=;:]*/giu,
  },
];

function compareText(left, right) {
  return left.localeCompare(right);
}

function normalizedAbsolute(input) {
  return path.resolve(input);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function pathState(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isSymbolicLink()) {
      return { exists: true, kind: stat.isDirectory() ? "directory" : "file", resolvedPath: null };
    }
    const linkTarget = await fs.readlink(filePath);
    try {
      return {
        exists: true,
        kind: "symlink",
        linkTarget,
        resolvedPath: await fs.realpath(filePath),
      };
    } catch {
      return { exists: true, kind: "dangling-symlink", linkTarget, resolvedPath: null };
    }
  } catch {
    return { exists: false, kind: "missing", resolvedPath: null };
  }
}

async function executableFileState(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return {
        exists: true,
        kind: stat.isDirectory() ? "directory" : "non-file",
        executable: false,
      };
    }
    try {
      await fs.access(filePath, fs.constants.X_OK);
      return {
        exists: true,
        kind: "file",
        executable: true,
        resolvedPath: await fs.realpath(filePath),
      };
    } catch {
      return {
        exists: true,
        kind: "file",
        executable: false,
        resolvedPath: await fs.realpath(filePath),
      };
    }
  } catch {
    return { exists: false, kind: "missing", executable: false, resolvedPath: null };
  }
}

async function probeNodeVersion(resolvedExecutablePath) {
  if (!resolvedExecutablePath) {
    return { ok: false, version: null, failure: "unavailable" };
  }
  try {
    const { stdout } = await execFileAsync(resolvedExecutablePath, ["--version"], {
      encoding: "utf8",
      timeout: NODE_VERSION_PROBE_TIMEOUT_MS,
      maxBuffer: NODE_VERSION_PROBE_MAX_BYTES,
      windowsHide: true,
      shell: false,
    });
    const output = stdout.trim();
    const match = output.match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u);
    if (!match) {
      return { ok: false, version: null, failure: output ? "invalid-output" : "empty-output" };
    }
    return { ok: true, version: match[1], failure: null };
  } catch (error) {
    return {
      ok: false,
      version: null,
      failure:
        error && typeof error === "object" && "killed" in error && error.killed
          ? "timeout"
          : "execution-failed",
    };
  }
}

function stableCandidateForCellarPath(input) {
  const match = input.match(/^(.+?)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+(?:[\\/](.*))?$/u);
  if (!match) {
    return null;
  }
  const pathModule = input.includes("\\") ? path.win32 : path.posix;
  return pathModule.join(match[1], "opt", match[2], match[3] ?? "");
}

function collectHardPins(content, sourcePath) {
  const findings = [];
  const lines = content.split(/\r?\n/u);
  for (const [lineIndex, line] of lines.entries()) {
    for (const { kind, pattern } of HARD_PIN_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of line.matchAll(pattern)) {
        const matchedPath = match[0].replace(/[),\]}]+$/u, "");
        findings.push({
          code: kind === "nvm" ? "versioned-nvm-path" : "versioned-cellar-path",
          severity: "error",
          sourcePath,
          line: lineIndex + 1,
          matchedPath,
          stableCandidate: kind === "cellar" ? stableCandidateForCellarPath(matchedPath) : null,
        });
      }
    }
  }
  return findings;
}

async function scanEntry(entryPath, inventory) {
  let stat;
  try {
    stat = await fs.lstat(entryPath);
  } catch {
    inventory.scanErrors.push({ path: entryPath, code: "unreadable-entry" });
    return;
  }

  if (stat.isSymbolicLink()) {
    const state = await pathState(entryPath);
    inventory.links.push({
      path: entryPath,
      target: state.linkTarget ?? null,
      resolvedPath: state.resolvedPath,
      dangling: state.kind === "dangling-symlink",
    });
    if (state.linkTarget) {
      inventory.findings.push(...collectHardPins(state.linkTarget, entryPath));
    }
    if (state.kind === "dangling-symlink") {
      inventory.findings.push({
        code: "dangling-link",
        severity: "error",
        path: entryPath,
        target: state.linkTarget ?? null,
      });
    } else {
      // Link text is scanned above, but target content is not traversed. Record the
      // gap so authoritative checks cannot silently miss pins behind links or cycles.
      inventory.scanSkips.push({
        path: entryPath,
        code: "symlink-content-not-scanned",
        resolvedPath: state.resolvedPath,
      });
    }
    return;
  }

  if (stat.isDirectory()) {
    let names;
    try {
      names = await fs.readdir(entryPath);
    } catch {
      inventory.scanErrors.push({ path: entryPath, code: "unreadable-directory" });
      return;
    }
    for (const name of names.toSorted(compareText)) {
      await scanEntry(path.join(entryPath, name), inventory);
    }
    return;
  }

  if (!stat.isFile()) {
    inventory.scanSkips.push({ path: entryPath, code: "non-regular-entry" });
    return;
  }
  if (stat.size > MAX_SCANNED_FILE_BYTES) {
    inventory.scanSkips.push({ path: entryPath, code: "file-too-large", size: stat.size });
    return;
  }

  let content;
  try {
    content = await fs.readFile(entryPath, "utf8");
  } catch {
    inventory.scanErrors.push({ path: entryPath, code: "unreadable-file" });
    return;
  }
  if (content.includes("\u0000")) {
    inventory.scanSkips.push({ path: entryPath, code: "binary-file" });
    return;
  }
  inventory.filesScanned.push(entryPath);
  inventory.findings.push(...collectHardPins(content, entryPath));
}

function normalizeShells(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!isObject(entry)) {
        return null;
      }
      const name = safeString(entry.name);
      const nodePath = safeString(entry.nodePath);
      return name && nodePath ? { name, nodePath } : null;
    })
    .filter(Boolean)
    .toSorted((left, right) => compareText(left.name, right.name));
}

function normalizeExceptions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry, index) => {
    const record = { index };
    if (!isObject(entry)) {
      return record;
    }
    for (const field of REQUIRED_EXCEPTION_FIELDS) {
      record[field] = safeString(entry[field]);
    }
    return record;
  });
}

function normalizeNativeAddons(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!isObject(entry)) {
        return null;
      }
      const packageName = safeString(entry.packageName);
      const owner = safeString(entry.owner);
      if (!packageName) {
        return null;
      }
      return { packageName, owner, rebuilt: entry.rebuilt === true };
    })
    .filter(Boolean)
    .toSorted((left, right) => compareText(left.packageName, right.packageName));
}

function normalizeObservations(raw) {
  const observations = isObject(raw) ? raw : {};
  const rawShells = Array.isArray(observations.shells) ? observations.shells : null;
  const normalizedShells = normalizeShells(rawShells);
  const rawPnpm = isObject(observations.pnpm) ? observations.pnpm : null;
  const rawDispatcher = isObject(rawPnpm?.dispatcher) ? rawPnpm.dispatcher : null;
  const rawRepositories = Array.isArray(rawPnpm?.repositories) ? rawPnpm.repositories : null;
  const pnpm = isObject(observations.pnpm)
    ? {
        dispatcher: isObject(observations.pnpm.dispatcher)
          ? {
              path: safeString(observations.pnpm.dispatcher.path),
              owner: safeString(observations.pnpm.dispatcher.owner),
              outsideDefaultVersion: safeString(observations.pnpm.dispatcher.outsideDefaultVersion),
              resolvedOutsideVersion: safeString(
                observations.pnpm.dispatcher.resolvedOutsideVersion,
              ),
            }
          : null,
        repositories: Array.isArray(observations.pnpm.repositories)
          ? observations.pnpm.repositories
              .map((entry) => {
                if (!isObject(entry)) {
                  return null;
                }
                const repoPath = safeString(entry.repoPath);
                const declaredPackageManager = safeString(entry.declaredPackageManager);
                const resolvedPackageManager = safeString(entry.resolvedPackageManager);
                return repoPath && declaredPackageManager && resolvedPackageManager
                  ? { repoPath, declaredPackageManager, resolvedPackageManager }
                  : null;
              })
              .filter(Boolean)
              .toSorted((left, right) => compareText(left.repoPath, right.repoPath))
          : [],
      }
    : null;
  return {
    defaultNodePath: safeString(observations.defaultNodePath),
    shells: normalizedShells,
    pnpm,
    nativeAddons: normalizeNativeAddons(observations.nativeAddons),
    exceptions: normalizeExceptions(observations.exceptions),
    coverage: {
      shellsProvided: rawShells !== null,
      shellRecordCount: normalizedShells.length,
      invalidShellRecords: rawShells ? rawShells.length - normalizedShells.length : 0,
      pnpmProvided: rawPnpm !== null,
      dispatcherProvided: rawDispatcher !== null,
      dispatcherComplete:
        rawDispatcher !== null &&
        ["path", "owner", "outsideDefaultVersion", "resolvedOutsideVersion"].every((field) =>
          Boolean(safeString(rawDispatcher[field])),
        ),
      repositoriesProvided: rawRepositories !== null,
      repositoryRecordCount: pnpm?.repositories.length ?? 0,
      invalidRepositoryRecords: rawRepositories
        ? rawRepositories.length - (pnpm?.repositories.length ?? 0)
        : 0,
    },
  };
}

async function equivalentPaths(left, right) {
  if (!left || !right) {
    return false;
  }
  try {
    return (await fs.realpath(left)) === (await fs.realpath(right));
  } catch {
    // A textual match between two missing paths is not proof that either selects Node.
    return false;
  }
}

function expectedNodePath(targetPath) {
  const base = path.basename(targetPath).toLowerCase();
  if (base === "node" || base === "node.exe") {
    return targetPath;
  }
  return path.join(targetPath, "bin", process.platform === "win32" ? "node.exe" : "node");
}

async function addObservationFindings(inventory, targetNodePath) {
  const { observations } = inventory;
  if (!observations.defaultNodePath) {
    inventory.findings.push({
      code: "observation-default-node-missing",
      severity: "error",
    });
  }
  if (
    !observations.coverage.shellsProvided ||
    observations.coverage.shellRecordCount === 0 ||
    observations.coverage.invalidShellRecords > 0
  ) {
    inventory.findings.push({
      code: "observation-shell-coverage-incomplete",
      severity: "error",
      provided: observations.coverage.shellsProvided,
      validRecords: observations.coverage.shellRecordCount,
      invalidRecords: observations.coverage.invalidShellRecords,
    });
  }
  if (!observations.coverage.pnpmProvided || !observations.coverage.dispatcherComplete) {
    inventory.findings.push({
      code: "observation-pnpm-dispatcher-incomplete",
      severity: "error",
      provided: observations.coverage.dispatcherProvided,
      complete: observations.coverage.dispatcherComplete,
    });
  }
  if (
    !observations.coverage.repositoriesProvided ||
    observations.coverage.repositoryRecordCount === 0 ||
    observations.coverage.invalidRepositoryRecords > 0
  ) {
    inventory.findings.push({
      code: "observation-pnpm-repositories-incomplete",
      severity: "error",
      provided: observations.coverage.repositoriesProvided,
      validRecords: observations.coverage.repositoryRecordCount,
      invalidRecords: observations.coverage.invalidRepositoryRecords,
    });
  }
  const nodeSelections = [
    ...(observations.defaultNodePath
      ? [{ name: "default", nodePath: observations.defaultNodePath }]
      : []),
    ...observations.shells,
  ];
  for (const selection of nodeSelections) {
    if (!(await equivalentPaths(selection.nodePath, targetNodePath))) {
      inventory.findings.push({
        code: selection.name === "default" ? "default-node-divergence" : "shell-node-divergence",
        severity: "error",
        name: selection.name,
        nodePath: selection.nodePath,
        expectedNodePath: targetNodePath,
      });
    }
  }

  const dispatcher = observations.pnpm?.dispatcher;
  if (dispatcher?.owner && dispatcher.owner !== "corepack") {
    inventory.findings.push({
      code: "pnpm-bypasses-corepack",
      severity: "error",
      path: dispatcher.path,
      owner: dispatcher.owner,
    });
  }
  if (
    dispatcher?.outsideDefaultVersion &&
    dispatcher.resolvedOutsideVersion &&
    dispatcher.outsideDefaultVersion !== dispatcher.resolvedOutsideVersion
  ) {
    inventory.findings.push({
      code: "pnpm-outside-default-mismatch",
      severity: "error",
      expected: dispatcher.outsideDefaultVersion,
      resolved: dispatcher.resolvedOutsideVersion,
    });
  }
  for (const repository of observations.pnpm?.repositories ?? []) {
    if (repository.declaredPackageManager !== repository.resolvedPackageManager) {
      inventory.findings.push({
        code: "corepack-repo-package-manager-mismatch",
        severity: "error",
        repoPath: repository.repoPath,
        declared: repository.declaredPackageManager,
        resolved: repository.resolvedPackageManager,
      });
    }
  }

  for (const addon of observations.nativeAddons) {
    if (!addon.rebuilt) {
      inventory.findings.push({
        code: "native-addon-rebuild-unresolved",
        severity: "error",
        packageName: addon.packageName,
        owner: addon.owner,
      });
    }
  }

  for (const exception of observations.exceptions) {
    const missingFields = REQUIRED_EXCEPTION_FIELDS.filter((field) => !exception[field]);
    if (missingFields.length > 0) {
      inventory.findings.push({
        code: "unowned-exception",
        severity: "error",
        exceptionIndex: exception.index,
        missingFields,
      });
    }
  }
}

function findingSortKey(finding) {
  return [
    finding.code ?? "",
    finding.sourcePath ?? finding.path ?? "",
    String(finding.line ?? ""),
    finding.name ?? finding.packageName ?? "",
  ].join("\u0000");
}

export async function buildWorkstationNodeInventory(params) {
  const roots = [...new Set((params.roots ?? []).map(normalizedAbsolute))].toSorted(compareText);
  const targetPath = normalizedAbsolute(params.targetPath);
  const targetState = await pathState(targetPath);
  const targetNodePath = expectedNodePath(targetPath);
  const targetNodeState = await executableFileState(targetNodePath);
  const nodeVersionProbe = await probeNodeVersion(
    targetNodeState.executable ? targetNodeState.resolvedPath : null,
  );
  const expectedVersion = safeString(params.expectedVersion);
  const inventory = {
    schemaVersion: 1,
    readOnly: true,
    roots,
    target: {
      path: targetPath,
      ...targetState,
      expectedNodePath: targetNodePath,
      node: targetNodeState,
      version: {
        expected: expectedVersion?.replace(/^v/u, "") ?? null,
        observed: nodeVersionProbe.version,
        probe: {
          executablePath: targetNodeState.resolvedPath ?? null,
          ok: nodeVersionProbe.ok,
          failure: nodeVersionProbe.failure,
          timeoutMs: NODE_VERSION_PROBE_TIMEOUT_MS,
          maxOutputBytes: NODE_VERSION_PROBE_MAX_BYTES,
        },
      },
    },
    filesScanned: [],
    links: [],
    scanErrors: [],
    scanSkips: [],
    observations: normalizeObservations(params.observations),
    findings: [],
  };

  if (targetState.kind === "missing" || targetState.kind === "dangling-symlink") {
    inventory.findings.push({
      code: "canonical-target-unavailable",
      severity: "error",
      path: targetPath,
      state: targetState.kind,
    });
  } else if (targetState.linkTarget && collectHardPins(targetState.linkTarget, targetPath).length) {
    inventory.findings.push({
      code: "canonical-target-hard-pinned",
      severity: "error",
      path: targetPath,
      linkTarget: targetState.linkTarget,
    });
  }

  if (!targetNodeState.exists || targetNodeState.kind !== "file" || !targetNodeState.executable) {
    inventory.findings.push({
      code: "canonical-node-unavailable",
      severity: "error",
      path: targetNodePath,
      state: targetNodeState.kind,
      executable: targetNodeState.executable,
    });
  }
  if (!nodeVersionProbe.ok) {
    inventory.findings.push({
      code: "canonical-node-version-probe-failed",
      severity: "error",
      path: targetNodeState.resolvedPath ?? targetNodePath,
      failure: nodeVersionProbe.failure,
    });
  }
  const normalizedExpectedVersion = expectedVersion?.replace(/^v/u, "") ?? null;
  if (
    !normalizedExpectedVersion ||
    !nodeVersionProbe.version ||
    normalizedExpectedVersion !== nodeVersionProbe.version
  ) {
    inventory.findings.push({
      code: "canonical-node-version-mismatch",
      severity: "error",
      expected: normalizedExpectedVersion,
      observed: nodeVersionProbe.version,
    });
  }

  for (const root of roots) {
    await scanEntry(root, inventory);
  }
  await addObservationFindings(inventory, inventory.target.expectedNodePath);

  inventory.filesScanned.sort(compareText);
  inventory.links.sort((left, right) => compareText(left.path, right.path));
  inventory.scanErrors.sort((left, right) => compareText(left.path, right.path));
  inventory.scanSkips.sort((left, right) => compareText(left.path, right.path));
  inventory.findings.sort((left, right) =>
    compareText(findingSortKey(left), findingSortKey(right)),
  );
  inventory.summary = {
    filesScanned: inventory.filesScanned.length,
    links: inventory.links.length,
    danglingLinks: inventory.links.filter((entry) => entry.dangling).length,
    incompleteCoverage: inventory.scanErrors.length + inventory.scanSkips.length,
    errors: inventory.findings.filter((entry) => entry.severity === "error").length,
  };
  return inventory;
}

export function checkWorkstationNodeInventory(inventory) {
  return {
    ...inventory,
    mode: "check",
    ok:
      inventory.summary.errors === 0 &&
      inventory.scanErrors.length === 0 &&
      inventory.scanSkips.length === 0,
  };
}
