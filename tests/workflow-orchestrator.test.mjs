import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ROLE_SPECS } from "../lib/gearbox.mjs";
import {
  planNextWorkflowAction,
  providerForDecision,
  validateMaterializationReceipt,
} from "../lib/workflow-orchestrator.mjs";
import { reduceWorkflowEvent, workflowStateSummary } from "../lib/workflow-state.mjs";
import { initializedWorkflow, stage, workflowPlan } from "./helpers/workflow-fixtures.mjs";

const policy = { mode: "active", allowTypedBridge: false };
const capabilities = {
  agentTypeVisible: true,
  isolatedRunnerVerified: true,
  runtimeMetadataAvailable: true,
  bridgeRuntimeVerified: false,
  permissionBypassActive: false,
};

test("orchestrator emits only the canary action and then the legal deferred member", () => {
  const { plan, planHash, state } = initializedWorkflow();
  const first = planNextWorkflowAction({ plan, planHash, state, policy, capabilities, roleSpecs: ROLE_SPECS });
  assert.deepEqual(first.readinessEvents.map((event) => event.stageId), ["audit-core", "audit-cli"]);
  assert.equal(first.action.kind, "materialize");
  assert.equal(first.action.stageId, "audit-core");
  assert.equal(first.action.canary, true);
  assert.deepEqual(first.action.deferredStageIds, ["audit-cli"]);

  const projected = structuredClone(state);
  for (const event of first.readinessEvents) projected.stages[event.stageId].state = "ready";
  projected.activeBatch = { batchId: first.batchEvent.batchId, stageIds: ["audit-core", "audit-cli"], canaryStageId: "audit-core", canaryReady: true };
  const second = planNextWorkflowAction({ plan, planHash, state: projected, policy, capabilities, roleSpecs: ROLE_SPECS });
  assert.equal(second.action.stageId, "audit-cli");
  assert.equal(second.action.canary, false);
  assert.equal(second.readinessEvents.length, 0);
});

test("root-inline and shadow decisions remain root-driven", () => {
  const { plan, planHash, state } = initializedWorkflow();
  const root = planNextWorkflowAction({
    plan, planHash, state, policy: { ...policy, mode: "shadow" }, capabilities, roleSpecs: ROLE_SPECS,
  });
  assert.equal(root.action.kind, "root_inline");
  assert.equal(root.action.decision.effectiveShape, "root_inline");
  assert.equal(root.batchEvent.stageIds.length, 1);

  const trivial = initializedWorkflow({
    plan: workflowPlan({ stages: [stage({ id: "trivial", costSignals: { ...stage().costSignals, estimatedRootToolCalls: 1 } })] }),
  });
  const direct = planNextWorkflowAction({ plan: trivial.plan, planHash: trivial.planHash, state: trivial.state, policy, capabilities, roleSpecs: ROLE_SPECS });
  assert.equal(direct.action.kind, "root_inline");
  assert.equal(direct.action.decision.selectedShape, "root_inline");
});

function assertWorkflowRoot(action, reasonCode) {
  assert.equal(action.kind, "root_inline");
  assert.equal(action.decision.selectedShape, "root_inline");
  assert.equal(action.decision.effectiveShape, "root_inline");
  assert.equal(action.decision.role, null);
  assert.equal(action.decision.spawnArgs, null);
  assert.equal(action.decision.reasonCode, reasonCode);
}

