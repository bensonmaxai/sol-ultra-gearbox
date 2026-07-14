#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readdir, realpath, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  atomicWrite,
  cleanupProbeArtifacts,
  DISPATCH_RUNTIME_FILES,
  ROLE_SPECS,
  redactSensitive,
  sha256,
  validatePostInstallRootRuntime,
} from "../lib/gearbox.mjs";
import { planDispatch } from "../lib/dispatch-planner.mjs";
import { validateDispatchResult } from "../lib/dispatch-evidence.mjs";
import { DISPATCH_POLICY_RELATIVE_PATH, loadDispatchPolicy } from "../lib/dispatch-policy.mjs";
import { runIsolatedRole } from "../lib/dispatch-runner.mjs";
import { readOwnedPacket } from "../lib/owned-packet.mjs";
import { runWorkflowNext } from "../lib/workflow-cli.mjs";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");

function off() {
  return { status: "GEARBOX_DISPATCH_OFF", mode: "off" };
}

function parsePacketArguments(args) {
  const capabilityFlags = new Map([
    ["--agent-type-visible", "agentTypeVisible"],
    ["--isolated-runner-verified", "isolatedRunnerVerified"],
    ["--runtime-metadata-available", "runtimeMetadataAvailable"],
    ["--permissions-enforced", "permissionsEnforced"],
  ]);
  let packetPath = null;
  let consume = false;
  const capabilityInput = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--consume") {
      if (consume) throw new TypeError("--consume may be specified once");
      consume = true;
      continue;
    }
    if (value === "--packet") {
      if (packetPath !== null || !args[index + 1]) throw new TypeError("dispatch command accepts exactly one packet path");
      packetPath = args[index + 1];
      index += 1;
      continue;
    }
    const key = capabilityFlags.get(value);
    if (!key || Object.hasOwn(capabilityInput, key) || !["true", "false"].includes(args[index + 1])) {
      throw new TypeError("dispatch capability flags must be unique exact booleans");
    }
    capabilityInput[key] = args[index + 1] === "true";
    index += 1;
  }
  if (packetPath === null) throw new TypeError("dispatch command requires --packet <owned-temp-json>");
  return { packetPath, consume, capabilityInput };
}

