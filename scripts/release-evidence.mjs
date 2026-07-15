#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_SERVER_ROOT_SMOKE_MARKER,
  appServerRootScopeBinding,
  createAppServerRootSmokePacket,
  rolloutContainsExactMessage,
  validateAppServerRootReceipt,
} from "../lib/app-server-root-provider.mjs";
import {
  createLedger,
  evaluateLedger,
  summarizeObservedUsageReport,
  validateLedger,
  validateObservedUsageReport,
} from "../lib/cost-evidence.mjs";
import {
  activeActivationRecordPath,
  atomicWrite,
  ROLE_SPECS,
  RUNTIME_BINDING_FILES,
  readCurrentWorkflowContractEvidence,
  sha256,
  summarizeRollout,
  validatePostInstallRootRuntime,
  writeJson,
} from "../lib/gearbox.mjs";
import {
  OBSERVED_USAGE_REPORT_BASENAME,
  createRepositorySourceManifest,
  finalizeReleaseEvidence,
  renderReleaseEvidence,
  runtimeBindingComponentsMatch,
  validateActiveConfigBinding,
} from "../lib/release-evidence.mjs";
import { releaseCandidateFiles } from "../lib/release-check.mjs";
import { validateAcceptanceEvidence } from "../lib/acceptance-exam.mjs";
import {
  createRuntimeBinding,
  validateRoleSmokeEvidence,
  validateRuntimeBinding,
  validateSddAdapterEvidence,
  validateWritingSkillsAdapterEvidence,
} from "../lib/runtime-evidence.mjs";
import {
  hashTaskPacket,
  renderTaskMessage,
  selectModelRoute,
} from "../lib/dispatch-planner.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const REPORTS_ROOT = join(REPO_ROOT, "reports");
const JSON_PATH = join(REPO_ROOT, "docs", "release-evidence.json");
const MARKDOWN_PATH = join(REPO_ROOT, "docs", "RELEASE_EVIDENCE.md");
const EXPECTED_ROOT = Object.freeze({ model: "gpt-5.6-sol", effort: "max" });
const SHA256 = /^[a-f0-9]{64}$/;
const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const APP_CODEX_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_BIN =
  process.env.CODEX_BIN ?? (existsSync(APP_CODEX_BIN) ? APP_CODEX_BIN : "codex");
const LATEST_REPORT_KINDS = Object.freeze([
  "smoke",
  "sdd",
  "acceptance",
  "activationManifest",
]);
const ROOT_PROVIDER_SMOKE_PACKET = createAppServerRootSmokePacket();
const ROOT_PROVIDER_SMOKE_TASK_HASH = hashTaskPacket(ROOT_PROVIDER_SMOKE_PACKET);
const ROOT_PROVIDER_SMOKE_SCOPE = appServerRootScopeBinding(ROOT_PROVIDER_SMOKE_PACKET);
const ROOT_PROVIDER_SMOKE_MESSAGE = renderTaskMessage(ROOT_PROVIDER_SMOKE_PACKET);
const ROOT_PROVIDER_SMOKE_ROUTE = selectModelRoute({
  packet: ROOT_PROVIDER_SMOKE_PACKET,
  roleSpecs: ROLE_SPECS,
}).root;

function compareRank(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return 0;
}

export function chooseLatestCurrentReportSet(sets) {
  if (!Array.isArray(sets) || sets.length === 0) {
    throw new Error("No current report set is available");
  }
  const candidates = [...sets];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate?.rank) || candidate.rank.length !== 4 ||
      candidate.rank.some((value) => !Number.isFinite(value)) ||
      candidate.reports === null || typeof candidate.reports !== "object" ||
      Object.keys(candidate.reports).length !== LATEST_REPORT_KINDS.length ||
      LATEST_REPORT_KINDS.some((kind) =>
        candidate.reports[kind]?.kind !== kind ||
        !SHA256.test(candidate.reports[kind]?.sha256 ?? ""),
      )) {
      throw new TypeError("Current report set is malformed");
    }
  }
  candidates.sort((left, right) => compareRank(left.rank, right.rank));
  if (candidates.length > 1 && compareRank(candidates[0].rank, candidates[1].rank) === 0) {
    throw new Error("Current report selection is ambiguous");
  }
  return candidates[0];
}

export function publicLatestCurrentSelection(selected) {
  const current = chooseLatestCurrentReportSet([selected]);
  return {
    inputs: LATEST_REPORT_KINDS.map((kind) => ({
      kind,
      sha256: current.reports[kind].sha256,
    })),
  };
}
function runCommand(command, args, { cwd = REPO_ROOT } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({ code: code ?? -1, stdout, stderr });
    });
  });
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return null;
  return args[index + 1];
}