test("workflow-level reserve and stop outcomes never emit delegated actions", () => {
  const protectedWork = initializedWorkflow();
  protectedWork.state.budget.consumed.total = 2;
  assertWorkflowRoot(
    planNextWorkflowAction({ ...protectedWork, policy, capabilities, roleSpecs: ROLE_SPECS }).action,
    "ROOT_WORK_ATTEMPT_RESERVE_PROTECTED",
  );

  const exhaustedRecovery = initializedWorkflow({
    plan: workflowPlan({ stages: [stage({ id: "recover", attemptClass: "recovery" })] }),
  });
  exhaustedRecovery.state.budget.consumed.total = 3;
  exhaustedRecovery.state.budget.consumed.recovery = 1;
  assertWorkflowRoot(
    planNextWorkflowAction({ ...exhaustedRecovery, policy, capabilities, roleSpecs: ROLE_SPECS }).action,
    "ROOT_RECOVERY_RESERVE_EXHAUSTED",
  );

  const stopped = initializedWorkflow();
  stopped.state.delegationStopped = true;
  stopped.state.stopReason = "WORKFLOW_CANARY_FAILED";
  assertWorkflowRoot(
    planNextWorkflowAction({ ...stopped, policy, capabilities, roleSpecs: ROLE_SPECS }).action,
    "WORKFLOW_CANARY_FAILED",
  );
});

test("an active batch cannot emit a delegated deferred action after delegation stops", () => {
  const { plan, planHash, state } = initializedWorkflow();
  const first = planNextWorkflowAction({ plan, planHash, state, policy, capabilities, roleSpecs: ROLE_SPECS });
  let projected = state;
  for (const event of first.readinessEvents) projected = reduceWorkflowEvent({ plan, state: projected, event });
  projected = reduceWorkflowEvent({ plan, state: projected, event: first.batchEvent });
  projected.activeBatch.canaryReady = true;
  projected.delegationStopped = true;
  projected.stopReason = "WORKFLOW_CANARY_FAILED";
  const next = planNextWorkflowAction({ plan, planHash, state: projected, policy, capabilities, roleSpecs: ROLE_SPECS });
  assertWorkflowRoot(next.action, "WORKFLOW_CANARY_FAILED");
  assert.equal(next.action.stageId, "audit-cli");
});

test("typed receipts validate exact envelope and sanitize execution identities", () => {
  const action = {
    kind: "materialize",
    decision: { taskHash: "a".repeat(64), selectedShape: "typed_child", effectiveShape: "typed_child", role: "terra_explorer", spawnArgs: { agent_type: "terra_explorer", fork_turns: "none", message: "task" } },
  };
  const receipt = {
    schemaVersion: 1,
    executionShape: "typed_child",
    taskHash: action.decision.taskHash,
    executionId: "actual-agent-id",
    canonicalTaskName: "/root/task_name",
    status: "running",
  };
  const result = validateMaterializationReceipt({ action, receipt });
  assert.equal(result.pass, true);
  assert.deepEqual(Object.keys(result.sanitized).sort(), ["executionShape", "materializationHash", "status", "taskHash"]);
  assert.equal(JSON.stringify(result.sanitized).includes("actual-agent-id"), false);
  assert.equal(validateMaterializationReceipt({ action, receipt: { ...receipt, extra: true } }).pass, false);
});

test("providers reject shape and task mismatches and retain no raw identifiers", () => {
  const decision = { taskHash: "b".repeat(64), selectedShape: "root_inline", effectiveShape: "root_inline", role: null, spawnArgs: null };
  const provider = providerForDecision(decision);
  for (const method of ["capabilities", "materialize", "readiness", "collectEvidence", "close"]) {
    assert.equal(typeof provider[method], "function");
  }
  assert.deepEqual(provider.capabilities(), ["materialize", "readiness", "collectEvidence", "close"]);
  assert.throws(() => provider.materialize({ taskHash: "c".repeat(64) }), /task hash/);
  const action = provider.materialize({ taskHash: decision.taskHash, executionShape: "root_inline" });
  assert.equal(action.kind, "root_inline");
  assert.equal(JSON.stringify(action).includes("executionId"), false);
  assert.deepEqual(provider.close({
    taskHash: decision.taskHash,
    executionShape: "root_inline",
    disposition: "adopted",
  }), {
    kind: "provider_close",
    taskHash: decision.taskHash,
    executionShape: "root_inline",
    disposition: "adopted",
  });
});

