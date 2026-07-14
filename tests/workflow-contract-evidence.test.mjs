import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  SCENARIOS,
  WORKFLOW_CONTRACT_SOURCE_PATHS,
  buildWorkflowContractEvidence,
  validateWorkflowContractEvidence,
} from "../lib/workflow-contract-evidence.mjs";
import { repositoryPath } from "../scripts/workflow-contract-evidence.mjs";

const CONTRACT = Object.freeze({
  stageOrderPreserved: true,
  selfContainedHandoff: true,
  firstRealExecutionCanary: true,
  futureCapacityReserved: true,
  resultAdoptionExplicit: true,
  typedIdentityRequired: true,
  permissionsRequired: true,
  runtimeEvidenceRequired: true,
  resumableWithoutDuplicateWork: true,
  privacySafeOutcome: true,
});

test("workflow contract artifact executes the five exact real-module scenarios", () => {
  assert.deepEqual(SCENARIOS, [
    { id: "parallel_research_then_verify", requires: ["dag", "selfContainedPackets", "canary", "reservedVerification", "adoption"] },
    { id: "two_audits_then_writer", requires: ["dag", "readerBatch", "separateWriterRound", "oneWriter", "adoption"] },
    { id: "resume_after_adopted_stage", requires: ["hashBoundResume", "noDuplicateAdoptedWork", "artifactReadback"] },
    { id: "first_execution_fails_to_materialize", requires: ["canary", "deferredAttemptPreserved", "blocked"] },
    { id: "invalid_or_out_of_scope_artifact", requires: ["runtimeEvidence", "scopeRejection", "noAdoption", "noRetry"] },
  ]);
  const artifact = buildWorkflowContractEvidence();
  assert.deepEqual(Object.keys(artifact).sort(), ["kind", "passedScenarioCount", "scenarioCount", "scenarios", "schemaVersion", "sourceManifest"]);
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.kind, "verified_workflow_contract");
  assert.equal(artifact.scenarioCount, 5);
  assert.equal(artifact.passedScenarioCount, 5);
  assert.equal(artifact.sourceManifest.length, WORKFLOW_CONTRACT_SOURCE_PATHS.length);
  assert.deepEqual(artifact.scenarios, SCENARIOS.map(({ id }) => ({ id, pass: true, contract: CONTRACT })));
  assert.equal(validateWorkflowContractEvidence(artifact).pass, true);
  assert.doesNotMatch(JSON.stringify(artifact), /goal|prompt|\/Users\/|call_id|executionId|canonicalTaskName|tool output/i);
});

test("workflow contract artifact fails closed for source or contract drift", () => {
  const artifact = buildWorkflowContractEvidence();
  const sourceDrift = structuredClone(artifact);
  sourceDrift.sourceManifest[0].sha256 = "0".repeat(64);
  assert.equal(validateWorkflowContractEvidence(sourceDrift).pass, false);
  const contractDrift = structuredClone(artifact);
  contractDrift.scenarios[0].contract.privacySafeOutcome = false;
  assert.equal(validateWorkflowContractEvidence(contractDrift).pass, false);
});

test("workflow evidence path rejects escapes and every symlinked parent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gearbox-workflow-evidence-root-"));
  const outside = await mkdtemp(join(tmpdir(), "gearbox-workflow-evidence-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(join(outside, "nested"));
  await symlink(outside, join(root, "linked"));

  assert.equal(await repositoryPath("evidence.json", root), join(await realpath(root), "evidence.json"));
  await assert.rejects(repositoryPath("../escape.json", root), /escapes repository/);
  await assert.rejects(repositoryPath("linked/nested/evidence.json", root), /symlink/);
  await assert.rejects(repositoryPath(resolve(outside, "evidence.json"), root), /repository-relative/);
});
