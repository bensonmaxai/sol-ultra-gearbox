#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readdir, realpath, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  activeActivationRecordPath,
  atomicWrite,
  cleanupProbeArtifacts,
  DISPATCH_RUNTIME_FILES,
  ROLE_SPECS,
  readCurrentWorkflowContractEvidence,
  redactSensitive,
  sha256,
  validateActiveConfigIntegrity,
  validatePostInstallRootRuntime,
  validateActiveActivationRecord,
} from "../lib/gearbox.mjs";
import { planDispatch } from "../lib/dispatch-planner.mjs";
import { validateDispatchResult } from "../lib/dispatch-evidence.mjs";
import { DISPATCH_POLICY_RELATIVE_PATH, loadDispatchPolicy } from "../lib/dispatch-policy.mjs";
import { runIsolatedRole } from "../lib/dispatch-runner.mjs";
import { readOwnedPacket } from "../lib/owned-packet.mjs";
import { runWorkflowNext, workflowOutputIsUnsafe } from "../lib/workflow-cli.mjs";

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const LEGACY_DISPATCH_RUNTIME_FILES = Object.freeze(
  DISPATCH_RUNTIME_FILES.filter((path) => path !== "docs/workflow-contract-evidence.json"),
);

const INTEGRITY_COMPONENTS = Object.freeze([
  "policy",
  "manifest",
  "config",
  "agents",
  "roles",
  "launcher",
  "runtime",
  "permissions",
]);

function emptyIntegrityBreakdown() {
  return Object.fromEntries(
    INTEGRITY_COMPONENTS.map((component) => [
      component,
      { status: "not_checked", reasonCode: "NOT_CHECKED" },
    ]),
  );
}

function off(reasonCode = "DISPATCH_COMMAND_FAILED", integrityBreakdown = null) {
  return {
    status: "GEARBOX_DISPATCH_OFF",
    mode: "off",
    reasonCode,
    integrity: "fail",
    integrityBreakdown: integrityBreakdown ?? emptyIntegrityBreakdown(),
  };
}

