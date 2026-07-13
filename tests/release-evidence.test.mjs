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
  validateReleaseEvidence,
} from "../lib/release-evidence.mjs";

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
      roleSmoke: {
        status: "pass",
        expectedRoleCount: 6,
        passedRoleCount: 6,
        rootVerified: true,
        commit: "a".repeat(40),
      },
      sddAdapter: {
        status: "pass",
        phases: ["terra_worker", "sol_reviewer"],
        commit: "a".repeat(40),
      },
    },
    costEvidence: {
      kind: "real_work",
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
