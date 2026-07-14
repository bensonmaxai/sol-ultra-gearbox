import assert from "node:assert/strict";
import test from "node:test";
import {
  compileStagePacket,
  validateWorkflowContext,
} from "../lib/workflow-compiler.mjs";
import {
  hashTaskPacket,
  planDispatch,
  renderTaskMessage,
  validateTaskPacket,
} from "../lib/dispatch-planner.mjs";
import { ROLE_SPECS } from "../lib/gearbox.mjs";
import { hashWorkflowPlan } from "../lib/workflow-plan.mjs";
import { workflowPlan } from "./helpers/workflow-fixtures.mjs";

const ACTIVE = { mode: "active", allowTypedBridge: false };
const CAPABILITIES = {
  agentTypeVisible: true,
  isolatedRunnerVerified: true,
  runtimeMetadataAvailable: true,
  bridgeRuntimeVerified: false,
  permissionBypassActive: false,
};

function packetV1(overrides = {}) {
  return {
    schemaVersion: 1,
    workflowAdapter: "direct",
    responsibility: "exploration",
    goal: "Trace the fixture request path",
    readScope: ["fixtures/src", "fixtures/tests"],
    writeScope: [],
    knownFacts: ["The fixture has two modules"],
    constraints: ["No writes"],
    deliverable: "Structured path evidence",
    successCriteria: ["Every hop names a file and symbol"],
    checks: ["Confirm at least five files were inspected"],
    prohibitedActions: ["Do not spawn descendants"],
    parentPermission: "workspace-write",
    requiredPermission: "read-only",
    requiresNativeLineage: false,
    requestedRole: null,
    ownerOptIn: false,
    legacyAdapter: false,
    batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
    riskSignals: {
      ambiguous: false,
      hiddenCoupling: false,
      highRisk: false,
      weakVerification: false,
    },
    costSignals: {
      estimatedRootToolCalls: 5,
      oneLocation: false,
      packagingDominates: false,
      directlyConsumable: true,
      repetitiveReads: 0,
      moduleCount: 2,
      fileCount: 5,
      bytes: 0,
      lines: 0,
      itemCount: 0,
      includesRegressionTest: false,
      boundedFileCount: 0,
    },
    ...overrides,
  };
}

function compiledPacket(overrides = {}) {
  const plan = workflowPlan();
  return compileStagePacket({
    plan,
    planHash: hashWorkflowPlan(plan),
    stageId: "verify-evidence",
    approvalFacts: [],
    batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
    ...overrides,
  });
}

function planDispatchFor(packet) {
  return planDispatch({
    policy: ACTIVE,
    packet,
    capabilities: CAPABILITIES,
    roleSpecs: ROLE_SPECS,
  });
}

test("compiler emits one exact stage-aware packet without parent history", () => {
  const plan = workflowPlan();
  const planHash = hashWorkflowPlan(plan);
  const packet = compileStagePacket({
    plan,
    planHash,
    stageId: "verify-evidence",
    approvalFacts: [],
    batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
  });
  assert.equal(packet.schemaVersion, 2);
  assert.deepEqual(packet.workflowContext, {
    workflowId: "verified-audit",
    planHash,
    stageId: "verify-evidence",
    dependsOn: ["audit-core", "audit-cli"],
    inputArtifacts: ["core-evidence", "cli-evidence"],
    outputArtifacts: ["verified-report"],
    interfaces: ["Return path, symbol, and evidence records"],
    attemptClass: "verification",
    missingInformationPolicy: "block_and_report",
  });
  assert.equal(validateTaskPacket(packet).pass, true);
  assert.doesNotMatch(renderTaskMessage(packet), /parent history/i);
});

test("packet v1 public behavior remains unchanged", () => {
  const value = packetV1();
  assert.equal(validateTaskPacket(value).pass, true);
  assert.equal(
    hashTaskPacket(value),
    "1e4bbcfa436914ccde5a3fea8faaf50625d47f87de07430579e01dd7e15bcdb4",
  );
  assert.equal(
    planDispatchFor(value).reasonCode,
    "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH",
  );
});