function output(value) {
  process.stdout.write(`${JSON.stringify(redactSensitive(value))}\n`);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

async function dispatchPolicy() {
  return loadDispatchPolicy(join(CODEX_HOME, DISPATCH_POLICY_RELATIVE_PATH));
}

async function activeManifestEvidence(policy) {
  const activation = policy?.activation;
  try {
    if (policy?.mode !== "active" || policy?.allowTypedBridge !== false) return null;
    const manifestPath = activation?.manifestPath;
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) return null;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const repositoryRootInput = typeof manifest?.activation?.repositoryRoot === "string"
      ? resolve(manifest.activation.repositoryRoot)
      : null;
    const repositoryRoot = repositoryRootInput ? await realpath(repositoryRootInput) : null;
    const reportsRoot = repositoryRoot ? await realpath(join(repositoryRoot, "reports")) : null;
    const actual = await realpath(manifestPath);
    const fromReports = reportsRoot ? relative(reportsRoot, actual) : null;
    const fromRepositoryInput = repositoryRootInput ? relative(repositoryRootInput, resolve(manifestPath)) : null;
    const expectedActual = repositoryRoot && fromRepositoryInput !== null
      ? resolve(repositoryRoot, fromRepositoryInput)
      : null;
    if (!repositoryRoot || !reportsRoot || reportsRoot !== join(repositoryRoot, "reports") || actual !== expectedActual ||
      fromReports === null || fromReports === "" || fromReports === ".." || fromReports.startsWith(`..${sep}`)) return null;
    if (
      manifest.status !== "applied" ||
      manifest.activation?.installId !== activation.installId ||
      manifest.activation?.manifestPath !== manifestPath ||
      manifest.activation?.policySha256 !== policy.sha256 ||
      !/^[a-f0-9]{64}$/.test(
        manifest.activation?.acceptanceBindingSha256 ?? "",
      ) ||
      !/^[a-f0-9]{64}$/.test(
        manifest.activation?.writingSkillsEvidenceSha256 ?? "",
      )
    ) return null;
    if (manifest.staticChecks === null || typeof manifest.staticChecks !== "object" ||
      !["strictConfig", "configLoad", "mcpConfig", "installation"].every((key) => manifest.staticChecks[key] === true)) return null;
    if (manifest.postInstallRootSmoke?.pass !== true ||
      !validatePostInstallRootRuntime(
        manifest.postInstallRootSmoke?.actual,
        { active: true },
      ).pass) return null;
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) return null;

    const installedDigest = async (path, mode, expectedHashes) => {
      if (!Number.isInteger(mode) || (mode & 0o022) !== 0 ||
        !Array.isArray(expectedHashes) || expectedHashes.length === 0) return null;
      const installed = await lstat(path);
      if (!installed.isFile() || installed.isSymbolicLink() || (installed.mode & 0o777) !== mode) return null;
      const digest = sha256(await readFile(path));
      return expectedHashes.every((value) => value === digest) ? digest : null;
    };

    if (manifest.config?.path !== join(CODEX_HOME, "config.toml") ||
      manifest.agents?.path !== join(CODEX_HOME, "AGENTS.md")) return null;
    const configSha256 = await installedDigest(
      manifest.config.path,
      manifest.config.mode,
      [manifest.config.afterSha256],
    );
    const agentsSha256 = await installedDigest(
      manifest.agents.path,
      manifest.agents.mode,
      [manifest.agents.afterSha256],
    );
    if (configSha256 === null || agentsSha256 === null) return null;

    const roleFiles = manifest.files.filter((entry) => entry?.kind === "role");
    if (roleFiles.length !== ROLE_SPECS.length) return null;
    const roleHashes = {};
    for (const spec of ROLE_SPECS) {
      const targetPath = join(CODEX_HOME, "agents", spec.installFile);
      const matches = roleFiles.filter((entry) =>
        entry.role === spec.name && entry.targetPath === targetPath,
      );
      if (matches.length !== 1) return null;
      const [entry] = matches;
      if (entry.sourcePath !== join(repositoryRootInput, "roles", spec.sourceFile)) return null;
      const digest = await installedDigest(targetPath, 0o644, [entry.afterSha256]);
      if (digest === null) return null;
      roleHashes[spec.name] = digest;
    }

    const launcherPath = join(CODEX_HOME, "bin", "codex-typed-agent");
    const launcherFiles = manifest.files.filter((entry) =>
      entry?.kind === "launcher" && entry.targetPath === launcherPath,
    );
    if (launcherFiles.length !== 1) return null;
    const [launcher] = launcherFiles;
    if (launcher.sourcePath !== join(repositoryRootInput, "scripts", "codex-typed-agent") ||
      launcher.mode !== 0o755) return null;
    const launcherSha256 = await installedDigest(
      launcherPath,
      0o755,
      [launcher.sourceSha256, launcher.targetSha256, launcher.afterSha256],
    );
    if (launcherSha256 === null) return null;

    const expected = [
      {
        kind: "dispatch-policy",
        sourcePath: null,
        targetPath: join(CODEX_HOME, DISPATCH_POLICY_RELATIVE_PATH),
        mode: 0o600,
        publicPath: null,
      },
      ...DISPATCH_RUNTIME_FILES.map((path) => ({
        kind: "dispatch-runtime",
        sourcePath: join(repositoryRootInput, path),
        targetPath: join(CODEX_HOME, "gearbox", "runtime", path),
        mode: 0o644,
        publicPath: path,
      })),
      {
        kind: "dispatch-wrapper",
        sourcePath: join(repositoryRootInput, "scripts", "gearbox-dispatch"),
        targetPath: join(CODEX_HOME, "bin", "gearbox-dispatch"),
        mode: 0o755,
        publicPath: "scripts/gearbox-dispatch",
      },
    ];
    const dispatchFiles = manifest.files.filter((entry) => entry?.kind?.startsWith("dispatch-"));
    if (dispatchFiles.length !== expected.length) return null;
    const runtimeHashes = {};
    for (const wanted of expected) {
      const matches = dispatchFiles.filter((entry) =>
        entry.kind === wanted.kind && entry.targetPath === wanted.targetPath,
      );
      if (matches.length !== 1) return null;
      const [entry] = matches;
      if (entry.sourcePath !== wanted.sourcePath || entry.mode !== wanted.mode) return null;
      const digest = await installedDigest(
        wanted.targetPath,
        wanted.mode,
        [entry.sourceSha256, entry.targetSha256, entry.afterSha256],
      );
      if (digest === null) return null;
      if (wanted.kind === "dispatch-policy" && entry.policyMode !== "active") return null;
      if (wanted.publicPath !== null) runtimeHashes[wanted.publicPath] = digest;
    }
    return {
      integrity: "pass",
      allowTypedBridge: false,
      policySha256: policy.sha256,
      configSha256,
      agentsSha256,
      roleHashes,
      launcherSha256,
      runtimeHashes,
    };
  } catch {
    return null;
  }
}

function safeScopePath(scope) {
  return (
    typeof scope === "string" &&
    scope.length > 0 &&
    !isAbsolute(scope) &&
    !scope.split(/[\\/]/).some((part) => part.length === 0 || part === "." || part === "..")
  );
}

async function copyScopedEntry(source, target) {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) throw new TypeError("read scope must not contain symlinks");
  if (metadata.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    for (const name of (await readdir(source)).sort()) {
      await copyScopedEntry(join(source, name), join(target, name));
    }
    return;
  }
  if (!metadata.isFile()) throw new TypeError("read scope must contain only regular files and directories");
  await atomicWrite(target, await readFile(source), 0o600);
}

