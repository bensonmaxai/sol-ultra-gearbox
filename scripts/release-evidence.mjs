#!/usr/bin/env node

import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLedger, evaluateLedger, validateLedger } from "../lib/cost-evidence.mjs";
import { atomicWrite, ROLE_SPECS, writeJson } from "../lib/gearbox.mjs";
import {
  createRepositorySourceManifest,
  finalizeReleaseEvidence,
  renderReleaseEvidence,
} from "../lib/release-evidence.mjs";
import { releaseCandidateFiles } from "../lib/release-check.mjs";
import {
  validateRoleSmokeEvidence,
  validateRuntimeBinding,
  validateSddAdapterEvidence,
} from "../lib/runtime-evidence.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const REPORTS_ROOT = join(REPO_ROOT, "reports");
const JSON_PATH = join(REPO_ROOT, "docs", "release-evidence.json");
const MARKDOWN_PATH = join(REPO_ROOT, "docs", "RELEASE_EVIDENCE.md");
const EXPECTED_ROOT = Object.freeze({ model: "gpt-5.6-sol", effort: "max" });

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

function summarizeRoleSmoke(report, currentHead) {
  const roles = Array.isArray(report?.roles) ? report.roles : [];
  const bindingValid = validateRuntimeBinding(report?.runtimeBinding);
  const roleEvidence = validateRoleSmokeEvidence(
    report,
    ROLE_SPECS.filter((role) => role.smoke),
    EXPECTED_ROOT,
  );
  const pass =
    roleEvidence.pass &&
    bindingValid &&
    report.runtimeBinding.git.clean === true &&
    report.runtimeBinding.git.head === currentHead &&
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
    runtimeBindingSha256: report.runtimeBinding.sha256,
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

function summarizeSddAdapter(report, currentHead) {
  const validation = validateSddAdapterEvidence(report);
  if (
    !validation.pass ||
    report.runtimeBinding.git.clean !== true ||
    report.runtimeBinding.git.head !== currentHead
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
    runtimeBindingSha256: report.runtimeBinding.sha256,
  };
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
      "Usage: node scripts/release-evidence.mjs generate --smoke <reports/.../smoke.json> --sdd <reports/.../sdd.json> [--cost-ledger <path>]",
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
  const [tests, smokeReport, sddReport, costStatus] = await Promise.all([
    runTests(),
    readLocalReport(optionValue(args, "--smoke"), "smoke.json"),
    readLocalReport(optionValue(args, "--sdd"), "sdd.json"),
    loadCostStatus(
      optionValue(args, "--cost-ledger") ?? join(REPORTS_ROOT, "cost-evidence.json"),
    ),
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
      roleSmoke: summarizeRoleSmoke(smokeReport, currentHead),
      sddAdapter: summarizeSddAdapter(sddReport, currentHead),
    },
    costEvidence: {
      kind: "real_work",
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
    `RELEASE_EVIDENCE_PASS tests=${tests.total} pairs=${costStatus.completePairCount}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`RELEASE_EVIDENCE_ERROR ${error.message}\n`);
  process.exitCode = 1;
});