test("compiler fails closed for invalid plans, hashes, stages, and approval gates", () => {
  const plan = workflowPlan();
  const planHash = hashWorkflowPlan(plan);
  assert.throws(
    () => compileStagePacket({
      plan: { ...plan, workflowId: "changed-workflow" },
      planHash,
      stageId: "verify-evidence",
      approvalFacts: [],
      batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
    }),
    /workflow plan must be valid and hash-bound/,
  );
  assert.throws(
    () => compileStagePacket({
      plan,
      planHash,
      stageId: "unknown-stage",
      approvalFacts: [],
      batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
    }),
    /workflow stage is unknown/,
  );
  const gated = structuredClone(plan);
  gated.stages[2].approvalGate = {
    authority: "owner",
    factId: "review-approved",
    purpose: "stage_execution",
  };
  const gatedHash = hashWorkflowPlan(gated);
  assert.throws(
    () => compileStagePacket({
      plan: gated,
      planHash: gatedHash,
      stageId: "verify-evidence",
      approvalFacts: [],
      batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
    }),
    /workflow stage approval is not satisfied/,
  );
  assert.equal(
    compileStagePacket({
      plan: gated,
      planHash: gatedHash,
      stageId: "verify-evidence",
      approvalFacts: [{
        authority: "owner",
        factId: "review-approved",
        scopeHash: gatedHash,
      }],
      batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
    }).ownerOptIn,
    true,
  );
});

test("packet v2 rejects malformed workflow context without weakening v1", () => {
  const value = compiledPacket();
  const cases = [
    ["missing context field", (context) => delete context.stageId],
    ["extra context field", (context) => context.extra = true],
    ["invalid plan hash", (context) => context.planHash = "not-a-hash"],
    ["unknown stage", (context) => context.stageId = "unknown stage"],
    ["unknown artifact", (context) => context.inputArtifacts = ["unknown artifact"]],
    ["unknown attempt class", (context) => context.attemptClass = "unknown"],
    ["invalid missing-information policy", (context) => context.missingInformationPolicy = "guess"],
  ];
  for (const [label, mutate] of cases) {
    const invalid = structuredClone(value);
    mutate(invalid.workflowContext);
    assert.equal(validateTaskPacket(invalid).pass, false, label);
  }
  assert.equal(validateWorkflowContext(value.workflowContext).pass, true);
  assert.equal(validateTaskPacket(packetV1()).pass, true);
});

test("v2 workflow sections precede the original nine sections in order", () => {
  const message = renderTaskMessage(compiledPacket());
  const sections = [
    "Workflow stage:",
    "Dependencies:",
    "Available input artifacts:",
    "Required output artifacts:",
    "Stage interfaces:",
    "Attempt class:",
    "Missing information policy:",
    "Goal:",
    "Allowed read scope:",
    "Allowed write scope:",
    "Known facts:",
    "Constraints:",
    "Expected deliverable:",
    "Success criteria:",
    "Required checks:",
    "Prohibited actions:",
  ];
  let previous = -1;
  for (const section of sections) {
    const index = message.indexOf(section);
    assert.ok(index > previous, `${section} is ordered`);
    previous = index;
  }
});

test("equivalent valid v1 and v2 packets select the same role and shape", () => {
  const v1 = packetV1();
  const plan = workflowPlan({ workflowAdapter: "direct" });
  plan.stages[2] = {
    ...plan.stages[2],
    responsibility: "exploration",
    requestedRole: null,
  };
  const v2 = compileStagePacket({
    plan,
    planHash: hashWorkflowPlan(plan),
    stageId: "verify-evidence",
    approvalFacts: [],
    batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
  });
  const v1Decision = planDispatchFor(v1);
  const v2Decision = planDispatchFor(v2);
  assert.equal(v2Decision.role, v1Decision.role);
  assert.equal(v2Decision.selectedShape, v1Decision.selectedShape);
  assert.equal(v2Decision.effectiveShape, v1Decision.effectiveShape);
  assert.equal(v2Decision.reasonCode, v1Decision.reasonCode);
});
