import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRepositorySourceManifest,
  createSourceManifest,
  evidenceSourcePaths,
  finalizeReleaseEvidence,
  renderReleaseEvidence,
  runtimeBindingComponentsMatch,
  validateActiveConfigBinding,
  validateActiveInstallationSummary,
  validateReleaseEvidence,
  validateWorkflowContractSummary,
} from "../lib/release-evidence.mjs";
import {
  chooseLatestCurrentReportSet,
  publicLatestCurrentSelection,
} from "../scripts/release-evidence.mjs";

function sourceManifest(overrides = {}) {
  return createSourceManifest({
    "README.md": "public\n",
    "lib/gearbox.mjs": "export const value = 1;\n",
    ...overrides,
  });
}

function evidence(source = sourceManifest()) {
  return finalizeReleaseEvidence({
    schemaVersion: 1,
    generatedAt: "2026-07-13T04:00:00.000Z",
    source,
    tests: {
      status: "pass",
      command: "node --test",
      total: 40,
      passed: 40,
      failed: 0,
    },
    runtime: {
      activation: {
        status: "pass",
        mode: "active",
        integrity: "pass",
        allowTypedBridge: false,
        installId: "gearbox-fixture",
        policySha256: "c".repeat(64),
        preInstallConfigSha256: "d".repeat(64),
        activeConfigSha256: "e".repeat(64),
        root: {
          persisted: true,
          model: "gpt-5.6-sol",
          effort: "max",
        },
      },
      roleSmoke: {
        status: "pass",
        expectedRoleCount: 6,
        passedRoleCount: 6,
        rootVerified: true,
        commit: "a".repeat(40),
        writingSkillsAdapter: {
          pass: true,
          role: {
            name: "sol_skill_tester",
            model: "gpt-5.6-sol",
            effort: "high",
            sandbox: "read-only",
          },
          redRuns: 5,
          greenRuns: 5,
          evidenceSha256: "f".repeat(64),
        },
      },
      sddAdapter: {
        status: "pass",
        phases: ["terra_worker", "sol_reviewer"],
        commit: "a".repeat(40),
      },
      acceptanceExam: {
        pass: true,
        generatedAt: "2026-07-13T04:00:00.000Z",
        questionCount: 10,
        passedQuestionCount: 10,
        executionShapes: ["root_inline", "isolated_role_root", "typed_child"],
        activeEligible: true,
        runtimeBindingSha256: "b".repeat(64),
      },
    },
    workflowContract: {
      deterministicScenarioCount: 5,
      deterministicPass: true,
      q10CanaryVerified: true,
    },
    costEvidence: {
      kind: "real_work",
      observedRuntime: {
        schemaVersion: 1,
        kind: "real_work_child_runtime",
        generatedAt: "2026-07-13T13:45:00.000Z",
        scope: "child_only",
        parentThreadCount: 1,
        childSessionCount: 1,
        completedTurnCount: 1,
        runtimeMetadataVerifiedSessionCount: 1,
        forkNoneSessionCount: 1,
        nestedSpawnSessionCount: 0,
        policyCompliantSessionCount: 1,
        policyRejectedSessionCount: 0,
        permissionMismatchSessionCount: 0,
        spawnOverrideMismatchSessionCount: 0,
        roles: [
          {
            role: "terra_worker",
            model: "gpt-5.6-terra",
            effort: "high",
            sessions: 1,
            completedTurns: 1,
            policyCompliantSessions: 1,
            policyRejectedSessions: 0,
            permissionMismatchSessions: 0,
            spawnOverrideMismatchSessions: 0,
            tokens: {
              uncachedInput: 100,
              cachedInput: 20,
              output: 10,
            },
          },
        ],
      },
      completePairCount: 0,
      requiredPairCount: 10,
      eligibleForEstimate: false,
      estimatorPublished: false,
    },
    limitations: {
      coreRuntimeHook: "out_of_scope",
      costEstimator: "gated_until_10_complete_pairs",
    },
  });
}

test("release evidence validates exact source and rendered Markdown", () => {
  const current = sourceManifest();
  const value = evidence(current);
  const markdown = renderReleaseEvidence(value);
  const result = validateReleaseEvidence({
    evidence: value,
    markdown,
    currentSource: current,
  });
  assert.equal(result.pass, true);
  assert.equal(result.checks.acceptanceExam, true);
  assert.equal(result.checks.activeInstallation, true);
  assert.equal(result.checks.workflowContract, true);
  assert.match(markdown, /Writing-skills pressure test: PASS \(5 RED, 5 GREEN\)/);
  assert.match(markdown, /Verified workflow contract: PASS \(5\/5\).*Q10 canary: verified/i);
});