async function materializeReadScope(readScope) {
  const sourceRoot = await realpath(process.cwd());
  const rootMetadata = await lstat(sourceRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new TypeError("dispatch source workspace must be a physical directory");
  }
  if (!Array.isArray(readScope) || readScope.length === 0 || !readScope.every(safeScopePath)) {
    throw new TypeError("dispatch read scope must contain explicit relative paths");
  }
  const workspace = await mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-scope-dispatch-"));
  try {
    for (const scope of [...new Set(readScope)].sort()) {
      const source = resolve(sourceRoot, scope);
      const withinRoot = relative(sourceRoot, source);
      if (withinRoot === "" || withinRoot === ".." || withinRoot.startsWith(`..${sep}`)) {
        throw new TypeError("dispatch read scope escapes source workspace");
      }
      const canonicalSource = await realpath(source);
      const canonicalWithinRoot = relative(sourceRoot, canonicalSource);
      if (
        canonicalSource !== source ||
        canonicalWithinRoot === "" ||
        canonicalWithinRoot === ".." ||
        canonicalWithinRoot.startsWith(`..${sep}`)
      ) {
        throw new TypeError("dispatch read scope must not traverse symlinks");
      }
      await copyScopedEntry(source, join(workspace, scope));
    }
    return workspace;
  } catch (error) {
    await cleanupProbeArtifacts([workspace]);
    throw error;
  }
}

async function main() {
  const [, , command, ...args] = process.argv;
  const loaded = await dispatchPolicy();
  const activeEvidence = loaded.state === "active"
    ? await activeManifestEvidence(loaded.policy)
    : null;
  if (loaded.state === "off" || (loaded.state === "active" && activeEvidence === null)) {
    output(off());
    process.exitCode = 1;
    return;
  }
  if (command === "status" && args.length === 0) {
    output({
      status: `GEARBOX_DISPATCH_${loaded.state.toUpperCase()}`,
      mode: loaded.state,
      ...(activeEvidence ?? {}),
    });
    return;
  }
  if (command !== "plan" && command !== "run-isolated" && command !== "workflow-next") throw new TypeError("unknown dispatch command");

  const { packetPath, consume, capabilityInput } = parsePacketArguments(args);
  const packet = await readOwnedPacket(packetPath, { consume });
  const capabilities = {
    agentTypeVisible: capabilityInput.agentTypeVisible === true,
    isolatedRunnerVerified: capabilityInput.isolatedRunnerVerified === true,
    runtimeMetadataAvailable: capabilityInput.runtimeMetadataAvailable === true,
    bridgeRuntimeVerified: false,
    permissionBypassActive: capabilityInput.permissionsEnforced !== true,
  };
  if (command === "workflow-next") {
    const result = await runWorkflowNext({
      envelope: packet,
      policy: loaded.policy,
      capabilities,
      roleSpecs: ROLE_SPECS,
      cwd: process.cwd(),
    });
    output({
      status: result.status,
      mode: result.mode,
      source: result.source,
      rollbackRequired: result.rollbackRequired,
      ...(result.public ? { public: result.public } : {}),
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
    });
    if (result.status === "GEARBOX_WORKFLOW_BLOCKED") process.exitCode = 1;
    return;
  }
  const decision = planDispatch({
    policy: loaded.policy,
    packet,
    capabilities,
    roleSpecs: ROLE_SPECS,
  });
  if (command === "plan") {
    output({ status: "GEARBOX_DISPATCH_PLAN", mode: loaded.state, decision });
    return;
  }
  if (decision.effectiveShape !== "isolated_role_root") {
    output({ status: "GEARBOX_DISPATCH_NOT_ISOLATED", mode: loaded.state, decision });
    process.exitCode = 1;
    return;
  }
  const roleSpec = ROLE_SPECS.find((role) => role.name === decision.role);
  if (!roleSpec) throw new TypeError("isolated role is not installed");
  const roleSource = await readFile(join(CODEX_HOME, "agents", roleSpec.installFile), "utf8");
  const task = JSON.stringify(stable(packet));
  if (sha256(task) !== decision.taskHash) throw new TypeError("dispatch task packet hash mismatch");
  let deliverable = null;
  const scopedWorkspace = await materializeReadScope(packet.readScope);
  let result;
  let scopedCleanupPassed = false;
  try {
    result = await runIsolatedRole({
      codexBin: process.env.CODEX_BIN ?? "codex",
      codexHome: CODEX_HOME,
      roleSpec,
      roleSource,
      cwd: scopedWorkspace,
      task,
      taskHash: decision.taskHash,
      reasonCode: decision.reasonCode,
      onDeliverable: async (value) => {
        deliverable = value;
        return true;
      },
    });
  } finally {
    try {
      await cleanupProbeArtifacts([scopedWorkspace]);
      scopedCleanupPassed = true;
    } catch {
      scopedCleanupPassed = false;
    }
  }
  if (!scopedCleanupPassed) {
    result.checks.cleanupPassed = false;
    result.pass = false;
    result.rollbackRequired = true;
  }
  const resultValidation = validateDispatchResult({ result, decision, roleSpec });
  if (result.pass !== true || !resultValidation.pass) {
    output({ status: "GEARBOX_DISPATCH_REJECTED", mode: loaded.state, decision, result });
    process.exitCode = 1;
    return;
  }
  output({ status: "GEARBOX_DISPATCH_RESULT", mode: loaded.state, decision, result, deliverable });
}

main().catch(() => {
  output(off());
  process.exitCode = 1;
});
