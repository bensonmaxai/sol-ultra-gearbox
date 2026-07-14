import { createHash } from "node:crypto";
import { hashWorkflowPlan } from "./workflow-plan.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_:-]{1,127}$/;
const EXECUTION_SHAPES = new Set(["typed_child", "isolated_role_root", "root_inline"]);
const ATTEMPT_CLASSES = new Set(["work", "verification", "recovery"]);
const TERMINAL_BATCH_STATES = new Set(["adopted", "blocked", "closed"]);

export const STAGE_STATES = Object.freeze([
  "planned",
  "ready",
  "materializing",
  "running",
  "evidence_ready",
  "verified",
  "adopted",
  "rejected",
  "blocked",
  "closed",
]);

export const WORKFLOW_EVENT_TYPES = Object.freeze([
  "approval_recorded",
  "stage_ready",
  "batch_planned",
  "materialization_started",
  "materialized",
  "evidence_ready",
  "verified",
  "adopted",
  "rejected",
  "provider_closed",
  "correction_authorized",
  "stage_blocked",
  "stage_cancelled",
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isHash(value) {
  return typeof value === "string" && HASH.test(value);
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isSafeCode(value) {
  return typeof value === "string" && SAFE_CODE.test(value);
}

function hasKeys(event, fields) {
  return exactKeys(event, ["schemaVersion", "type", "at", ...fields]);
}

function eventSchema(event, variants, errors) {
  if (!variants.some((fields) => hasKeys(event, fields))) {
    errors.push(`event ${event.type} contains missing or extra fields`);
    return false;
  }
  return true;
}

function validateArtifacts(value, errors) {
  if (!Array.isArray(value) || value.some((artifact) => !exactKeys(artifact, ["id", "sha256"]) || !isSafeId(artifact.id) || !isHash(artifact.sha256))) {
    errors.push("artifacts must be exact safe id and sha256 records");
  }
}

export function validateWorkflowEvent(event) {
  const errors = [];
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return { pass: false, errors: ["event must be an object"] };
  }
  if (event.schemaVersion !== 1) errors.push("event schemaVersion must equal 1");
  if (!WORKFLOW_EVENT_TYPES.includes(event.type)) errors.push("event type is invalid");
  if (!isNonEmpty(event.at)) errors.push("event at must be a non-empty timestamp string");
  if (errors.length > 0) return { pass: false, errors };

  switch (event.type) {
    case "approval_recorded":
      eventSchema(event, [["authority", "factId", "scopeHash", "recordedAt"]], errors);
      if (!isSafeId(event.authority) || !isSafeId(event.factId) || !isHash(event.scopeHash) || !isNonEmpty(event.recordedAt)) errors.push("approval record is invalid");
      break;
    case "stage_ready":
      eventSchema(event, [["stageId"], ["stageId", "resolvedFact"]], errors);
      if (!isSafeId(event.stageId) || (Object.hasOwn(event, "resolvedFact") && !isNonEmpty(event.resolvedFact))) errors.push("stage_ready is invalid");
      break;
    case "batch_planned":
      eventSchema(event, [["batchId", "stageIds", "canaryStageId"]], errors);
      if (!isSafeId(event.batchId) || !Array.isArray(event.stageIds) || event.stageIds.some((id) => !isSafeId(id)) || !isSafeId(event.canaryStageId)) errors.push("batch_planned is invalid");
      break;
    case "materialization_started":
      eventSchema(event, [["stageId", "batchId", "executionShape", "role", "taskHash", "attemptClass"]], errors);
      if (!isSafeId(event.stageId) || !isSafeId(event.batchId) || !EXECUTION_SHAPES.has(event.executionShape) || !(event.role === null || isSafeId(event.role)) || !isHash(event.taskHash) || !ATTEMPT_CLASSES.has(event.attemptClass)) errors.push("materialization_started is invalid");
      break;
    case "materialized":
      eventSchema(event, [
        ["stageId", "batchId", "executionId", "canonicalTaskName", "status"],
        ["stageId", "batchId", "dispatchResult", "status"],
        ["stageId", "batchId", "materializationHash", "status"],
        ["stageId", "batchId", "status"],
      ], errors);
      if (!isSafeId(event.stageId) || !isSafeId(event.batchId) || !["running", "completed"].includes(event.status)) errors.push("materialized is invalid");
      if (Object.hasOwn(event, "executionId") && (!isNonEmpty(event.executionId) || !isNonEmpty(event.canonicalTaskName))) errors.push("typed receipt is invalid");
      if (Object.hasOwn(event, "dispatchResult") && (!event.dispatchResult || typeof event.dispatchResult !== "object" || Array.isArray(event.dispatchResult))) errors.push("isolated receipt is invalid");
      if (Object.hasOwn(event, "materializationHash") && !isHash(event.materializationHash)) errors.push("materialization hash is invalid");
      break;
    case "evidence_ready":
      eventSchema(event, [
        ["stageId", "resultHash", "artifacts", "actualModel", "actualEffort", "tokens", "reasonCode"],
        ["stageId", "resultHash", "artifacts", "actualModel", "actualEffort", "tokens", "reasonCode", "synthetic"],
      ], errors);
      if (!isSafeId(event.stageId) || !isHash(event.resultHash) || !isSafeId(event.actualModel) || !isSafeId(event.actualEffort) || !Number.isInteger(event.tokens) || event.tokens < 0 || !isSafeCode(event.reasonCode) || (Object.hasOwn(event, "synthetic") && typeof event.synthetic !== "boolean")) errors.push("evidence_ready is invalid");
      validateArtifacts(event.artifacts, errors);
      break;
    case "verified":
      eventSchema(event, [["stageId", "checkHash"]], errors);
      if (!isSafeId(event.stageId) || !isHash(event.checkHash)) errors.push("verified is invalid");
      break;
    case "adopted":
      eventSchema(event, [["stageId", "rootVerification"]], errors);
      if (!isSafeId(event.stageId) || !exactKeys(event.rootVerification, ["pass", "checkHash"]) || event.rootVerification.pass !== true || !isHash(event.rootVerification.checkHash)) errors.push("adopted is invalid");
      break;
    case "rejected":
      eventSchema(event, [["stageId", "final", "hardFailure", "reasonCode"]], errors);
      if (!isSafeId(event.stageId) || typeof event.final !== "boolean" || typeof event.hardFailure !== "boolean" || !isSafeCode(event.reasonCode)) errors.push("rejected is invalid");
      break;
    case "provider_closed":
      eventSchema(event, [["stageId", "disposition", "cleanupPassed"]], errors);
      if (!isSafeId(event.stageId) || !["adopted", "rejected"].includes(event.disposition) || typeof event.cleanupPassed !== "boolean") errors.push("provider_closed is invalid");
      break;
    case "correction_authorized":
      eventSchema(event, [["stageId", "scopeHash", "executionShape"]], errors);
      if (!isSafeId(event.stageId) || !isHash(event.scopeHash) || !EXECUTION_SHAPES.has(event.executionShape)) errors.push("correction_authorized is invalid");
      break;
    case "stage_blocked":
      eventSchema(event, [["stageId", "reasonCode"]], errors);
      if (!isSafeId(event.stageId) || !isSafeCode(event.reasonCode)) errors.push("stage_blocked is invalid");
      break;
    case "stage_cancelled":
      eventSchema(event, [["stageId", "authority", "factId"]], errors);
      if (!isSafeId(event.stageId) || event.authority !== "owner" || !isSafeId(event.factId)) errors.push("stage_cancelled is invalid");
      break;
    default:
      break;
  }
  return { pass: errors.length === 0, errors };
}

function requireValid(condition, message) {
  if (!condition) throw new TypeError(message);
}

function stageFor(plan, state, stageId) {
  const planStage = plan.stages.find((candidate) => candidate.id === stageId);
  const stage = state.stages[stageId];
  requireValid(Boolean(planStage && stage), "workflow stage is unknown");
  return { planStage, stage };
}

function dependenciesAdopted(plan, state, stage) {
  return stage.dependsOn.every((dependencyId) => {
    const dependency = state.stages[dependencyId];
    return dependency?.state === "adopted" || (dependency?.state === "closed" && dependency.attempts.some((attempt) => attempt.adopted));
  });
}

function approvalSatisfied(planStage, state, planHash) {
  if (planStage.approvalGate === null) return true;
  return state.approvalFacts.some((fact) => fact.authority === planStage.approvalGate.authority && fact.factId === planStage.approvalGate.factId && fact.scopeHash === planHash);
}

function remainingReserve(budget) {
  return {
    verification: budget.reservedForVerification - budget.consumed.verification,
    recovery: budget.reservedForRecovery - budget.consumed.recovery,
  };
}

function consumeBudget(state, attemptClass, delegated) {
  const before = remainingReserve(state.budget);
  if (!delegated) return { before, after: before };
  const { budget } = state;
  requireValid(budget.consumed.total < budget.total, "workflow attempt budget is exhausted");
  if (attemptClass === "work") {
    requireValid(budget.consumed.work < budget.total - budget.reservedForVerification - budget.reservedForRecovery, "work attempt reserve is exhausted");
  } else {
    requireValid(budget.consumed[attemptClass] < budget[`reservedFor${attemptClass[0].toUpperCase()}${attemptClass.slice(1)}`], `${attemptClass} attempt reserve is exhausted`);
  }
  budget.consumed.total += 1;
  budget.consumed[attemptClass] += 1;
  return { before, after: remainingReserve(budget) };
}

function clearCompletedBatch(state) {
  if (!state.activeBatch) return;
  const complete = state.activeBatch.stageIds.every((stageId) => {
    const stage = state.stages[stageId];
    return TERMINAL_BATCH_STATES.has(stage.state) || (stage.state === "rejected" && stage.finalRejection);
  });
  if (complete) state.activeBatch = null;
}

function currentAttempt(stage) {
  const attempt = stage.attempts.at(-1);
  requireValid(Boolean(attempt), "workflow stage has no active attempt");
  return attempt;
}

function materializationHash(planHash, stageId, attempt, event) {
  if (event.materializationHash) return event.materializationHash;
  if (attempt.executionShape === "typed_child") {
    requireValid(Object.hasOwn(event, "executionId") && Object.hasOwn(event, "canonicalTaskName"), "typed child receipt is required");
    return hash({ executionId: event.executionId, canonicalTaskName: event.canonicalTaskName });
  }
  if (attempt.executionShape === "isolated_role_root") {
    requireValid(Object.hasOwn(event, "dispatchResult") && event.status === "completed", "completed isolated receipt is required");
    return hash(event.dispatchResult);
  }
  requireValid(!Object.hasOwn(event, "executionId") && !Object.hasOwn(event, "canonicalTaskName") && !Object.hasOwn(event, "dispatchResult"), "root-inline receipt must not contain a process identifier");
  return hash({ planHash, stageId, taskHash: attempt.taskHash, attemptNumber: attempt.attemptNumber });
}

export function createWorkflowState({ plan, planHash, policyMode, policyHash, permissionHash, workspaceHash, at }) {
  requireValid(plan && typeof plan === "object" && Array.isArray(plan.stages), "workflow plan is required");
  requireValid(hashWorkflowPlan(plan) === planHash, "workflow plan must be hash-bound");
  requireValid(isNonEmpty(policyMode) && isHash(policyHash) && isHash(permissionHash) && isHash(workspaceHash) && isNonEmpty(at), "workflow state inputs are invalid");
  return {
    schemaVersion: 1,
    workflowId: plan.workflowId,
    planHash,
    policyMode,
    policyHash,
    permissionHash,
    workspaceHash,
    approvalFacts: [],
    budget: {
      ...plan.attemptBudget,
      consumed: { total: 0, work: 0, verification: 0, recovery: 0 },
    },
    delegationStopped: false,
    stopReason: null,
    stages: Object.fromEntries(plan.stages.map((stage) => [stage.id, {
      state: "planned",
      attemptNumber: 0,
      correctionUsed: false,
      finalRejection: false,
      attempts: [],
    }])),
    activeBatch: null,
    updatedAt: at,
  };
}

export function reduceWorkflowEvent({ plan, state, event }) {
  const validation = validateWorkflowEvent(event);
  requireValid(validation.pass, validation.errors.join("; "));
  requireValid(plan && state && state.workflowId === plan.workflowId && state.planHash === hashWorkflowPlan(plan), "workflow state is not bound to its plan");
  const next = structuredClone(state);

  switch (event.type) {
    case "approval_recorded": {
      requireValid(event.scopeHash === next.planHash, "approval scope hash must match plan hash");
      const fact = { authority: event.authority, factId: event.factId, scopeHash: event.scopeHash, recordedAt: event.recordedAt };
      requireValid(!next.approvalFacts.some((item) => item.authority === fact.authority && item.factId === fact.factId && item.scopeHash === fact.scopeHash), "approval fact is already recorded");
      next.approvalFacts.push(fact);
      break;
    }
    case "stage_ready": {
      const { planStage, stage } = stageFor(plan, next, event.stageId);
      requireValid(stage.state === "planned" || (stage.state === "blocked" && isNonEmpty(event.resolvedFact)), "stage is not eligible to become ready");
      requireValid(dependenciesAdopted(plan, next, planStage), "stage dependencies are not adopted");
      requireValid(approvalSatisfied(planStage, next, next.planHash), "stage approval is not satisfied");
      stage.state = "ready";
      delete stage.blockedReasonCode;
      break;
    }
    case "batch_planned": {
      requireValid(next.activeBatch === null, "workflow already has an active batch");
      requireValid(event.stageIds.length >= 1 && event.stageIds.length <= 2 && new Set(event.stageIds).size === event.stageIds.length, "batch must contain one or two unique stages");
      const plannedOrder = plan.stages.map((stage) => stage.id).filter((id) => event.stageIds.includes(id));
      requireValid(plannedOrder.length === event.stageIds.length && plannedOrder.every((id, index) => id === event.stageIds[index]), "batch stages must follow exact workflow order");
      requireValid(event.canaryStageId === event.stageIds[0], "batch canary must be the first stage");
      const batchStages = event.stageIds.map((stageId) => stageFor(plan, next, stageId));
      requireValid(batchStages.every(({ stage }) => stage.state === "ready"), "batch stages must be ready");
      requireValid(batchStages.length === 1 || !batchStages.some(({ planStage }) => planStage.writeScope.length > 0), "a writer cannot be mixed into a batch");
      next.activeBatch = { batchId: event.batchId, stageIds: [...event.stageIds], canaryStageId: event.canaryStageId, canaryReady: false };
      break;
    }
    case "materialization_started": {
      const { planStage, stage } = stageFor(plan, next, event.stageId);
      requireValid(stage.state === "ready", "stage must be ready to materialize");
      requireValid(next.activeBatch?.batchId === event.batchId && next.activeBatch.stageIds.includes(event.stageId), "stage is not in the active batch");
      requireValid(event.stageId === next.activeBatch.canaryStageId || next.activeBatch.canaryReady, "deferred stage requires a canary receipt");
      requireValid(!next.delegationStopped || event.executionShape === "root_inline", "delegated workflow actions are stopped");
      requireValid((event.executionShape === "root_inline" && event.role === null) || (event.executionShape !== "root_inline" && event.role !== null), "execution shape role is invalid");
      const correctionAttempt = stage.correctionUsed && event.attemptClass === "recovery";
      requireValid(event.attemptClass === planStage.attemptClass || correctionAttempt, "attempt class does not match workflow stage");
      const reserve = consumeBudget(next, event.attemptClass, event.executionShape !== "root_inline");
      stage.attemptNumber += 1;
      stage.state = "materializing";
      stage.attempts.push({
        attemptNumber: stage.attemptNumber,
        executionShape: event.executionShape,
        role: event.role,
        taskHash: event.taskHash,
        attemptClass: event.attemptClass,
        reservedAttemptsBefore: reserve.before,
        reservedAttemptsAfter: reserve.after,
        providerClosed: false,
        adopted: false,
      });
      break;
    }
    case "materialized": {
      const { stage } = stageFor(plan, next, event.stageId);
      requireValid(stage.state === "materializing" && next.activeBatch?.batchId === event.batchId, "stage is not materializing in the active batch");
      const attempt = currentAttempt(stage);
      const receiptHash = materializationHash(next.planHash, event.stageId, attempt, event);
      stage.state = "running";
      attempt.materializationHash = receiptHash;
      if (next.activeBatch.canaryStageId === event.stageId) next.activeBatch.canaryReady = true;
      break;
    }
    case "evidence_ready": {
      const { stage } = stageFor(plan, next, event.stageId);
      requireValid(stage.state === "running", "stage must be running before evidence is ready");
      const attempt = currentAttempt(stage);
      stage.state = "evidence_ready";
      attempt.resultHash = event.resultHash;
      attempt.artifacts = event.artifacts.map((artifact) => ({ id: artifact.id, sha256: artifact.sha256 }));
      attempt.actualModel = event.actualModel;
      attempt.actualEffort = event.actualEffort;
      attempt.tokens = event.tokens;
      attempt.reasonCode = event.reasonCode;
      attempt.synthetic = event.synthetic ?? false;
      break;
    }
    case "verified": {
      const { stage } = stageFor(plan, next, event.stageId);
      requireValid(stage.state === "evidence_ready", "stage must have evidence before verification");
      stage.state = "verified";
      currentAttempt(stage).mechanicalCheckHash = event.checkHash;
      break;
    }
    case "adopted": {
      const { stage } = stageFor(plan, next, event.stageId);
      requireValid(stage.state === "verified", "stage must be verified before root adoption");
      stage.state = "adopted";
      const attempt = currentAttempt(stage);
      attempt.adopted = true;
      attempt.rootCheckHash = event.rootVerification.checkHash;
      clearCompletedBatch(next);
      break;
    }
    case "rejected": {
      const { stage } = stageFor(plan, next, event.stageId);
      requireValid(stage.state === "evidence_ready", "stage must have evidence before rejection");
      stage.state = "rejected";
      stage.finalRejection = event.final || event.hardFailure;
      const attempt = currentAttempt(stage);
      attempt.rejection = { final: stage.finalRejection, hardFailure: event.hardFailure, reasonCode: event.reasonCode };
      if (event.hardFailure) {
        next.delegationStopped = true;
        next.stopReason = event.reasonCode;
      }
      clearCompletedBatch(next);
      break;
    }
    case "provider_closed": {
      const { stage } = stageFor(plan, next, event.stageId);
      requireValid(event.cleanupPassed === true, "provider cleanup must pass");
      requireValid((event.disposition === "adopted" && stage.state === "adopted") || (event.disposition === "rejected" && stage.state === "rejected"), "provider disposition does not match stage");
      const attempt = currentAttempt(stage);
      requireValid(!attempt.providerClosed, "provider attempt is already closed");
      attempt.providerClosed = true;
      attempt.providerDisposition = event.disposition;
      if (stage.state === "adopted" || stage.finalRejection) stage.state = "closed";
      clearCompletedBatch(next);
      break;
    }
    case "correction_authorized": {
      const { stage } = stageFor(plan, next, event.stageId);
      requireValid(stage.state === "rejected" && !stage.finalRejection && !stage.correctionUsed, "stage is not eligible for correction");
      requireValid(event.scopeHash === next.planHash, "correction scope hash must match plan hash");
      requireValid(currentAttempt(stage).providerClosed, "provider must close before correction");
      requireValid(event.executionShape === "root_inline" || next.budget.consumed.recovery < next.budget.reservedForRecovery, "recovery reserve is exhausted");
      stage.state = "ready";
      stage.correctionUsed = true;
      break;
    }
    case "stage_blocked": {
      const { stage } = stageFor(plan, next, event.stageId);
      requireValid(["planned", "ready", "materializing", "running"].includes(stage.state), "stage is not eligible to be blocked");
      stage.state = "blocked";
      stage.blockedReasonCode = event.reasonCode;
      if (next.activeBatch?.canaryStageId === event.stageId && !next.activeBatch.canaryReady) {
        for (const deferredId of next.activeBatch.stageIds.slice(1)) {
          const deferred = next.stages[deferredId];
          if (deferred.state === "ready") {
            deferred.state = "blocked";
            deferred.blockedReasonCode = "WORKFLOW_CANARY_FAILED";
          }
        }
        next.delegationStopped = true;
        next.stopReason = "WORKFLOW_CANARY_FAILED";
        next.activeBatch = null;
      } else {
        clearCompletedBatch(next);
      }
      break;
    }
    case "stage_cancelled": {
      const { stage } = stageFor(plan, next, event.stageId);
      requireValid(["planned", "ready", "blocked"].includes(stage.state) && stage.attempts.length === 0, "only an unmaterialized stage may be cancelled");
      requireValid(next.approvalFacts.some((fact) => fact.authority === event.authority && fact.factId === event.factId && fact.scopeHash === next.planHash), "owner cancellation approval is not recorded");
      stage.state = "closed";
      stage.cancelled = true;
      clearCompletedBatch(next);
      break;
    }
    default:
      throw new TypeError("unsupported workflow event");
  }
  next.updatedAt = event.at;
  return next;
}

export function sanitizeWorkflowEventForLedger(event) {
  const validation = validateWorkflowEvent(event);
  requireValid(validation.pass, validation.errors.join("; "));
  if (event.type !== "materialized") return structuredClone(event);
  if (Object.hasOwn(event, "materializationHash") || (!Object.hasOwn(event, "executionId") && !Object.hasOwn(event, "dispatchResult"))) return structuredClone(event);
  const materializationHash = Object.hasOwn(event, "executionId")
    ? hash({ executionId: event.executionId, canonicalTaskName: event.canonicalTaskName })
    : hash(event.dispatchResult);
  return {
    schemaVersion: event.schemaVersion,
    type: event.type,
    at: event.at,
    stageId: event.stageId,
    batchId: event.batchId,
    materializationHash,
    status: event.status,
  };
}

export function workflowStateSummary(state) {
  const stages = Object.fromEntries(Object.entries(state.stages).map(([stageId, stage]) => [stageId, {
    state: stage.state,
    attemptNumber: stage.attemptNumber,
    correctionUsed: stage.correctionUsed,
    finalRejection: stage.finalRejection,
    cancelled: stage.cancelled === true,
    attempts: stage.attempts.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      executionShape: attempt.executionShape,
      attemptClass: attempt.attemptClass,
      materializationHash: attempt.materializationHash,
      resultHash: attempt.resultHash,
      mechanicalCheckHash: attempt.mechanicalCheckHash,
      rootCheckHash: attempt.rootCheckHash,
      providerClosed: attempt.providerClosed,
      adopted: attempt.adopted,
      tokens: attempt.tokens,
    })),
  }]));
  return {
    schemaVersion: state.schemaVersion,
    workflowId: state.workflowId,
    planHash: state.planHash,
    policyMode: state.policyMode,
    policyHash: state.policyHash,
    permissionHash: state.permissionHash,
    workspaceHash: state.workspaceHash,
    budget: structuredClone(state.budget),
    delegationStopped: state.delegationStopped,
    stopReason: state.stopReason,
    activeBatch: state.activeBatch ? structuredClone(state.activeBatch) : null,
    stages,
    updatedAt: state.updatedAt,
  };
}