test("release evidence requires the exact five-scenario workflow summary and Q10 canary", () => {
  const valid = {
    deterministicScenarioCount: 5,
    deterministicPass: true,
    q10CanaryVerified: true,
  };
  assert.equal(validateWorkflowContractSummary(valid).pass, true);
  for (const mutate of [
    (value) => { value.deterministicScenarioCount = 4; },
    (value) => { value.deterministicPass = false; },
    (value) => { value.q10CanaryVerified = false; },
    (value) => { value.rawTopology = "private"; },
  ]) {
    const summary = structuredClone(valid);
    mutate(summary);
    assert.equal(validateWorkflowContractSummary(summary).pass, false);
  }
  const current = sourceManifest();
  const missing = evidence(current);
  delete missing.workflowContract;
  const finalized = finalizeReleaseEvidence(missing);
  assert.equal(validateReleaseEvidence({
    evidence: finalized,
    markdown: renderReleaseEvidence(finalized),
    currentSource: current,
  }).checks.workflowContract, false);
});

test("latest-current selection is newest, fails closed on absence or ambiguity, and publishes hashes only", () => {
  const reports = (suffix, rank) => ({
    rank,
    reports: Object.fromEntries(["smoke", "sdd", "acceptance", "activationManifest"].map((kind) => [kind, {
      kind,
      path: `/private/${kind}-${suffix}.json`,
      sha256: suffix.repeat(64).slice(0, 64),
    }])),
  });
  const older = reports("a", [1, 1, 1, 1]);
  const newer = reports("b", [2, 2, 2, 2]);
  const selected = chooseLatestCurrentReportSet([older, newer]);
  assert.equal(selected, newer);
  const publicValue = publicLatestCurrentSelection(selected);
  assert.deepEqual(publicValue.inputs.map((entry) => entry.kind), ["smoke", "sdd", "acceptance", "activationManifest"]);
  assert.doesNotMatch(JSON.stringify(publicValue), /private|path|\.json/);
  assert.throws(() => chooseLatestCurrentReportSet([]), /no current report set/i);
  assert.throws(() => chooseLatestCurrentReportSet([newer, reports("c", [2, 2, 2, 2])]), /ambiguous/i);
});

test("release evidence rejects incomplete writing-skills pressure evidence", () => {
  const current = sourceManifest();
  const value = evidence(current);
  value.runtime.roleSmoke.writingSkillsAdapter.greenRuns = 4;
  const finalized = finalizeReleaseEvidence(value);
  const markdown = renderReleaseEvidence(finalized);
  const result = validateReleaseEvidence({
    evidence: finalized,
    markdown,
    currentSource: current,
  });
  assert.equal(result.pass, false);
  assert.equal(result.checks.writingSkillsAdapterPassed, false);
});

test("active installation summary accepts only privacy-safe Sol Max or Ultra evidence", () => {
  const value = evidence().runtime.activation;
  assert.equal(validateActiveInstallationSummary(value).pass, true);
  assert.equal(validateActiveInstallationSummary({
    ...value,
    activeConfigSha256: value.preInstallConfigSha256,
  }).pass, true);
  assert.equal(validateActiveInstallationSummary({
    ...value,
    root: { ...value.root, effort: "ultra" },
  }).pass, true);
  assert.equal(validateActiveInstallationSummary({
    ...value,
    root: { ...value.root, effort: "high" },
  }).pass, false);
  assert.equal(validateActiveInstallationSummary({
    ...value,
    manifestPath: "/private/report",
  }).pass, false);
});

test("active config binding accepts idempotent apply and rejects binding drift", () => {
  const digest = "a".repeat(64);
  assert.equal(validateActiveConfigBinding({
    preInstallConfigSha256: digest,
    activeConfigSha256: digest,
    acceptanceConfigSha256: digest,
    currentConfigSha256: digest,
  }), true);
  assert.equal(validateActiveConfigBinding({
    preInstallConfigSha256: digest,
    activeConfigSha256: "b".repeat(64),
    acceptanceConfigSha256: digest,
    currentConfigSha256: "c".repeat(64),
  }), false);
  assert.equal(validateActiveConfigBinding({
    preInstallConfigSha256: "invalid",
    activeConfigSha256: digest,
    acceptanceConfigSha256: "invalid",
    currentConfigSha256: digest,
  }), false);
});

test("release evidence requires a sanitized, complete acceptance summary", () => {
  const current = sourceManifest();
  const value = evidence(current);
  const incomplete = finalizeReleaseEvidence({
    ...value,
    runtime: { ...value.runtime, acceptanceExam: { ...value.runtime.acceptanceExam, questionCount: 9 } },
  });
  const incompleteResult = validateReleaseEvidence({
    evidence: incomplete,
    markdown: renderReleaseEvidence(incomplete),
    currentSource: current,
  });
  assert.equal(incompleteResult.pass, false);
  assert.equal(incompleteResult.checks.acceptanceExam, false);

  const unsafe = finalizeReleaseEvidence({
    ...value,
    runtime: {
      ...value.runtime,
      acceptanceExam: { ...value.runtime.acceptanceExam, rawOutput: "private" },
    },
  });
  const unsafeResult = validateReleaseEvidence({
    evidence: unsafe,
    markdown: renderReleaseEvidence(unsafe),
    currentSource: current,
  });
  assert.equal(unsafeResult.pass, false);
  assert.equal(unsafeResult.checks.acceptanceExam, false);
});

