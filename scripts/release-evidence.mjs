#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createLedger,
  evaluateLedger,
  summarizeObservedUsageReport,
  validateLedger,
  validateObservedUsageReport,
} from "../lib/cost-evidence.mjs";
import {
  atomicWrite,
  ROLE_SPECS,
  RUNTIME_BINDING_FILES,
  sha256,
  validatePostInstallRootRuntime,
  writeJson,
} from "../lib/gearbox.mjs";
import {
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

function validateActiveTransition({
  manifest,
  manifestPath,
  smokeReport,
  acceptanceReport,
  currentBinding,
  activeStatusResult,
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
      activeStatus?.configSha256 === activeConfigSha256 &&
      activeStatus?.policySha256 === manifest?.activation?.policySha256,
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
      "Usage: node scripts/release-evidence.mjs generate --smoke <reports/.../smoke.json> --sdd <reports/.../sdd.json> --acceptance <reports/.../acceptance.json> --activation-manifest <reports/.../install-manifest.json> --usage <reports/.../real-work-usage.json> [--cost-ledger <path>]",
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
  const activationManifestPath = optionValue(args, "--activation-manifest");
  const [
    tests,
    smokeReport,
    sddReport,
    acceptanceReport,
    activationManifest,
    activeStatusResult,
    usageReport,
    costStatus,
    currentBinding,
  ] = await Promise.all([
    runTests(),
    readLocalReport(optionValue(args, "--smoke"), "smoke.json"),
    readLocalReport(optionValue(args, "--sdd"), "sdd.json"),
    readLocalReport(optionValue(args, "--acceptance"), "acceptance.json"),
    readLocalReport(activationManifestPath, "install-manifest.json"),
    runCommand(process.execPath, [
      join(REPO_ROOT, "scripts", "gearbox-dispatch.mjs"),
      "status",
    ]),
    readLocalReport(optionValue(args, "--usage"), "real-work-usage.json"),
    loadCostStatus(
      optionValue(args, "--cost-ledger") ?? join(REPORTS_ROOT, "cost-evidence.json"),
    ),
    collectCurrentRuntimeBinding(),
  ]);
  if (currentBinding.git.head !== currentHead || currentBinding.git.clean !== true) {
    throw new Error("Current runtime binding does not match the clean release HEAD");
  }
  const transition = validateActiveTransition({
    manifest: activationManifest,
    manifestPath: activationManifestPath,
    smokeReport,
    acceptanceReport,
    currentBinding,
    activeStatusResult,
  });
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
    },
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
  process.stdout.write(
    `RELEASE_EVIDENCE_PASS tests=${tests.total} observed_sessions=${usageReport.childSessionCount} pairs=${costStatus.completePairCount}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`RELEASE_EVIDENCE_ERROR ${error.message}\n`);
  process.exitCode = 1;
});
