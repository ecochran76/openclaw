let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(raw);
    const targets = Array.isArray(parsed?.targets) ? parsed.targets : [];
    const primary = targets.find(
      (target) => target?.id === parsed?.primaryTargetId && target?.connect?.rpcOk === true,
    );
    const active = targets.find(
      (target) => target?.active === true && target?.connect?.rpcOk === true,
    );
    const reachable = targets.find((target) => target?.connect?.rpcOk === true);
    const self = primary?.self ?? active?.self ?? reachable?.self ?? parsed?.gateway ?? null;
    const version = typeof self?.version === "string" ? self.version : "";
    const buildCommit = typeof self?.buildCommit === "string" ? self.buildCommit : "";
    process.stdout.write(version && buildCommit ? `${version} (${buildCommit})` : version);
  } catch {
    process.stdout.write("");
  }
});