test("release evidence becomes stale when any source file changes", () => {
  const original = sourceManifest();
  const value = evidence(original);
  const changed = sourceManifest({
    "lib/gearbox.mjs": "export const value = 2;\n",
  });
  const result = validateReleaseEvidence({
    evidence: value,
    markdown: renderReleaseEvidence(value),
    currentSource: changed,
  });
  assert.equal(result.pass, false);
  assert.equal(result.checks.sourceMatches, false);
});

test("release evidence rejects hand-edited Markdown and failed proof", () => {
  const current = sourceManifest();
  const value = evidence(current);
  const handEdited = `${renderReleaseEvidence(value)}\nmanual claim\n`;
  assert.equal(
    validateReleaseEvidence({ evidence: value, markdown: handEdited, currentSource: current })
      .checks.markdownMatches,
    false,
  );

  const failedTests = finalizeReleaseEvidence({
    ...value,
    tests: { ...value.tests, status: "fail", failed: 1 },
  });
  assert.equal(
    validateReleaseEvidence({
      evidence: failedTests,
      markdown: renderReleaseEvidence(failedTests),
      currentSource: current,
    }).pass,
    false,
  );
});

test("release evidence never publishes an estimator before ten pairs", () => {
  const current = sourceManifest();
  const unsafe = finalizeReleaseEvidence({
    ...evidence(current),
    costEvidence: {
      kind: "real_work",
      observedRuntime: evidence(current).costEvidence.observedRuntime,
      completePairCount: 9,
      requiredPairCount: 10,
      eligibleForEstimate: false,
      estimatorPublished: true,
    },
  });
  const result = validateReleaseEvidence({
    evidence: unsafe,
    markdown: renderReleaseEvidence(unsafe),
    currentSource: current,
  });
  assert.equal(result.pass, false);
  assert.equal(result.checks.costBoundary, false);
});

test("release evidence keeps observed child usage distinct from paired estimates", () => {
  const current = sourceManifest();
  const value = evidence(current);
  const markdown = renderReleaseEvidence(value);
  assert.match(markdown, /Observed typed child runtime: 1 session, 1 completed turn/);
  assert.match(markdown, /Child-only runtime evidence is not a root-inclusive task cost/);
  assert.match(markdown, /Complete comparable pairs: 0\/10/);

  const inconsistent = finalizeReleaseEvidence({
    ...value,
    costEvidence: {
      ...value.costEvidence,
      observedRuntime: {
        ...value.costEvidence.observedRuntime,
        childSessionCount: 2,
      },
    },
  });
  const result = validateReleaseEvidence({
    evidence: inconsistent,
    markdown: renderReleaseEvidence(inconsistent),
    currentSource: current,
  });
  assert.equal(result.pass, false);
  assert.equal(result.checks.observedRuntimeBoundary, false);
});

test("source manifest excludes generated evidence and raw reports", () => {
  assert.deepEqual(
    evidenceSourcePaths([
      "scripts/gearbox.mjs",
      "docs/release-evidence.json",
      "docs/RELEASE_EVIDENCE.md",
      "reports/local/smoke.json",
      "README.md",
    ]),
    ["README.md", "scripts/gearbox.mjs"],
  );
});

test("release reuse compares runtime components without binding to docs-only commits", () => {
  const base = {
    codexVersion: "codex-cli 1.0.0",
    configSha256: "a".repeat(64),
    roleHashes: { terra_worker: "b".repeat(64) },
    runtimeHashes: { "lib/gearbox.mjs": "c".repeat(64) },
  };
  assert.equal(
    runtimeBindingComponentsMatch(
      { ...base, git: { head: "1".repeat(40) } },
      { ...base, git: { head: "2".repeat(40) } },
    ),
    true,
  );
  assert.equal(
    runtimeBindingComponentsMatch(base, {
      ...base,
      runtimeHashes: { "lib/gearbox.mjs": "d".repeat(64) },
    }),
    false,
  );
});

test("source manifest refuses symlinked release inputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gearbox-release-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "target.txt"), "public\n", "utf8");
  await symlink(join(root, "target.txt"), join(root, "linked.txt"));
  await assert.rejects(
    createRepositorySourceManifest(root, ["linked.txt"]),
    /refuses non-regular file/,
  );
});
