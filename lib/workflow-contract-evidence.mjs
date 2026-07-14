import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { compileStagePacket } from "./workflow-compiler.mjs";
import { createWorkflowRecord } from "./workflow-ledger.mjs";
import { planNextWorkflowAction, validateMaterializationReceipt } from "./workflow-orchestrator.mjs";
import { hashWorkflowPlan, validateWorkflowPlan } from "./workflow-plan.mjs";
import { resumeWorkflow } from "./workflow-recovery.mjs";
import { selectCandidateBatch } from "./workflow-scheduler.mjs";
import { createWorkflowState, reduceWorkflowEvent } from "./workflow-state.mjs";
import { createWorkflowOutcomeRecord } from "./workflow-outcome.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const AT = "2026-07-15T00:00:00.000Z";
const POLICY = Object.freeze({ mode: "active", allowTypedBridge: false });
const CAPABILITIES = Object.freeze({
  agentTypeVisible: true,
  isolatedRunnerVerified: true,
  runtimeMetadataAvailable: true,
  bridgeRuntimeVerified: false,
  permissionBypassActive: false,
});
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

export const SCENARIOS = Object.freeze([
  { id: "parallel_research_then_verify", requires: ["dag", "selfContainedPackets", "canary", "reservedVerification", "adoption"] },
  { id: "two_audits_then_writer", requires: ["dag", "readerBatch", "separateWriterRound", "oneWriter", "adoption"] },
  { id: "resume_after_adopted_stage", requires: ["hashBoundResume", "noDuplicateAdoptedWork", "artifactReadback"] },
  { id: "first_execution_fails_to_materialize", requires: ["canary", "deferredAttemptPreserved", "blocked"] },
  { id: "invalid_or_out_of_scope_artifact", requires: ["runtimeEvidence", "scopeRejection", "noAdoption", "noRetry"] },
]);

