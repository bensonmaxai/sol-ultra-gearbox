import assert from "node:assert/strict";
import test from "node:test";
import { hashWorkflowPlan } from "../lib/workflow-plan.mjs";
import {
  createWorkflowState,
  reduceWorkflowEvent,
  sanitizeWorkflowEventForLedger,
  STAGE_STATES,
  validateWorkflowEvent,
  workflowStateSummary,
} from "../lib/workflow-state.mjs";
import { workflowPlan } from "./helpers/workflow-fixtures.mjs";

const HASH = (letter) => letter.repeat(64);
let tick = 0;

function event(type, fields = {}) {
  tick += 1;
  return { schemaVersion: 1, type, at: `2026-07-15T00:00:${String(tick).padStart(2, "0")}.000Z`, ...fields };
}

function initializedWorkflow(plan = workflowPlan()) {
  const planHash = hashWorkflowPlan(plan);
  return {
    plan,
    planHash,
    state: createWorkflowState({
      plan,
      planHash,
      policyMode: "active",
      policyHash: HASH("a"),
      permissionHash: HASH("b"),
      workspaceHash: HASH("c"),
      at: "2026-07-15T00:00:00.000Z",
    }),
  };
}

function apply(plan, state, item) {
  return reduceWorkflowEvent({ plan, state, event: item });
}

function startCanary(plan, state, { shape = "typed_child", attemptClass = "work" } = {}) {
  let next = apply(plan, state, event("stage_ready", { stageId: "audit-core" }));
  next = apply(plan, next, event("stage_ready", { stageId: "audit-cli" }));
  next = apply(plan, next, event("batch_planned", {
    batchId: "batch-1", stageIds: ["audit-core", "audit-cli"], canaryStageId: "audit-core",
  }));
  return apply(plan, next, event("materialization_started", {
    stageId: "audit-core", batchId: "batch-1", executionShape: shape,
    role: shape === "root_inline" ? null : "terra_explorer", taskHash: HASH("a"), attemptClass,
  }));
}

function materialize(plan, state, overrides = {}) {
  const attempt = state.stages["audit-core"].attempts.at(-1);
  const fields = attempt.executionShape === "root_inline"
    ? { stageId: "audit-core", batchId: "batch-1", status: "running" }
    : { stageId: "audit-core", batchId: "batch-1", executionId: "agent-actual-1", canonicalTaskName: "/root/audit_core", status: "running" };
  return apply(plan, state, event("materialized", { ...fields, ...overrides }));
}

function evidence(plan, state) {
  let next = materialize(plan, state);
  next = apply(plan, next, event("evidence_ready", {
    stageId: "audit-core", resultHash: HASH("b"), artifacts: [{ id: "core-evidence", sha256: HASH("c") }],
    actualModel: "gpt-5.6-terra", actualEffort: "medium", tokens: 120,
    reasonCode: "DELEGATE_TYPED_PERMISSION_MATCH",
  }));
  return next;
}

test("stage requires verification, root adoption, and provider close", () => {
  const { plan, state } = initializedWorkflow();
  const verified = apply(plan, evidence(plan, startCanary(plan, state)), event("verified", {
    stageId: "audit-core", checkHash: HASH("d"),
  }));
  assert.equal(verified.stages["audit-core"].state, "verified");
  assert.equal(verified.stages["audit-core"].attempts[0].adopted, false);

  const adopted = apply(plan, verified, event("adopted", {
    stageId: "audit-core", rootVerification: { pass: true, checkHash: HASH("e") },
  }));
  assert.equal(adopted.stages["audit-core"].state, "adopted");
  assert.equal(adopted.stages["audit-core"].attempts[0].providerClosed, false);

  const closed = apply(plan, adopted, event("provider_closed", {
    stageId: "audit-core", disposition: "adopted", cleanupPassed: true,
  }));
  assert.equal(closed.stages["audit-core"].state, "closed");
});

test("validates exact event schemas and rejects invalid transitions immutably", () => {
  assert.deepEqual(STAGE_STATES, ["planned", "ready", "materializing", "running", "evidence_ready", "verified", "adopted", "rejected", "blocked", "closed"]);
  const valid = event("stage_ready", { stageId: "audit-core" });
  assert.equal(validateWorkflowEvent(valid).pass, true);
  assert.equal(validateWorkflowEvent({ ...valid, unexpected: true }).pass, false);
  assert.equal(validateWorkflowEvent({ schemaVersion: 1, type: "stage_ready", at: valid.at }).pass, false);
  const { plan, state } = initializedWorkflow();
  const rejectedTransitions = [
    event("materialized", { stageId: "audit-core", batchId: "batch-1", executionId: "x", canonicalTaskName: "/root/x", status: "running" }),
    event("adopted", { stageId: "audit-core", rootVerification: { pass: true, checkHash: HASH("e") } }),
    event("provider_closed", { stageId: "audit-core", disposition: "adopted", cleanupPassed: false }),
    event("correction_authorized", { stageId: "audit-core", scopeHash: hashWorkflowPlan(plan), executionShape: "typed_child" }),
  ];
  for (const item of rejectedTransitions) {
    const before = structuredClone(state);
    assert.throws(() => apply(plan, state, item), TypeError);
    assert.deepEqual(state, before);
  }
  const adopted = structuredClone(state);
  adopted.stages["audit-core"].state = "adopted";
  const beforeAdopted = structuredClone(adopted);
  assert.throws(() => apply(plan, adopted, event("stage_ready", { stageId: "audit-core" })), TypeError);
  assert.deepEqual(adopted, beforeAdopted);
  const closed = structuredClone(state);
  closed.stages["audit-core"].state = "closed";
  const beforeClosed = structuredClone(closed);
  assert.throws(() => apply(plan, closed, event("stage_ready", { stageId: "audit-core" })), TypeError);
  assert.deepEqual(closed, beforeClosed);
});