function policyOffReason(error) {
  if (typeof error !== "string") return "POLICY_READ_FAILED";
  if (error.startsWith("missing dispatch policy")) return "POLICY_MISSING";
  if (error.startsWith("unable to parse")) return "POLICY_PARSE_FAILED";
  if (error.startsWith("dispatch policy integrity failed")) {
    return "POLICY_INTEGRITY_FAILED";
  }
  return "POLICY_READ_FAILED";
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

function outputWorkflow(value) {
  if (workflowOutputIsUnsafe(value)) throw new TypeError("workflow output contains unsafe content");
  process.stdout.write(`${JSON.stringify(value)}\n`);
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

async function activeRecordEvidence(policy) {
  const integrityBreakdown = emptyIntegrityBreakdown();
  const pass = (component, reasonCode, checks = undefined, observations = undefined) => {
    integrityBreakdown[component] = {
      status: "pass",
      reasonCode,
      ...(checks === undefined ? {} : { checks }),
      ...(observations === undefined ? {} : { observations }),
    };
  };
  const failure = (component, reasonCode, {
    checks = undefined,
    permissionRelated = false,
  } = {}) => {
    integrityBreakdown[component] = {
      status: "fail",
      reasonCode,
      ...(checks === undefined ? {} : { checks }),
    };
    if (permissionRelated && component !== "permissions") {
      integrityBreakdown.permissions = { status: "fail", reasonCode };
    }
    return { pass: false, reasonCode, integrityBreakdown, evidence: null };
  };
  let currentComponent = "policy";
  const activation = policy?.activation;
  try {
    if (policy?.mode !== "active" || policy?.allowTypedBridge !== false ||
      typeof activation?.recordPath !== "string") {
      return failure("policy", "POLICY_ACTIVE_CONTRACT_DRIFT");
    }
    pass("policy", "POLICY_INTEGRITY_PASS");
    currentComponent = "manifest";
    const recordPath = activeActivationRecordPath(CODEX_HOME, activation.installId);
    if (activation.recordPath !== recordPath) {
      return failure("manifest", "ACTIVATION_RECORD_IDENTITY_DRIFT");
    }
    const [directoryMetadata, metadata] = await Promise.all([
      lstat(dirname(recordPath)),
      lstat(recordPath),
    ]);
    const physicalCodexHome = await realpath(CODEX_HOME);
    const physicalRecordPath = await realpath(recordPath);
    const expectedPhysicalRecordPath = join(
      physicalCodexHome,
      relative(CODEX_HOME, recordPath),
    );
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
      (directoryMetadata.mode & 0o777) !== 0o700 ||
      !metadata.isFile() || metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o600 ||
      physicalRecordPath !== expectedPhysicalRecordPath) {
      return failure("manifest", "ACTIVATION_RECORD_PERMISSION_DRIFT", {
        permissionRelated: true,
      });
    }
    const recordSource = await readFile(recordPath, "utf8");
    const record = JSON.parse(recordSource);
    if (!validateActiveActivationRecord(record, { codexHome: CODEX_HOME, policy }).pass) {
      return failure("manifest", "ACTIVATION_RECORD_IDENTITY_DRIFT");
    }
    pass("manifest", "ACTIVATION_RECORD_INTEGRITY_PASS");

    const installedDigest = async (path, mode, expectedHashes = null) => {
      if (!Number.isInteger(mode) || (mode & 0o022) !== 0 ||
        !(expectedHashes === null || (Array.isArray(expectedHashes) && expectedHashes.length > 0))) {
        return {
          pass: false,
          digest: null,
          checks: { declarationValid: false, regularFile: false, modeMatches: false, digestMatches: false },
        };
      }
      const installed = await lstat(path);
      const regularFile = installed.isFile() && !installed.isSymbolicLink();
      const modeMatches = (installed.mode & 0o777) === mode;
      if (!regularFile || !modeMatches) {
        return {
          pass: false,
          digest: null,
          checks: { declarationValid: true, regularFile, modeMatches, digestMatches: false },
        };
      }
      const digest = sha256(await readFile(path));
      const digestMatches = expectedHashes === null ||
        expectedHashes.every((expectedHash) => expectedHash === digest);
      return {
        pass: digestMatches,
        digest,
        checks: { declarationValid: true, regularFile, modeMatches, digestMatches },
      };
    };

    currentComponent = "config";
    const configInstalled = await installedDigest(
      record.config.path,
      record.config.mode,
      null,
    );
    if (!configInstalled.pass) {
      return failure("config", "CONFIG_FILE_PERMISSION_DRIFT", {
        checks: configInstalled.checks,
        permissionRelated: true,
      });
    }
    const configIntegrity = validateActiveConfigIntegrity(
      await readFile(record.config.path, "utf8"),
      CODEX_HOME,
      record.config.integrity ?? null,
    );
    if (!configIntegrity.pass) {
      return failure("config", configIntegrity.reasonCode, {
        checks: configIntegrity.checks,
        permissionRelated: configIntegrity.reasonCode === "CONFIG_SAFETY_SEMANTIC_DRIFT",
      });
    }
    if (record.config.integrity == null) {
      const rootModelEffortMatchActivation =
        configIntegrity.semanticSettings.model === record.postInstallRootSmoke.actual.model &&
        configIntegrity.semanticSettings.modelReasoningEffort ===
          record.postInstallRootSmoke.actual.effort;
      configIntegrity.checks.rootModelEffortMatchActivation = rootModelEffortMatchActivation;
      if (!rootModelEffortMatchActivation) {
        return failure("config", "CONFIG_SAFETY_SEMANTIC_DRIFT", {
          checks: configIntegrity.checks,
          permissionRelated: true,
        });
      }
    }
    const configIntegritySha256 = sha256(JSON.stringify(stable({
      managedBlockSha256: configIntegrity.managedBlockSha256,
      semanticSettings: configIntegrity.semanticSettings,
    })));
    pass("config", configIntegrity.reasonCode, configIntegrity.checks, {
      scope: configIntegrity.scope,
      wholeFileMatchesActivation: configInstalled.digest === record.config.afterSha256,
    });

    currentComponent = "agents";
    const agentsInstalled = await installedDigest(
      record.agents.path,
      record.agents.mode,
      [record.agents.afterSha256],
    );
    if (!agentsInstalled.pass) {
      return failure("agents", "AGENTS_POLICY_INTEGRITY_DRIFT", {
        checks: agentsInstalled.checks,
        permissionRelated: !agentsInstalled.checks.modeMatches,
      });
    }
    pass("agents", "AGENTS_POLICY_INTEGRITY_PASS", agentsInstalled.checks);

    currentComponent = "roles";
    const roleFiles = record.files.filter((entry) => entry.kind === "role");
    if (roleFiles.length !== ROLE_SPECS.length) {
      return failure("roles", "ROLE_INVENTORY_DRIFT");
    }
    const roleHashes = {};
    for (const spec of ROLE_SPECS) {
      const targetPath = join(CODEX_HOME, "agents", spec.installFile);
      const matches = roleFiles.filter((entry) =>
        entry.role === spec.name && entry.targetPath === targetPath && entry.mode === 0o644,
      );
      if (matches.length !== 1) return failure("roles", "ROLE_INVENTORY_DRIFT");
      const installed = await installedDigest(targetPath, 0o644, [matches[0].afterSha256]);
      if (!installed.pass) {
        return failure("roles", "ROLE_FILE_INTEGRITY_DRIFT", {
          checks: installed.checks,
          permissionRelated: !installed.checks.modeMatches,
        });
      }
      roleHashes[spec.name] = installed.digest;
    }
    pass("roles", "ROLE_INTEGRITY_PASS", { completeInventory: true, exactFiles: true });

    currentComponent = "launcher";
    const launcherPath = join(CODEX_HOME, "bin", "codex-typed-agent");
    const launcherFiles = record.files.filter((entry) =>
      entry.kind === "launcher" && entry.targetPath === launcherPath && entry.mode === 0o755,
    );
    if (launcherFiles.length !== 1) {
      return failure("launcher", "LAUNCHER_INVENTORY_DRIFT");
    }
    const launcherSha256 = await installedDigest(
      launcherPath,
      0o755,
      [launcherFiles[0].afterSha256],
    );
    if (!launcherSha256.pass) {
      return failure("launcher", "LAUNCHER_INTEGRITY_DRIFT", {
        checks: launcherSha256.checks,
        permissionRelated: !launcherSha256.checks.modeMatches,
      });
    }
    pass("launcher", "LAUNCHER_INTEGRITY_PASS", launcherSha256.checks);

    currentComponent = "runtime";
    const expected = [
      {
        kind: "dispatch-policy",
        targetPath: join(CODEX_HOME, DISPATCH_POLICY_RELATIVE_PATH),
        mode: 0o600,
        publicPath: null,
      },
      ...DISPATCH_RUNTIME_FILES.map((path) => ({
        kind: "dispatch-runtime",
        targetPath: join(CODEX_HOME, "gearbox", "runtime", path),
        mode: 0o644,
        publicPath: path,
      })),
      {
        kind: "dispatch-wrapper",
        targetPath: join(CODEX_HOME, "bin", "gearbox-dispatch"),
        mode: 0o755,
        publicPath: "scripts/gearbox-dispatch",
      },
    ];
    const dispatchFiles = record.files.filter((entry) => entry.kind.startsWith("dispatch-"));
    if (dispatchFiles.length !== expected.length) {
      return failure("runtime", "RUNTIME_INVENTORY_DRIFT");
    }
    const runtimeHashes = {};
    for (const wanted of expected) {
      const matches = dispatchFiles.filter((entry) =>
        entry.kind === wanted.kind && entry.targetPath === wanted.targetPath && entry.mode === wanted.mode,
      );
      if (matches.length !== 1) return failure("runtime", "RUNTIME_INVENTORY_DRIFT");
      const entry = matches[0];
      if (wanted.kind === "dispatch-policy" && entry.policyMode !== "active") {
        return failure("policy", "POLICY_MODE_DRIFT");
      }
      const installed = await installedDigest(
        wanted.targetPath,
        wanted.mode,
        [entry.afterSha256],
      );
      if (!installed.pass) {
        return failure(
          wanted.kind === "dispatch-policy" ? "policy" : "runtime",
          wanted.kind === "dispatch-policy"
            ? "POLICY_FILE_INTEGRITY_DRIFT"
            : "RUNTIME_FILE_INTEGRITY_DRIFT",
          {
            checks: installed.checks,
            permissionRelated: !installed.checks.modeMatches,
          },
        );
      }
      if (wanted.publicPath !== null) runtimeHashes[wanted.publicPath] = installed.digest;
    }
    if (runtimeHashes["docs/workflow-contract-evidence.json"] !==
      record.activation.workflowContractEvidenceSha256) {
      return failure("runtime", "WORKFLOW_CONTRACT_EVIDENCE_DRIFT");
    }
    pass("runtime", "RUNTIME_INTEGRITY_PASS", {
      completeInventory: true,
      coreInventoryPresent: true,
      installedFileCount: DISPATCH_RUNTIME_FILES.length,
    });
    pass("permissions", "PERMISSION_INTEGRITY_PASS");

    return { pass: true, reasonCode: "ACTIVE_SCOPED_INTEGRITY_PASS", integrityBreakdown, evidence: {
      integrity: "pass",
      reasonCode: "ACTIVE_SCOPED_INTEGRITY_PASS",
      integrityBreakdown,
      allowTypedBridge: false,
      policySha256: policy.sha256,
      activationRecordSha256: sha256(recordSource),
      configSha256: configInstalled.digest,
      configIntegritySha256,
      configIntegrityScope: configIntegrity.scope,
      agentsSha256: agentsInstalled.digest,
      roleHashes,
      launcherSha256: launcherSha256.digest,
      runtimeHashes,
    } };
  } catch {
    return failure(currentComponent, "ACTIVE_INTEGRITY_READ_FAILED");
  }
}

async function legacyActiveManifestEvidence(policy) {
  const integrityBreakdown = emptyIntegrityBreakdown();
  const pass = (component, reasonCode, checks = undefined, observations = undefined) => {
    integrityBreakdown[component] = {
      status: "pass",
      reasonCode,
      ...(checks === undefined ? {} : { checks }),
      ...(observations === undefined ? {} : { observations }),
    };
  };
  const failure = (component, reasonCode, {
    checks = undefined,
    permissionRelated = false,
  } = {}) => {
    integrityBreakdown[component] = {
      status: "fail",
      reasonCode,
      ...(checks === undefined ? {} : { checks }),
    };
    if (permissionRelated && component !== "permissions") {
      integrityBreakdown.permissions = {
        status: "fail",
        reasonCode,
      };
    }
    return { pass: false, reasonCode, integrityBreakdown, evidence: null };
  };
  let currentComponent = "policy";
  const activation = policy?.activation;
  try {
    if (policy?.mode !== "active" || policy?.allowTypedBridge !== false) {
      return failure("policy", "POLICY_ACTIVE_CONTRACT_DRIFT");
    }
    pass("policy", "POLICY_INTEGRITY_PASS");
    currentComponent = "manifest";
    const manifestPath = activation?.manifestPath;
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o022) !== 0) {
      return failure("manifest", "ACTIVATION_MANIFEST_PERMISSION_DRIFT", {
        permissionRelated: true,
      });
    }
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
      fromReports === null || fromReports === "" || fromReports === ".." || fromReports.startsWith(`..${sep}`)) {
      return failure("manifest", "ACTIVATION_MANIFEST_SCOPE_DRIFT");
    }
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
      ) ||
      !/^[a-f0-9]{64}$/.test(
        manifest.activation?.workflowContractEvidenceSha256 ?? "",
      )
    ) return failure("manifest", "ACTIVATION_MANIFEST_IDENTITY_DRIFT");
    const workflowContract = await readCurrentWorkflowContractEvidence(repositoryRoot);
    if (
      workflowContract.sha256 !==
      manifest.activation.workflowContractEvidenceSha256
    ) return failure("manifest", "WORKFLOW_CONTRACT_EVIDENCE_DRIFT");
    if (manifest.staticChecks === null || typeof manifest.staticChecks !== "object" ||
      !["strictConfig", "configLoad", "mcpConfig", "installation"].every((key) => manifest.staticChecks[key] === true)) {
      return failure("manifest", "ACTIVATION_STATIC_EVIDENCE_DRIFT");
    }
    if (manifest.postInstallRootSmoke?.pass !== true ||
      !validatePostInstallRootRuntime(
        manifest.postInstallRootSmoke?.actual,
        { active: true },
      ).pass) return failure("manifest", "ACTIVATION_ROOT_EVIDENCE_DRIFT");
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
      return failure("manifest", "ACTIVATION_MANIFEST_SCHEMA_DRIFT");
    }
    pass("manifest", "ACTIVATION_MANIFEST_PASS");

    const installedDigest = async (path, mode, expectedHashes) => {
      if (!Number.isInteger(mode) || (mode & 0o022) !== 0 ||
        !(expectedHashes === null || (Array.isArray(expectedHashes) && expectedHashes.length > 0))) {
        return {
          pass: false,
          digest: null,
          checks: { declarationValid: false, regularFile: false, modeMatches: false, digestMatches: false },
        };
      }
      const installed = await lstat(path);
      const regularFile = installed.isFile() && !installed.isSymbolicLink();
      const modeMatches = (installed.mode & 0o777) === mode;
      if (!regularFile || !modeMatches) {
        return {
          pass: false,
          digest: null,
          checks: { declarationValid: true, regularFile, modeMatches, digestMatches: false },
        };
      }
      const digest = sha256(await readFile(path));
      const digestMatches = expectedHashes === null ||
        expectedHashes.every((value) => value === digest);
      return {
        pass: digestMatches,
        digest,
        checks: { declarationValid: true, regularFile, modeMatches, digestMatches },
      };
    };

    if (manifest.config?.path !== join(CODEX_HOME, "config.toml") ||
      manifest.agents?.path !== join(CODEX_HOME, "AGENTS.md")) {
      return failure("manifest", "ACTIVATION_TARGET_IDENTITY_DRIFT");
    }
    currentComponent = "config";
    const configInstalled = await installedDigest(
      manifest.config.path,
      manifest.config.mode,
      null,
    );
    if (!configInstalled.pass) {
      return failure("config", "CONFIG_FILE_PERMISSION_DRIFT", {
        checks: configInstalled.checks,
        permissionRelated: true,
      });
    }
    const configSource = await readFile(manifest.config.path, "utf8");
    const configIntegrity = validateActiveConfigIntegrity(
      configSource,
      CODEX_HOME,
      manifest.config.integrity ?? null,
    );
    if (!configIntegrity.pass) {
      return failure("config", configIntegrity.reasonCode, {
        checks: configIntegrity.checks,
        permissionRelated: configIntegrity.reasonCode === "CONFIG_SAFETY_SEMANTIC_DRIFT",
      });
    }
    if (manifest.config.integrity == null) {
      const rootModelEffortMatchActivation =
        configIntegrity.semanticSettings.model === manifest.postInstallRootSmoke.actual.model &&
        configIntegrity.semanticSettings.modelReasoningEffort ===
          manifest.postInstallRootSmoke.actual.effort;
      configIntegrity.checks.rootModelEffortMatchActivation =
        rootModelEffortMatchActivation;
      if (!rootModelEffortMatchActivation) {
        return failure("config", "CONFIG_SAFETY_SEMANTIC_DRIFT", {
          checks: configIntegrity.checks,
          permissionRelated: true,
        });
      }
    }
    const configIntegritySha256 = sha256(JSON.stringify(stable({
      managedBlockSha256: configIntegrity.managedBlockSha256,
      semanticSettings: configIntegrity.semanticSettings,
    })));
    pass(
      "config",
      configIntegrity.reasonCode,
      configIntegrity.checks,
      {
        scope: configIntegrity.scope,
        wholeFileMatchesActivation: configInstalled.digest === manifest.config.afterSha256,
      },
    );

    currentComponent = "agents";
    const agentsInstalled = await installedDigest(
      manifest.agents.path,
      manifest.agents.mode,
      [manifest.agents.afterSha256],
    );
    if (!agentsInstalled.pass) {
      return failure("agents", "AGENTS_POLICY_INTEGRITY_DRIFT", {
        checks: agentsInstalled.checks,
        permissionRelated: !agentsInstalled.checks.modeMatches,
      });
    }
    pass("agents", "AGENTS_POLICY_INTEGRITY_PASS", agentsInstalled.checks);

    currentComponent = "roles";
    const roleFiles = manifest.files.filter((entry) => entry?.kind === "role");
    if (roleFiles.length !== ROLE_SPECS.length) {
      return failure("roles", "ROLE_INVENTORY_DRIFT");
    }
    const roleHashes = {};
    for (const spec of ROLE_SPECS) {
      const targetPath = join(CODEX_HOME, "agents", spec.installFile);
      const matches = roleFiles.filter((entry) =>
        entry.role === spec.name && entry.targetPath === targetPath,
      );
      if (matches.length !== 1) return failure("roles", "ROLE_INVENTORY_DRIFT");
      const [entry] = matches;
      if (entry.sourcePath !== join(repositoryRootInput, "roles", spec.sourceFile)) {
        return failure("roles", "ROLE_SOURCE_IDENTITY_DRIFT");
      }
      const installed = await installedDigest(targetPath, 0o644, [entry.afterSha256]);
      if (!installed.pass) {
        return failure("roles", "ROLE_FILE_INTEGRITY_DRIFT", {
          checks: installed.checks,
          permissionRelated: !installed.checks.modeMatches,
        });
      }
      roleHashes[spec.name] = installed.digest;
    }
    pass("roles", "ROLE_INTEGRITY_PASS", { completeInventory: true, exactFiles: true });

    currentComponent = "launcher";
    const launcherPath = join(CODEX_HOME, "bin", "codex-typed-agent");
    const launcherFiles = manifest.files.filter((entry) =>
      entry?.kind === "launcher" && entry.targetPath === launcherPath,
    );
    if (launcherFiles.length !== 1) return failure("launcher", "LAUNCHER_INVENTORY_DRIFT");
    const [launcher] = launcherFiles;
    if (launcher.sourcePath !== join(repositoryRootInput, "scripts", "codex-typed-agent") ||
      launcher.mode !== 0o755) return failure("launcher", "LAUNCHER_IDENTITY_DRIFT");
    const launcherInstalled = await installedDigest(
      launcherPath,
      0o755,
      [launcher.sourceSha256, launcher.targetSha256, launcher.afterSha256],
    );
    if (!launcherInstalled.pass) {
      return failure("launcher", "LAUNCHER_INTEGRITY_DRIFT", {
        checks: launcherInstalled.checks,
        permissionRelated: !launcherInstalled.checks.modeMatches,
      });
    }
    pass("launcher", "LAUNCHER_INTEGRITY_PASS", launcherInstalled.checks);

    currentComponent = "runtime";
    const workflowContractRuntimePath = join(
      CODEX_HOME,
      "gearbox",
      "runtime",
      "docs/workflow-contract-evidence.json",
    );
    const requiredRuntimeInventory = manifest.files.some((entry) =>
      entry?.kind === "dispatch-runtime" && entry.targetPath === workflowContractRuntimePath,
    ) ? DISPATCH_RUNTIME_FILES : LEGACY_DISPATCH_RUNTIME_FILES;
    const dispatchFiles = manifest.files.filter((entry) => entry?.kind?.startsWith("dispatch-"));
    const policyFiles = dispatchFiles.filter((entry) => entry.kind === "dispatch-policy");
    const runtimeFiles = dispatchFiles.filter((entry) => entry.kind === "dispatch-runtime");
    const wrapperFiles = dispatchFiles.filter((entry) => entry.kind === "dispatch-wrapper");
    if (
      policyFiles.length !== 1 ||
      wrapperFiles.length !== 1 ||
      runtimeFiles.length < requiredRuntimeInventory.length ||
      dispatchFiles.length !== policyFiles.length + runtimeFiles.length + wrapperFiles.length
    ) {
      return failure("runtime", "RUNTIME_INVENTORY_DRIFT");
    }
    const runtimeHashes = {};

    const [policyFile] = policyFiles;
    if (
      policyFile.sourcePath !== null ||
      policyFile.targetPath !== join(CODEX_HOME, DISPATCH_POLICY_RELATIVE_PATH) ||
      policyFile.mode !== 0o600
    ) return failure("policy", "POLICY_FILE_IDENTITY_DRIFT");
    const policyInstalled = await installedDigest(
      policyFile.targetPath,
      policyFile.mode,
      [policyFile.sourceSha256, policyFile.targetSha256, policyFile.afterSha256],
    );
    if (!policyInstalled.pass) {
      return failure("policy", "POLICY_FILE_INTEGRITY_DRIFT", {
        checks: policyInstalled.checks,
        permissionRelated: !policyInstalled.checks.modeMatches,
      });
    }
    if (policyFile.policyMode !== "active") {
      return failure("policy", "POLICY_MODE_DRIFT");
    }

    const runtimePaths = new Set();
    for (const entry of runtimeFiles) {
      const sourceRelative = relative(repositoryRootInput, entry.sourcePath ?? "");
      const safeRelative = (
        safeScopePath(sourceRelative) &&
        (
          (sourceRelative.endsWith(".mjs") &&
            (sourceRelative.startsWith(`lib${sep}`) || sourceRelative.startsWith(`scripts${sep}`))) ||
          sourceRelative === "docs/workflow-contract-evidence.json"
        )
      );
      if (
        !safeRelative ||
        resolve(repositoryRootInput, sourceRelative) !== entry.sourcePath ||
        entry.targetPath !== join(CODEX_HOME, "gearbox", "runtime", sourceRelative) ||
        entry.mode !== 0o644 ||
        runtimePaths.has(sourceRelative)
      ) {
        return failure("runtime", "RUNTIME_SOURCE_IDENTITY_DRIFT");
      }
      runtimePaths.add(sourceRelative);
      const installed = await installedDigest(
        entry.targetPath,
        entry.mode,
        [entry.sourceSha256, entry.targetSha256, entry.afterSha256],
      );
      if (!installed.pass) {
        return failure("runtime", "RUNTIME_FILE_INTEGRITY_DRIFT", {
          checks: installed.checks,
          permissionRelated: !installed.checks.modeMatches,
        });
      }
      runtimeHashes[sourceRelative] = installed.digest;
    }
    if (!requiredRuntimeInventory.every((path) => runtimePaths.has(path))) {
      return failure("runtime", "RUNTIME_CORE_INVENTORY_DRIFT");
    }

    const [wrapperFile] = wrapperFiles;
    if (
      wrapperFile.sourcePath !== join(repositoryRootInput, "scripts", "gearbox-dispatch") ||
      wrapperFile.targetPath !== join(CODEX_HOME, "bin", "gearbox-dispatch") ||
      wrapperFile.mode !== 0o755
    ) return failure("runtime", "RUNTIME_WRAPPER_IDENTITY_DRIFT");
    const wrapperInstalled = await installedDigest(
      wrapperFile.targetPath,
      wrapperFile.mode,
      [wrapperFile.sourceSha256, wrapperFile.targetSha256, wrapperFile.afterSha256],
    );
    if (!wrapperInstalled.pass) {
      return failure("runtime", "RUNTIME_FILE_INTEGRITY_DRIFT", {
        checks: wrapperInstalled.checks,
        permissionRelated: !wrapperInstalled.checks.modeMatches,
      });
    }
    runtimeHashes["scripts/gearbox-dispatch"] = wrapperInstalled.digest;
    pass("runtime", "RUNTIME_INTEGRITY_PASS", {
      completeInventory: true,
      coreInventoryPresent: true,
      installedFileCount: runtimePaths.size,
    });
    pass("permissions", "PERMISSION_INTEGRITY_PASS");
    return { pass: true, reasonCode: "ACTIVE_SCOPED_INTEGRITY_PASS", integrityBreakdown, evidence: {
      integrity: "pass",
      reasonCode: "ACTIVE_SCOPED_INTEGRITY_PASS",
      integrityBreakdown,
      allowTypedBridge: false,
      policySha256: policy.sha256,
      configSha256: configInstalled.digest,
      configIntegritySha256,
      configIntegrityScope: configIntegrity.scope,
      agentsSha256: agentsInstalled.digest,
      roleHashes,
      launcherSha256: launcherInstalled.digest,
      runtimeHashes,
    } };
  } catch {
    return failure(currentComponent, "ACTIVE_INTEGRITY_READ_FAILED");
  }
}