test("canary timeout blocks deferred work without consuming its attempt", () => {
  const { plan, planHash, state } = initializedWorkflow();
  const first = planNextWorkflowAction({ plan, planHash, state, policy, capabilities, roleSpecs: ROLE_SPECS });
  let reduced = state;
  for (const event of first.readinessEvents) reduced = reduceWorkflowEvent({ plan, state: reduced, event });
  reduced = reduceWorkflowEvent({ plan, state: reduced, event: first.batchEvent });
  reduced = reduceWorkflowEvent({
    plan,
    state: reduced,
    event: { schemaVersion: 1, type: "stage_blocked", at: state.updatedAt, stageId: "audit-core", reasonCode: "WORKFLOW_CANARY_FAILED" },
  });
  assert.equal(reduced.stages["audit-cli"].attemptNumber, 0);
  assert.equal(reduced.stages["audit-cli"].state, "blocked");
  const next = planNextWorkflowAction({ plan, planHash, state: reduced, policy, capabilities, roleSpecs: ROLE_SPECS });
  assert.deepEqual(next.action, { kind: "blocked", reasonCode: "WORKFLOW_CANARY_FAILED" });
});

test("isolated receipt and every provider method reject mismatched shape or hash", () => {
  const decision = {
    taskHash: "d".repeat(64), selectedShape: "isolated_role_root", effectiveShape: "isolated_role_root", role: "terra_explorer", spawnArgs: null,
  };
  const provider = providerForDecision(decision);
  for (const method of ["materialize", "readiness", "collectEvidence", "close"]) {
    assert.throws(() => provider[method]({ taskHash: "e".repeat(64), executionShape: "typed_child" }), /execution shape or task hash/);
  }
  const action = { kind: "materialize", decision };
  assert.equal(validateMaterializationReceipt({
    action,
    receipt: { schemaVersion: 1, executionShape: "isolated_role_root", taskHash: decision.taskHash, dispatchResult: { pass: true }, status: "completed" },
  }).pass, false);
});

test("delegated evidence is root-validated while root-inline evidence remains root-owned", () => {
  const delegated = {
    taskHash: "f".repeat(64), selectedShape: "isolated_role_root", effectiveShape: "isolated_role_root", role: "terra_explorer", spawnArgs: null,
  };
  const delegatedProvider = providerForDecision(delegated);
  assert.throws(() => delegatedProvider.collectEvidence({
    taskHash: delegated.taskHash,
    executionShape: delegated.effectiveShape,
    dispatchResult: { pass: true },
  }), /dispatch result/);

  const root = { taskHash: "c".repeat(64), selectedShape: "root_inline", effectiveShape: "root_inline", role: null, spawnArgs: null };
  assert.deepEqual(providerForDecision(root).collectEvidence({ taskHash: root.taskHash, executionShape: "root_inline" }), {
    kind: "root_collect_evidence", taskHash: root.taskHash, executionShape: "root_inline",
  });
});

test("orchestrator actions and persisted summaries contain no raw execution identity", () => {
  const { plan, planHash, state } = initializedWorkflow();
  const next = planNextWorkflowAction({ plan, planHash, state, policy, capabilities, roleSpecs: ROLE_SPECS });
  assert.equal(/executionId|canonicalTaskName/.test(JSON.stringify(next)), false);
  assert.equal(/executionId|canonicalTaskName/.test(JSON.stringify(workflowStateSummary(state))), false);
});

test("provider materialization binds the root action to the exact task packet", () => {
  const { plan, planHash, state } = initializedWorkflow();
  const next = planNextWorkflowAction({ plan, planHash, state, policy, capabilities, roleSpecs: ROLE_SPECS });
  const provider = providerForDecision(next.action.decision);
  const input = {
    taskHash: next.action.decision.taskHash,
    executionShape: next.action.decision.effectiveShape,
    packet: next.action.packet,
  };
  const materialization = provider.materialize(input);
  assert.deepEqual(materialization.packet, next.action.packet);
  assert.throws(() => provider.materialize({ ...input, packet: { ...input.packet, goal: "forged" } }), /task packet/);
});