test("canary receipt gates deferred work and a failed canary atomically blocks the batch", () => {
  const { plan, state } = initializedWorkflow();
  const started = startCanary(plan, state);
  assert.throws(() => apply(plan, started, event("materialization_started", {
    stageId: "audit-cli", batchId: "batch-1", executionShape: "typed_child", role: "terra_explorer", taskHash: HASH("f"), attemptClass: "work",
  })), TypeError);
  const blocked = apply(plan, started, event("stage_blocked", { stageId: "audit-core", reasonCode: "CANARY_RECEIPT_FAILED" }));
  assert.equal(blocked.stages["audit-core"].attempts.length, 1);
  assert.equal(blocked.stages["audit-cli"].state, "blocked");
  assert.equal(blocked.stages["audit-cli"].blockedReasonCode, "WORKFLOW_CANARY_FAILED");
  assert.equal(blocked.delegationStopped, true);
  assert.equal(blocked.activeBatch, null);
});

test("delegated budgets preserve reserves, root inline is free, and one correction consumes recovery", () => {
  const { plan, state } = initializedWorkflow();
  const started = startCanary(plan, state);
  assert.deepEqual(started.stages["audit-core"].attempts[0].reservedAttemptsBefore, { verification: 1, recovery: 1 });
  assert.deepEqual(started.stages["audit-core"].attempts[0].reservedAttemptsAfter, { verification: 1, recovery: 1 });
  assert.deepEqual(started.budget.consumed, { total: 1, work: 1, verification: 0, recovery: 0 });

  const rootStarted = startCanary(plan, initializedWorkflow().state, { shape: "root_inline" });
  assert.deepEqual(rootStarted.budget.consumed, { total: 0, work: 0, verification: 0, recovery: 0 });

  let rejected = evidence(plan, started);
  rejected = apply(plan, rejected, event("rejected", { stageId: "audit-core", final: false, hardFailure: false, reasonCode: "EVIDENCE_INCOMPLETE" }));
  rejected = apply(plan, rejected, event("provider_closed", { stageId: "audit-core", disposition: "rejected", cleanupPassed: true }));
  const correction = apply(plan, rejected, event("correction_authorized", {
    stageId: "audit-core", scopeHash: hashWorkflowPlan(plan), executionShape: "typed_child",
  }));
  const recovery = apply(plan, correction, event("materialization_started", {
    stageId: "audit-core", batchId: "batch-1", executionShape: "typed_child", role: "terra_explorer", taskHash: HASH("d"), attemptClass: "recovery",
  }));
  assert.equal(recovery.budget.consumed.recovery, 1);
  assert.throws(() => apply(plan, recovery, event("correction_authorized", {
    stageId: "audit-core", scopeHash: hashWorkflowPlan(plan), executionShape: "typed_child",
  })), TypeError);
});

test("hard final rejections, cancellation, and rejected dependencies never unlock work", () => {
  const { plan, planHash, state } = initializedWorkflow();
  let failed = evidence(plan, startCanary(plan, state));
  failed = apply(plan, failed, event("rejected", { stageId: "audit-core", final: true, hardFailure: true, reasonCode: "RUNTIME_METADATA_MISMATCH" }));
  assert.equal(failed.delegationStopped, true);
  assert.throws(() => apply(plan, failed, event("correction_authorized", {
    stageId: "audit-core", scopeHash: planHash, executionShape: "typed_child",
  })), TypeError);
  assert.throws(() => apply(plan, failed, event("stage_ready", { stageId: "verify-evidence" })), TypeError);

  assert.throws(() => apply(plan, state, event("stage_cancelled", { stageId: "audit-cli", authority: "owner", factId: "cancel-cli" })), TypeError);
  let approved = apply(plan, state, event("approval_recorded", {
    authority: "owner", factId: "cancel-cli", scopeHash: planHash, recordedAt: "2026-07-15T00:00:00.000Z",
  }));
  approved = apply(plan, approved, event("stage_cancelled", { stageId: "audit-cli", authority: "owner", factId: "cancel-cli" }));
  assert.equal(approved.stages["audit-cli"].state, "closed");
  assert.equal(approved.stages["audit-cli"].cancelled, true);
});

test("sanitized materialization events replay without raw receipt identifiers", () => {
  const { plan, state } = initializedWorkflow();
  const started = startCanary(plan, state);
  const raw = event("materialized", {
    stageId: "audit-core", batchId: "batch-1", executionId: "agent-actual-1", canonicalTaskName: "/root/audit_core", status: "running",
  });
  const clean = sanitizeWorkflowEventForLedger(raw);
  assert.equal("executionId" in clean, false);
  assert.equal("canonicalTaskName" in clean, false);
  assert.match(clean.materializationHash, /^[a-f0-9]{64}$/);
  const replayed = apply(plan, started, clean);
  assert.equal(replayed.stages["audit-core"].attempts[0].materializationHash, clean.materializationHash);
  const durable = JSON.stringify(replayed);
  const summary = JSON.stringify(workflowStateSummary(replayed));
  assert.doesNotMatch(durable, /agent-actual-1|\/root\/audit_core/);
  assert.doesNotMatch(summary, /agent-actual-1|\/root\/audit_core/);
});