async function activeActivationEvidence(policy) {
  return Object.hasOwn(policy?.activation ?? {}, "recordPath")
    ? activeRecordEvidence(policy)
    : legacyActiveManifestEvidence(policy);
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
  if (loaded.state === "off") {
    const integrityBreakdown = emptyIntegrityBreakdown();
    const reasonCode = policyOffReason(loaded.error);
    integrityBreakdown.policy = { status: "fail", reasonCode };
    output(off(reasonCode, integrityBreakdown));
    process.exitCode = 1;
    return;
  }
  const activeResult = loaded.state === "active"
    ? await activeActivationEvidence(loaded.policy)
    : null;
  if (loaded.state === "active" && activeResult?.pass !== true) {
    output(off(activeResult?.reasonCode ?? "ACTIVE_INTEGRITY_FAILED", activeResult?.integrityBreakdown));
    process.exitCode = 1;
    return;
  }
  const activeEvidence = activeResult?.evidence ?? null;
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
    const response = {
      status: result.status,
      mode: result.mode,
      stateSource: result.stateSource,
      rollbackRequired: result.rollbackRequired,
      ...(result.action ? { action: result.action } : {}),
      ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),
      ...(result.stateSource === "upstream" ? {
        recordsToAppend: result.recordsToAppend,
        outcomesToAppend: result.outcomesToAppend,
      } : {}),
    };
    try {
      outputWorkflow(response);
    } catch {
      outputWorkflow({
        status: "GEARBOX_WORKFLOW_BLOCKED",
        mode: result.mode,
        stateSource: result.stateSource,
        rollbackRequired: result.rollbackRequired,
        reasonCode: "WORKFLOW_OUTPUT_UNSAFE",
      });
      process.exitCode = 1;
      return;
    }
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
  output(off("DISPATCH_COMMAND_FAILED"));
  process.exitCode = 1;
});