async function readLocalReport(path, expectedName) {
  if (!path) throw new Error(`Missing required ${expectedName} report path`);
  const reportsMetadata = await lstat(REPORTS_ROOT);
  if (!reportsMetadata.isDirectory() || reportsMetadata.isSymbolicLink()) {
    throw new Error("Repository reports directory must be a real directory");
  }
  const reportsRoot = await realpath(REPORTS_ROOT);
  const requested = resolve(path);
  const metadata = await lstat(requested);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${expectedName} report must be a regular non-symlink file`);
  }
  const actual = await realpath(requested);
  const inside = relative(reportsRoot, actual);
  if (
    inside === "" ||
    inside === ".." ||
    inside.startsWith(`..${sep}`) ||
    resolve(reportsRoot, inside) !== actual
  ) {
    throw new Error(`${expectedName} report must remain under reports/`);
  }
  if (actual.split(sep).at(-1) !== expectedName) {
    throw new Error(`Expected a ${expectedName} report`);
  }
  return JSON.parse(await readFile(actual, "utf8"));
}

async function readWorkflowContractOption(path) {
  if (!path) throw new Error("Missing required workflow contract path");
  const expected = join(REPO_ROOT, "docs", "workflow-contract-evidence.json");
  const requested = resolve(path);
  if (requested !== expected) {
    throw new Error("Workflow contract must be docs/workflow-contract-evidence.json");
  }
  const metadata = await lstat(requested);
  if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(requested) !== requested) {
    throw new Error("Workflow contract must be a regular non-symlink repository file");
  }
  return readCurrentWorkflowContractEvidence(REPO_ROOT);
}

async function readRootProviderReceipt(path, {
  policySha256,
  notBefore,
}) {
  if (!path) throw new Error("Missing required root provider receipt path");
  const receiptRoot = join(CODEX_HOME, "gearbox", "root-receipts");
  const rootMetadata = await lstat(receiptRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() ||
    (rootMetadata.mode & 0o077) !== 0) {
    throw new Error("Root provider receipt directory must be private and physical");
  }
  const physicalRoot = await realpath(receiptRoot);
  if (physicalRoot !== resolve(receiptRoot)) {
    throw new Error("Root provider receipt directory must be private and physical");
  }
  const requested = resolve(path);
  const metadata = await lstat(requested);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Root provider receipt must be a private regular file");
  }
  const actual = await realpath(requested);
  const inside = relative(physicalRoot, actual);
  if (actual !== requested || inside === "" || inside === ".." || inside.startsWith(`..${sep}`) ||
    resolve(physicalRoot, inside) !== actual) {
    throw new Error("Root provider receipt must remain under CODEX_HOME");
  }
  const source = await readFile(actual, "utf8");
  const receipt = JSON.parse(source);
  const validation = validateRootProviderSmokeReceipt(receipt, { policySha256 });
  if (!validation.pass) throw new Error("Root provider receipt is incomplete or invalid");
  if (Date.parse(receipt.startedAt) < Date.parse(notBefore ?? "")) {
    throw new Error("Root provider receipt predates the active installation");
  }
  const rollout = await verifyRootProviderRollout(receipt);
  if (!rollout.pass) throw new Error("Root provider persisted rollout did not reverify");
  return { receipt, sha256: sha256(source), rolloutReverified: true };
}

export function validateRootProviderSmokeReceipt(receipt, { policySha256 = null } = {}) {
  const receiptValidation = validateAppServerRootReceipt(receipt, { policySha256 });
  const checks = {
    receipt: receiptValidation.pass,
    task: receipt?.taskHash === ROOT_PROVIDER_SMOKE_TASK_HASH,
    route:
      receipt?.route?.model === ROOT_PROVIDER_SMOKE_ROUTE.model &&
      receipt?.route?.effort === ROOT_PROVIDER_SMOKE_ROUTE.effort &&
      receipt?.route?.reasonCode === ROOT_PROVIDER_SMOKE_ROUTE.reasonCode,
    scope:
      receipt?.scope?.readScopeSha256 === ROOT_PROVIDER_SMOKE_SCOPE.readScopeSha256 &&
      receipt?.scope?.writeScopeSha256 === ROOT_PROVIDER_SMOKE_SCOPE.writeScopeSha256 &&
      receipt?.scope?.changedPathCount === 0 &&
      Array.isArray(receipt?.scope?.changes) && receipt.scope.changes.length === 0,
    marker: receipt?.runtime?.resultSha256 === sha256(APP_SERVER_ROOT_SMOKE_MARKER),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export async function verifyRootProviderRollout(receipt, options = {}) {
  const explicitMultipleRoots = Array.isArray(options.sessionRoots);
  const requestedRoots = explicitMultipleRoots
    ? options.sessionRoots
    : typeof options.sessionsRoot === "string"
      ? [options.sessionsRoot]
      : [join(CODEX_HOME, "sessions"), join(CODEX_HOME, "archived_sessions")];
  if (requestedRoots.length === 0 || requestedRoots.some((value) =>
    typeof value !== "string" || value.length === 0 ||
      (explicitMultipleRoots && !isAbsolute(value))
  )) {
    throw new Error("Root provider session roots must be non-empty absolute paths");
  }
  const physicalRoots = [];
  for (const root of requestedRoots) {
    const requestedRoot = resolve(root);
    const rootMetadata = await lstat(requestedRoot);
    const physicalRoot = await realpath(requestedRoot);
    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() ||
      physicalRoot !== requestedRoot || physicalRoots.includes(physicalRoot)) {
      throw new Error("Root provider session roots must be distinct physical directories");
    }
    physicalRoots.push(physicalRoot);
  }
  const lowerBound = Date.parse(receipt.startedAt) - 60_000;
  const upperBound = Date.parse(receipt.completedAt) + 60_000;
  const matches = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error("Root provider rollout search refuses symlinks");
      }
      if (metadata.isDirectory()) {
        await walk(path);
      } else if (metadata.isFile() && metadata.mtimeMs >= lowerBound &&
        metadata.mtimeMs <= upperBound) {
        const source = await readFile(path, "utf8");
        if (sha256(source) === receipt.runtime.rolloutSha256) {
          matches.push({ path, source });
        }
      }
    }
  }
  for (const physicalRoot of physicalRoots) await walk(physicalRoot);
  if (matches.length !== 1) {
    return { pass: false, checks: { uniqueRollout: false } };
  }
  const [{ path, source }] = matches;
  const summary = await summarizeRollout(path);
  const checks = {
    uniqueRollout: true,
    persisted: Boolean(summary.sessionMeta && summary.turnContext),
    threadIdentity: sha256(summary.sessionId ?? "") === receipt.provider.threadIdSha256,
    cwd: sha256(summary.sessionMeta?.cwd ?? "") === receipt.scope.cwdSha256,
    route:
      summary.turnContext?.model === receipt.route.model &&
      summary.turnContext?.effort === receipt.route.effort,
    taskMessage: rolloutContainsExactMessage(
      source,
      "user",
      ROOT_PROVIDER_SMOKE_MESSAGE,
    ),
    marker:
      sha256((summary.finalTexts.at(-1) ?? "").trim()) ===
      receipt.runtime.resultSha256,
    tokenUsage:
      Number.isFinite(summary.tokenUsage?.total_tokens) &&
      summary.tokenUsage.total_tokens === receipt.runtime.tokenUsage.total_tokens,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

function summarizeRootProviderReceipt({
  receipt,
  sha256: receiptSha256,
  rolloutReverified,
}) {
  return {
    status: "pass",
    provider: "app_server_root",
    model: receipt.route.model,
    effort: receipt.route.effort,
    reasonCode: receipt.reasonCode,
    taskHash: receipt.taskHash,
    receiptSha256,
    policySha256: receipt.policySha256,
    smokeTaskBound: true,
    rolloutReverified: rolloutReverified === true,
    scopeVerified: receipt.scope.verified,
    lifecycleClosed:
      receipt.lifecycle.archived === true &&
      receipt.lifecycle.unsubscribed === true &&
      receipt.lifecycle.serverExitCode === 0 &&
      receipt.lifecycle.serverExitSignal === null,
    persistedRuntime: receipt.runtime.checks.persisted === true,
    tokenUsagePersisted: receipt.runtime.checks.tokenUsagePersisted === true,
  };
}

async function discoverLatestReportCandidates() {
  const rootMetadata = await lstat(REPORTS_ROOT);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Repository reports directory must be a real directory");
  }
  const expected = new Map([
    ["smoke.json", "smoke"],
    ["sdd.json", "sdd"],
    ["acceptance.json", "acceptance"],
    ["install-manifest.json", "activationManifest"],
  ]);
  const candidates = Object.fromEntries(LATEST_REPORT_KINDS.map((kind) => [kind, []]));
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error("Latest-current refuses symlinks beneath reports/");
      }
      if (metadata.isDirectory()) {
        await walk(path);
        continue;
      }
      const kind = expected.get(entry.name);
      if (!kind || !metadata.isFile()) continue;
      const repositoryRelative = relative(REPO_ROOT, path);
      const ignored = await runCommand("git", ["check-ignore", "--no-index", "--quiet", "--", repositoryRelative]);
      if (ignored.code === 1) continue;
      if (ignored.code !== 0) throw new Error("Unable to verify ignored report input");
      const source = await readFile(path, "utf8");
      let value;
      try {
        value = JSON.parse(source);
      } catch {
        continue;
      }
      candidates[kind].push({ kind, path, sha256: sha256(source), value, mtimeMs: metadata.mtimeMs });
    }
  }
  await walk(REPORTS_ROOT);
  return candidates;
}

async function collectCurrentRuntimeBinding() {
  const [head, status, version, config] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"]),
    runCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
    runCommand(CODEX_BIN, ["--version"]),
    readFile(join(CODEX_HOME, "config.toml"), "utf8"),
  ]);
  if (head.code !== 0 || status.code !== 0 || version.code !== 0) {
    throw new Error("Unable to collect current runtime binding");
  }
  const roleHashes = {};
  for (const role of ROLE_SPECS) {
    roleHashes[role.name] = sha256(await readFile(join(REPO_ROOT, "roles", role.sourceFile)));
  }
  const runtimeHashes = {};
  for (const path of RUNTIME_BINDING_FILES) {
    runtimeHashes[path] = sha256(await readFile(join(REPO_ROOT, path)));
  }
  return createRuntimeBinding({
    gitHead: head.stdout.trim(),
    gitStatus: status.stdout,
    codexVersion: version.stdout.trim().split(/\r?\n/).at(-1),
    configSha256: sha256(config),
    roleHashes,
    runtimeHashes,
  });
}

async function reportCommitIsAncestor(report, currentBinding) {
  const sourceCommit = report?.runtimeBinding?.git?.head;
  if (typeof sourceCommit !== "string") return false;
  const result = await runCommand("git", [
    "merge-base",
    "--is-ancestor",
    sourceCommit,
    currentBinding.git.head,
  ]);
  return result.code === 0;
}

function runtimeEvidenceCompatible(
  report,
  currentBinding,
  commitIsAncestor,
  transition,
) {
  const directComponentsMatch = runtimeBindingComponentsMatch(
    report?.runtimeBinding,
    currentBinding,
  );
  const transitionComponentsMatch =
    transition?.pass === true &&
    report?.runtimeBinding?.configSha256 === transition.preInstallConfigSha256 &&
    currentBinding?.configSha256 === transition.activeConfigSha256 &&
    runtimeBindingComponentsMatch(
      report?.runtimeBinding,
      {
        ...currentBinding,
        configSha256: report?.runtimeBinding?.configSha256,
      },
    );
  return (
    validateRuntimeBinding(report?.runtimeBinding) &&
    validateRuntimeBinding(currentBinding) &&
    currentBinding.git.clean === true &&
    commitIsAncestor === true &&
    (directComponentsMatch || transitionComponentsMatch)
  );
}

function durableActivationRecordBinding(manifest) {
  try {
    return manifest?.activation?.recordPath === activeActivationRecordPath(
      CODEX_HOME,
      manifest?.activation?.installId,
    ) && SHA256.test(manifest?.activation?.recordSha256 ?? "");
  } catch {
    return false;
  }
}

function validateActiveTransition({
  manifest,
  manifestPath,
  smokeReport,
  acceptanceReport,
  currentBinding,
  activeStatusResult,
  workflowContractEvidenceSha256,
}) {
  let activeStatus = null;
  if (activeStatusResult?.code === 0) {
    try {
      activeStatus = JSON.parse(activeStatusResult.stdout.trim());
    } catch {
      activeStatus = null;
    }
  }
  const rootValidation = validatePostInstallRootRuntime(
    manifest?.postInstallRootSmoke?.actual,
    { active: true },
  );
  const staticChecks = manifest?.staticChecks;
  const preInstallConfigSha256 = manifest?.config?.beforeSha256;
  const activeConfigSha256 = manifest?.config?.afterSha256;
  const checks = {
    manifestApplied:
      manifest?.schemaVersion === 1 && manifest?.status === "applied",
    manifestIdentity:
      typeof manifest?.activation?.installId === "string" &&
      manifest.activation.installId.length > 0 &&
      manifest?.activation?.manifestPath === resolve(manifestPath) &&
      typeof manifest?.activation?.repositoryRoot === "string" &&
      resolve(manifest.activation.repositoryRoot) === REPO_ROOT,
    durableActivationRecord: durableActivationRecordBinding(manifest),
    configPaths:
      manifest?.config?.path === join(CODEX_HOME, "config.toml"),
    configBinding: validateActiveConfigBinding({
      preInstallConfigSha256,
      activeConfigSha256,
      acceptanceConfigSha256: acceptanceReport?.runtimeBinding?.configSha256,
      currentConfigSha256: currentBinding?.configSha256,
    }),
    rollbackState:
      manifest?.config?.rollbackState?.schemaVersion === 1 &&
      manifest?.config?.rollbackState?.beforeSha256 === preInstallConfigSha256 &&
      manifest?.config?.rollbackState?.managedBlocks !== null &&
      typeof manifest?.config?.rollbackState?.managedBlocks === "object",
    acceptanceBinding:
      SHA256.test(manifest?.activation?.acceptanceBindingSha256 ?? "") &&
      manifest.activation.acceptanceBindingSha256 ===
        acceptanceReport?.runtimeBinding?.sha256,
    writingSkillsBinding:
      validateWritingSkillsAdapterEvidence(smokeReport?.writingSkillsAdapter)
        .pass &&
      SHA256.test(
        manifest?.activation?.writingSkillsEvidenceSha256 ?? "",
      ) &&
      manifest.activation.writingSkillsEvidenceSha256 ===
        smokeReport.writingSkillsAdapter.evidenceSha256,
    workflowContractBinding:
      SHA256.test(workflowContractEvidenceSha256 ?? "") &&
      manifest?.activation?.workflowContractEvidenceSha256 ===
        workflowContractEvidenceSha256,
    staticChecks:
      staticChecks !== null &&
      typeof staticChecks === "object" &&
      ["strictConfig", "configLoad", "mcpConfig", "installation"]
        .every((key) => staticChecks[key] === true),
    freshRoot:
      manifest?.postInstallRootSmoke?.pass === true && rootValidation.pass,
    activeStatus:
      activeStatus?.status === "GEARBOX_DISPATCH_ACTIVE" &&
      activeStatus?.mode === "active" &&
      activeStatus?.integrity === "pass" &&
      activeStatus?.allowTypedBridge === false &&
      activeStatus?.activationRecordSha256 ===
        manifest?.activation?.recordSha256 &&
      activeStatus?.configSha256 === activeConfigSha256 &&
      activeStatus?.policySha256 === manifest?.activation?.policySha256,
    rootProviderPolicy:
      activeStatus?.rootProvider?.kind === "app_server_root" &&
      activeStatus?.rootProvider?.enabled === true &&
      activeStatus?.rootProvider?.acceptanceBound === true,
    policyHash: SHA256.test(manifest?.activation?.policySha256 ?? ""),
  };
  const failed = Object.entries(checks)
    .filter(([, pass]) => !pass)
    .map(([name]) => name);
  if (failed.length > 0) {
    throw new Error(`Active installation evidence failed: ${failed.join(", ")}`);
  }
  return {
    pass: true,
    preInstallConfigSha256,
    activeConfigSha256,
    summary: {
      status: "pass",
      mode: "active",
      integrity: "pass",
      allowTypedBridge: false,
      installId: manifest.activation.installId,
      policySha256: manifest.activation.policySha256,
      preInstallConfigSha256,
      activeConfigSha256,
      root: {
        persisted: true,
        model: manifest.postInstallRootSmoke.actual.model,
        effort: manifest.postInstallRootSmoke.actual.effort,
      },
    },
  };
}

function summarizeRoleSmoke(report, currentBinding, commitIsAncestor, transition) {
  const roles = Array.isArray(report?.roles) ? report.roles : [];
  const bindingValid = validateRuntimeBinding(report?.runtimeBinding);
  const roleEvidence = validateRoleSmokeEvidence(
    report,
    ROLE_SPECS.filter((role) => role.smoke),
    EXPECTED_ROOT,
  );
  const writingSkillsEvidence = validateWritingSkillsAdapterEvidence(
    report?.writingSkillsAdapter,
  );
  const pass =
    roleEvidence.pass &&
    writingSkillsEvidence.pass &&
    bindingValid &&
    report.runtimeBinding.git.clean === true &&
    runtimeEvidenceCompatible(report, currentBinding, commitIsAncestor, transition) &&
    report?.runtimeBindingStable === true &&
    report?.runtimeBindingAfterSha256 === report.runtimeBinding.sha256;
  if (!pass) throw new Error("Role smoke report is incomplete, stale, or not bound to current HEAD");
  return {
    status: "pass",
    generatedAt: report.generatedAt,
    expectedRoleCount: report.expectedRoleCount,
    passedRoleCount: roles.length,
    rootVerified: true,
    commit: report.runtimeBinding.git.head,
    validatedAtCommit: currentBinding.git.head,
    runtimeBindingSha256: report.runtimeBinding.sha256,
    writingSkillsAdapter: {
      pass: true,
      role: report.writingSkillsAdapter.role,
      redRuns: report.writingSkillsAdapter.trials.filter(
        (trial) => trial.phase === "red",
      ).length,
      greenRuns: report.writingSkillsAdapter.trials.filter(
        (trial) => trial.phase === "green",
      ).length,
      evidenceSha256: report.writingSkillsAdapter.evidenceSha256,
    },
    roles: roles.map((role) => ({
      role: role.role,
      model: role.actual.model,
      effort: role.actual.effort,
      sandbox: role.actual.sandbox,
      parentTokens: role.actual.parentTokenUsage.total_tokens,
      childTokens: role.actual.tokenUsage.total_tokens,
      pass: true,
    })),
  };
}

function summarizeSddAdapter(report, currentBinding, commitIsAncestor, transition) {
  const validation = validateSddAdapterEvidence(report);
  if (
    !validation.pass ||
    report.runtimeBinding.git.clean !== true ||
    !runtimeEvidenceCompatible(report, currentBinding, commitIsAncestor, transition)
  ) {
    throw new Error("SDD adapter report is incomplete, stale, or not bound to current HEAD");
  }
  return {
    status: "pass",
    generatedAt: report.generatedAt,
    phases: report.phases.map((phase) => phase.role),
    permissionStrategy: report.boundary?.permissionStrategy,
    verification: report.boundary?.verification,
    commit: report.runtimeBinding.git.head,
    validatedAtCommit: currentBinding.git.head,
    runtimeBindingSha256: report.runtimeBinding.sha256,
  };
}

function summarizeAcceptanceExam(report, currentBinding, commitIsAncestor, transition) {
  const validation = validateAcceptanceEvidence(report);
  if (
    !validation.pass ||
    report.runtimeBinding.git.clean !== true ||
    !runtimeEvidenceCompatible(report, currentBinding, commitIsAncestor, transition)
  ) {
    throw new Error("Acceptance exam report is incomplete, stale, or not bound to current HEAD");
  }
  const questions = report.questions;
  return {
    pass: true,
    generatedAt: report.generatedAt,
    questionCount: report.expectedQuestionCount,
    passedQuestionCount: questions.filter((question) => question.pass === true).length,
    executionShapes: [...new Set(questions.map((question) => question.selectedShape))].sort(),
    activeEligible: report.activationEligible,
    runtimeBindingSha256: report.runtimeBinding.sha256,
  };
}

function summarizeWorkflowContract(workflowContract, acceptanceReport) {
  const q10 = acceptanceReport?.questions?.find(
    (question) => question?.id === "Q10_TWO_TYPED_READERS",
  );
  if (q10?.pass !== true || q10?.workflowCanary !== true) {
    throw new Error("Acceptance Q10 workflow canary is not verified");
  }
  return {
    deterministicScenarioCount: workflowContract.evidence.scenarioCount,
    deterministicPass:
      workflowContract.evidence.scenarioCount === 5 &&
      workflowContract.evidence.passedScenarioCount === 5,
    q10CanaryVerified: true,
  };
}

function reportTimestamp(candidate, fields) {
  for (const field of fields) {
    const value = Date.parse(candidate?.value?.[field] ?? "");
    if (Number.isFinite(value)) return value;
  }
  return candidate.mtimeMs;
}

async function selectLatestCurrentReports({
  currentBinding,
  activeStatusResult,
  workflowContractEvidenceSha256,
}) {
  const candidates = await discoverLatestReportCandidates();
  const sets = [];
  const ancestor = new Map();
  const isAncestor = async (candidate) => {
    if (!ancestor.has(candidate.sha256)) {
      ancestor.set(candidate.sha256, await reportCommitIsAncestor(candidate.value, currentBinding));
    }
    return ancestor.get(candidate.sha256);
  };
  for (const activationManifest of candidates.activationManifest) {
    for (const smoke of candidates.smoke) {
      for (const acceptance of candidates.acceptance) {
        let transition;
        try {
          transition = validateActiveTransition({
            manifest: activationManifest.value,
            manifestPath: activationManifest.path,
            smokeReport: smoke.value,
            acceptanceReport: acceptance.value,
            currentBinding,
            activeStatusResult,
            workflowContractEvidenceSha256,
          });
          summarizeRoleSmoke(smoke.value, currentBinding, await isAncestor(smoke), transition);
          summarizeAcceptanceExam(
            acceptance.value,
            currentBinding,
            await isAncestor(acceptance),
            transition,
          );
        } catch {
          continue;
        }
        for (const sdd of candidates.sdd) {
          try {
            summarizeSddAdapter(sdd.value, currentBinding, await isAncestor(sdd), transition);
          } catch {
            continue;
          }
          sets.push({
            rank: [
              reportTimestamp(activationManifest, ["completedAt", "generatedAt"]),
              reportTimestamp(acceptance, ["generatedAt"]),
              reportTimestamp(smoke, ["generatedAt"]),
              reportTimestamp(sdd, ["generatedAt"]),
            ],
            reports: { smoke, sdd, acceptance, activationManifest },
          });
        }
      }
    }
  }
  return chooseLatestCurrentReportSet(sets);
}

function summarizeObservedUsage(report) {
  const validation = validateObservedUsageReport(report);
  if (!validation.valid) {
    throw new Error(`Observed real-work usage report is invalid: ${validation.errors.join("; ")}`);
  }
  return summarizeObservedUsageReport(report);
}

async function runTests() {
  const result = await runCommand(process.execPath, [
    "--test",
    "--test-reporter=tap",
  ]);
  const count = (label) => {
    const match = result.stdout.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
    return match ? Number(match[1]) : null;
  };
  const total = count("tests");
  const passed = count("pass");
  const failed = count("fail");
  if (
    result.code !== 0 ||
    !Number.isInteger(total) ||
    !Number.isInteger(passed) ||
    !Number.isInteger(failed) ||
    total <= 0 ||
    passed !== total ||
    failed !== 0
  ) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
    throw new Error(`Deterministic tests did not pass: ${detail}`);
  }
  return {
    status: "pass",
    command: "node --test --test-reporter=tap",
    total,
    passed,
    failed,
  };
}

async function loadCostStatus(path) {
  let ledger;
  try {
    ledger = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    ledger = createLedger();
  }
  const validation = validateLedger(ledger);
  if (!validation.valid) {
    throw new Error(`Invalid real-work ledger: ${validation.errors.join("; ")}`);
  }
  return evaluateLedger(ledger);
}

async function main() {
  const [, , command, ...args] = process.argv;
  if (command !== "generate") {
    throw new Error(
      `Usage: node scripts/release-evidence.mjs generate (--latest-current | --smoke <reports/.../smoke.json> --sdd <reports/.../sdd.json> --acceptance <reports/.../acceptance.json> --activation-manifest <reports/.../install-manifest.json>) --root-provider-receipt <CODEX_HOME/gearbox/root-receipts/...json> --workflow-contract docs/workflow-contract-evidence.json --usage <reports/.../${OBSERVED_USAGE_REPORT_BASENAME}> [--cost-ledger <path>]`,
    );
  }
  const statusBefore = await runCommand("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const headResult = await runCommand("git", ["rev-parse", "HEAD"]);
  if (statusBefore.code !== 0 || headResult.code !== 0 || statusBefore.stdout !== "") {
    throw new Error("Release evidence generation requires a clean Git tree");
  }
  const currentHead = headResult.stdout.trim();
  const latestCurrent = args.includes("--latest-current");
  const explicitReportFlags = ["--smoke", "--sdd", "--acceptance", "--activation-manifest"];
  if (latestCurrent && explicitReportFlags.some((flag) => args.includes(flag))) {
    throw new Error("--latest-current cannot be combined with explicit runtime report paths");
  }
  const workflowContract = await readWorkflowContractOption(
    optionValue(args, "--workflow-contract"),
  );
  const [
    tests,
    activeStatusResult,
    usageReport,
    costStatus,
    currentBinding,
  ] = await Promise.all([
    runTests(),
    runCommand(process.execPath, [
      join(REPO_ROOT, "scripts", "gearbox-dispatch.mjs"),
      "status",
    ]),
    readLocalReport(optionValue(args, "--usage"), OBSERVED_USAGE_REPORT_BASENAME),
    loadCostStatus(
      optionValue(args, "--cost-ledger") ?? join(REPORTS_ROOT, "cost-evidence.json"),
    ),
    collectCurrentRuntimeBinding(),
  ]);
  if (currentBinding.git.head !== currentHead || currentBinding.git.clean !== true) {
    throw new Error("Current runtime binding does not match the clean release HEAD");
  }
  let smokeReport;
  let sddReport;
  let acceptanceReport;
  let activationManifest;
  let activationManifestPath;
  let latestSelection = null;
  if (latestCurrent) {
    latestSelection = await selectLatestCurrentReports({
      currentBinding,
      activeStatusResult,
      workflowContractEvidenceSha256: workflowContract.sha256,
    });
    smokeReport = latestSelection.reports.smoke.value;
    sddReport = latestSelection.reports.sdd.value;
    acceptanceReport = latestSelection.reports.acceptance.value;
    activationManifest = latestSelection.reports.activationManifest.value;
    activationManifestPath = latestSelection.reports.activationManifest.path;
  } else {
    activationManifestPath = optionValue(args, "--activation-manifest");
    [smokeReport, sddReport, acceptanceReport, activationManifest] = await Promise.all([
      readLocalReport(optionValue(args, "--smoke"), "smoke.json"),
      readLocalReport(optionValue(args, "--sdd"), "sdd.json"),
      readLocalReport(optionValue(args, "--acceptance"), "acceptance.json"),
      readLocalReport(activationManifestPath, "install-manifest.json"),
    ]);
  }
  const transition = validateActiveTransition({
    manifest: activationManifest,
    manifestPath: activationManifestPath,
    smokeReport,
    acceptanceReport,
    currentBinding,
    activeStatusResult,
    workflowContractEvidenceSha256: workflowContract.sha256,
  });
  const rootProviderReceipt = await readRootProviderReceipt(
    optionValue(args, "--root-provider-receipt"),
    {
      policySha256: transition.summary.policySha256,
      notBefore: activationManifest.completedAt,
    },
  );
  const [smokeCommitIsAncestor, sddCommitIsAncestor, acceptanceCommitIsAncestor] = await Promise.all([
    reportCommitIsAncestor(smokeReport, currentBinding),
    reportCommitIsAncestor(sddReport, currentBinding),
    reportCommitIsAncestor(acceptanceReport, currentBinding),
  ]);
  const statusAfterTests = await runCommand("git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (statusAfterTests.code !== 0 || statusAfterTests.stdout !== "") {
    throw new Error("Tests changed the Git tree; refusing release evidence generation");
  }
  const files = releaseCandidateFiles(REPO_ROOT);
  const source = await createRepositorySourceManifest(REPO_ROOT, files);
  source.commit = currentHead;
  const evidence = finalizeReleaseEvidence({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source,
    tests,
    runtime: {
      activation: transition.summary,
      roleSmoke: summarizeRoleSmoke(
        smokeReport,
        currentBinding,
        smokeCommitIsAncestor,
        transition,
      ),
      sddAdapter: summarizeSddAdapter(
        sddReport,
        currentBinding,
        sddCommitIsAncestor,
        transition,
      ),
      acceptanceExam: summarizeAcceptanceExam(
        acceptanceReport,
        currentBinding,
        acceptanceCommitIsAncestor,
        transition,
      ),
      rootProvider: summarizeRootProviderReceipt(rootProviderReceipt),
    },
    workflowContract: summarizeWorkflowContract(
      workflowContract,
      acceptanceReport,
    ),
    costEvidence: {
      kind: "real_work",
      observedRuntime: summarizeObservedUsage(usageReport),
      completePairCount: costStatus.completePairCount,
      requiredPairCount: 10,
      eligibleForEstimate: costStatus.eligibleForEstimate,
      estimatorPublished: false,
    },
    limitations: {
      coreRuntimeHook: "out_of_scope",
      costEstimator: "gated_until_10_complete_pairs",
    },
  });
  await writeJson(JSON_PATH, evidence);
  await atomicWrite(MARKDOWN_PATH, renderReleaseEvidence(evidence));
  if (latestSelection !== null) {
    process.stdout.write(`${JSON.stringify(publicLatestCurrentSelection(latestSelection))}\n`);
  }
  process.stdout.write(
    `RELEASE_EVIDENCE_PASS tests=${tests.total} observed_sessions=${usageReport.childSessionCount} pairs=${costStatus.completePairCount}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`RELEASE_EVIDENCE_ERROR ${error.message}\n`);
    process.exitCode = 1;
  });
}