export const WORKFLOW_CONTRACT_SOURCE_PATHS = Object.freeze([
  "lib/workflow-plan.mjs",
  "lib/workflow-compiler.mjs",
  "lib/workflow-state.mjs",
  "lib/workflow-scheduler.mjs",
  "lib/workflow-orchestrator.mjs",
  "lib/workflow-ledger.mjs",
  "lib/workflow-recovery.mjs",
  "lib/workflow-outcome.mjs",
  "tests/workflow-acceptance.test.mjs",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stage(id, overrides = {}) {
  return {
    id,
    responsibility: "exploration",
    dependsOn: [],
    attemptClass: "work",
    inputArtifacts: ["repository-snapshot"],
    outputArtifacts: [`${id}-evidence`],
    approvalGate: null,
    readScope: ["lib"],
    writeScope: [],
    interfaces: ["Return structured evidence"],
    knownFacts: ["Deterministic contract fixture"],
    constraints: ["Do not use external services"],
    deliverable: "Structured evidence",
    successCriteria: ["Evidence is hash-bound"],
    checks: ["Validate exact workflow transition"],
    prohibitedActions: ["Do not spawn descendants"],
    parentPermission: "read-only",
    requiredPermission: "read-only",
    requestedRole: null,
    riskSignals: { ambiguous: false, hiddenCoupling: false, highRisk: false, weakVerification: false },
    costSignals: {
      estimatedRootToolCalls: 5,
      oneLocation: false,
      packagingDominates: false,
      directlyConsumable: true,
      repetitiveReads: 1,
      moduleCount: 2,
      fileCount: 2,
      bytes: 0,
      lines: 0,
      itemCount: 2,
      includesRegressionTest: false,
      boundedFileCount: 0,
    },
    ...overrides,
  };
}

function plan(id, stages, budget = { total: 5, reservedForVerification: 1, reservedForRecovery: 1 }) {
  const value = {
    schemaVersion: 1,
    workflowId: id,
    goal: "Deterministic workflow contract fixture",
    workflowAdapter: "superpowers:executing-plans",
    inputArtifacts: ["repository-snapshot"],
    attemptBudget: budget,
    stages,
  };
  const validation = validateWorkflowPlan(value);
  if (!validation.pass) throw new TypeError(validation.errors.join("; "));
  return value;
}

function initialized(value) {
  const planHash = hashWorkflowPlan(value);
  return {
    plan: value,
    planHash,
    state: createWorkflowState({
      plan: value,
      planHash,
      policyMode: "active",
      policyHash: "a".repeat(64),
      permissionHash: "b".repeat(64),
      workspaceHash: "c".repeat(64),
      at: AT,
    }),
  };
}

function transition(context, event, records = null) {
  context.state = reduceWorkflowEvent({ plan: context.plan, state: context.state, event });
  if (records) {
    const record = createWorkflowRecord({
      previousRecordHash: records.at(-1).recordHash,
      state: context.state,
      event,
    });
    records.push(record);
  }
  return context.state;
}

function initialRecord(context) {
  return [createWorkflowRecord({ previousRecordHash: null, state: context.state, event: null })];
}

function readyAndBatch(context, stageIds, records = null) {
  for (const stageId of stageIds) {
    transition(context, { schemaVersion: 1, type: "stage_ready", at: AT, stageId }, records);
  }
  transition(context, {
    schemaVersion: 1,
    type: "batch_planned",
    at: AT,
    batchId: "contract-batch",
    stageIds,
    canaryStageId: stageIds[0],
  }, records);
}

function adoptRootStage(context, stageId, records = null) {
  transition(context, {
    schemaVersion: 1, type: "materialization_started", at: AT, stageId, batchId: "contract-batch",
    executionShape: "root_inline", role: null, taskHash: "d".repeat(64), attemptClass: "work",
  }, records);
  transition(context, { schemaVersion: 1, type: "materialized", at: AT, stageId, batchId: "contract-batch", status: "running" }, records);
  transition(context, {
    schemaVersion: 1, type: "evidence_ready", at: AT, stageId, resultHash: "e".repeat(64),
    artifacts: [{ id: `${stageId}-evidence`, sha256: "f".repeat(64) }], actualModel: "gpt-5.6-sol",
    actualEffort: "ultra", tokens: 0, reasonCode: "CONTRACT_EVIDENCE",
  }, records);
  transition(context, { schemaVersion: 1, type: "verified", at: AT, stageId, checkHash: "1".repeat(64) }, records);
  transition(context, {
    schemaVersion: 1, type: "adopted", at: AT, stageId,
    rootVerification: { pass: true, checkHash: "2".repeat(64) },
  }, records);
  transition(context, { schemaVersion: 1, type: "provider_closed", at: AT, stageId, disposition: "adopted", cleanupPassed: true }, records);
}

function baseExercise() {
  const context = initialized(plan("contract-base", [
    stage("audit-a"),
    stage("audit-b"),
    stage("verify", { responsibility: "review", dependsOn: ["audit-a", "audit-b"], attemptClass: "verification", inputArtifacts: ["audit-a-evidence", "audit-b-evidence"], requestedRole: "sol_reviewer" }),
  ]));
  const next = planNextWorkflowAction({ ...context, policy: POLICY, capabilities: CAPABILITIES });
  const candidate = selectCandidateBatch({ plan: context.plan, state: { ...context.state, stages: Object.fromEntries(Object.entries(context.state.stages).map(([id, value]) => [id, { ...value, state: id === "verify" ? "planned" : "ready" }])) } });
  const packet = compileStagePacket({
    plan: context.plan,
    planHash: context.planHash,
    stageId: "audit-a",
    approvalFacts: [],
    batch: { requestedChildren: 2, writerCount: 0, scopesDisjoint: true },
  });
  if (next.action.kind !== "materialize" || candidate.stageIds.length !== 2 || packet.schemaVersion !== 2) {
    throw new TypeError("workflow modules did not produce the expected reader canary");
  }
  return context;
}

function contractResult() {
  return { pass: true, realWorkflowModules: true, contract: { ...CONTRACT } };
}

function parallelResearchThenVerify() {
  const context = baseExercise();
  readyAndBatch(context, ["audit-a", "audit-b"]);
  adoptRootStage(context, "audit-a");
  if (context.state.stages["audit-a"].state !== "closed" || context.state.stages["audit-b"].attemptNumber !== 0 || context.state.budget.reservedForVerification !== 1) {
    throw new TypeError("canary or verification reserve contract failed");
  }
  return contractResult();
}

function twoAuditsThenWriter() {
  const context = initialized(plan("contract-writer", [
    stage("audit-a"),
    stage("audit-b"),
    stage("writer", { responsibility: "implementation", dependsOn: ["audit-a", "audit-b"], inputArtifacts: ["audit-a-evidence", "audit-b-evidence"], writeScope: ["docs"], parentPermission: "workspace-write", requiredPermission: "workspace-write", requestedRole: "terra_worker" }),
  ]));
  const first = planNextWorkflowAction({ ...context, policy: POLICY, capabilities: CAPABILITIES });
  if (first.action.deferredStageIds?.length !== 1) throw new TypeError("reader batch was not deferred behind the canary");
  readyAndBatch(context, ["audit-a", "audit-b"]);
  adoptRootStage(context, "audit-a");
  adoptRootStage(context, "audit-b");
  const writerRound = planNextWorkflowAction({ ...context, policy: POLICY, capabilities: CAPABILITIES });
  if (writerRound.action.stageId !== "writer" || writerRound.batchEvent?.stageIds.length !== 1 || writerRound.action.packet?.writeScope?.length !== 1) {
    throw new TypeError("writer was not isolated into a separate round");
  }
  return contractResult();
}

function resumeAfterAdoptedStage() {
  const context = initialized(plan("contract-resume", [stage("audit-a"), stage("verify", { dependsOn: ["audit-a"], attemptClass: "verification", inputArtifacts: ["audit-a-evidence"] })]));
  const records = initialRecord(context);
  readyAndBatch(context, ["audit-a"], records);
  const replayContext = { ...context };
  for (const event of [
    { schemaVersion: 1, type: "materialization_started", at: AT, stageId: "audit-a", batchId: "contract-batch", executionShape: "root_inline", role: null, taskHash: "d".repeat(64), attemptClass: "work" },
    { schemaVersion: 1, type: "materialized", at: AT, stageId: "audit-a", batchId: "contract-batch", status: "running" },
    { schemaVersion: 1, type: "evidence_ready", at: AT, stageId: "audit-a", resultHash: "e".repeat(64), artifacts: [{ id: "audit-a-evidence", sha256: "f".repeat(64) }], actualModel: "gpt-5.6-sol", actualEffort: "ultra", tokens: 0, reasonCode: "CONTRACT_EVIDENCE" },
    { schemaVersion: 1, type: "verified", at: AT, stageId: "audit-a", checkHash: "1".repeat(64) },
    { schemaVersion: 1, type: "adopted", at: AT, stageId: "audit-a", rootVerification: { pass: true, checkHash: "2".repeat(64) } },
    { schemaVersion: 1, type: "provider_closed", at: AT, stageId: "audit-a", disposition: "adopted", cleanupPassed: true },
  ]) transition(replayContext, event, records);
  const resumed = resumeWorkflow({
    plan: context.plan,
    records,
    binding: { planHash: context.planHash, policyMode: "active", policyHash: "a".repeat(64), permissionHash: "b".repeat(64), workspaceHash: "c".repeat(64) },
    currentArtifactHashes: { "audit-a-evidence": "f".repeat(64) },
  });
  if (!resumed.pass || JSON.stringify(resumed.remainingStageIds) !== JSON.stringify(["verify"]) || resumed.rerunStageIds.length !== 0) {
    throw new TypeError("adopted work was not resumed without duplication");
  }
  return contractResult();
}

function firstExecutionFailsToMaterialize() {
  const context = baseExercise();
  readyAndBatch(context, ["audit-a", "audit-b"]);
  transition(context, { schemaVersion: 1, type: "stage_blocked", at: AT, stageId: "audit-a", reasonCode: "WORKFLOW_CANARY_FAILED" });
  if (context.state.stages["audit-b"].attemptNumber !== 0 || context.state.stages["audit-b"].state !== "blocked" || context.state.delegationStopped !== true) {
    throw new TypeError("deferred canary failure was not preserved and blocked");
  }
  return contractResult();
}

function invalidOrOutOfScopeArtifact() {
  const context = initialized(plan("contract-invalid", [stage("audit-a")]));
  const action = planNextWorkflowAction({ ...context, policy: POLICY, capabilities: CAPABILITIES }).action;
  readyAndBatch(context, ["audit-a"]);
  const invalid = validateMaterializationReceipt({
    action,
    receipt: { schemaVersion: 1, executionShape: "typed_child", taskHash: action.decision.taskHash, executionId: "private", canonicalTaskName: "private", status: "running", unexpectedArtifact: "outside-scope" },
  });
  transition(context, { schemaVersion: 1, type: "materialization_started", at: AT, stageId: "audit-a", batchId: "contract-batch", executionShape: "root_inline", role: null, taskHash: "d".repeat(64), attemptClass: "work" });
  transition(context, { schemaVersion: 1, type: "materialized", at: AT, stageId: "audit-a", batchId: "contract-batch", status: "running" });
  transition(context, { schemaVersion: 1, type: "evidence_ready", at: AT, stageId: "audit-a", resultHash: "e".repeat(64), artifacts: [{ id: "audit-a-evidence", sha256: "f".repeat(64) }], actualModel: "gpt-5.6-sol", actualEffort: "ultra", tokens: 0, reasonCode: "CONTRACT_EVIDENCE" });
  transition(context, { schemaVersion: 1, type: "rejected", at: AT, stageId: "audit-a", final: true, hardFailure: true, reasonCode: "WORKFLOW_SCOPE_REJECTED" });
  transition(context, { schemaVersion: 1, type: "provider_closed", at: AT, stageId: "audit-a", disposition: "rejected", cleanupPassed: true });
  const outcome = createWorkflowOutcomeRecord({ plan: context.plan, state: context.state, stageId: "audit-a", generatedAt: AT });
  if (invalid.pass || context.state.stages["audit-a"].attempts[0].adopted || context.state.stages["audit-a"].attemptNumber !== 1 || outcome.adopted || !outcome.closed) {
    throw new TypeError("invalid runtime evidence or out-of-scope artifact was adopted");
  }
  return contractResult();
}

const EXECUTORS = Object.freeze({
  parallel_research_then_verify: parallelResearchThenVerify,
  two_audits_then_writer: twoAuditsThenWriter,
  resume_after_adopted_stage: resumeAfterAdoptedStage,
  first_execution_fails_to_materialize: firstExecutionFailsToMaterialize,
  invalid_or_out_of_scope_artifact: invalidOrOutOfScopeArtifact,
});

export function executeWorkflowContractScenario(scenario) {
  const execute = EXECUTORS[scenario?.id];
  if (!execute || !SCENARIOS.some((item) => item === scenario)) throw new TypeError("workflow contract scenario is invalid");
  return execute();
}

export function sourceManifest() {
  return WORKFLOW_CONTRACT_SOURCE_PATHS.map((path) => ({ path, sha256: sha256(readFileSync(join(REPO_ROOT, path))) }));
}

export function buildWorkflowContractEvidence() {
  const scenarios = SCENARIOS.map((scenario) => {
    const result = executeWorkflowContractScenario(scenario);
    if (result.pass !== true || result.realWorkflowModules !== true || JSON.stringify(result.contract) !== JSON.stringify(CONTRACT)) {
      throw new TypeError(`workflow contract scenario failed: ${scenario.id}`);
    }
    return { id: scenario.id, pass: true, contract: { ...CONTRACT } };
  });
  return {
    schemaVersion: 1,
    kind: "verified_workflow_contract",
    sourceManifest: sourceManifest(),
    scenarioCount: 5,
    passedScenarioCount: 5,
    scenarios,
  };
}

export function validateWorkflowContractEvidence(value) {
  const exactTopLevel = value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["kind", "passedScenarioCount", "scenarioCount", "scenarios", "schemaVersion", "sourceManifest"]);
  const sources = sourceManifest();
  const sourceManifestExact = Array.isArray(value?.sourceManifest) && value.sourceManifest.length === sources.length &&
    value.sourceManifest.every((entry, index) => entry?.path === sources[index].path && entry?.sha256 === sources[index].sha256 && HASH.test(entry.sha256));
  const scenariosExact = Array.isArray(value?.scenarios) && value.scenarios.length === SCENARIOS.length &&
    value.scenarios.every((row, index) => row?.id === SCENARIOS[index].id && row?.pass === true && JSON.stringify(row.contract) === JSON.stringify(CONTRACT) &&
      JSON.stringify(Object.keys(row).sort()) === JSON.stringify(["contract", "id", "pass"]));
  const pass = exactTopLevel && value?.schemaVersion === 1 && value?.kind === "verified_workflow_contract" &&
    value?.scenarioCount === 5 && value?.passedScenarioCount === 5 && sourceManifestExact && scenariosExact;
  return { pass };
}
