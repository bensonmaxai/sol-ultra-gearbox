import { join, resolve } from "node:path";
import { ROLE_SPECS } from "./gearbox.mjs";
import { planDispatch } from "./dispatch-planner.mjs";
import { validateDispatchPolicy } from "./dispatch-policy.mjs";
import { compileStagePacket } from "./workflow-compiler.mjs";
import { planNextWorkflowAction, validateMaterializationReceipt } from "./workflow-orchestrator.mjs";
import { selectCandidateBatch } from "./workflow-scheduler.mjs";
import {
  appendWorkflowRecord,
  createWorkflowRecord,
  replayWorkflowRecords,
  validateWorkflowRecord,
  validateWorkflowRecordSequence,
} from "./workflow-ledger.mjs";
import { appendWorkflowOutcome, createWorkflowOutcomeRecord, DEFAULT_WORKFLOW_OUTCOME_PATH } from "./workflow-outcome.mjs";
import { DEFAULT_WORKFLOW_LEDGER_PATH } from "./workflow-ledger.mjs";
import { readPrivateJsonl } from "./private-jsonl.mjs";
import { createWorkflowBinding, resumeWorkflow } from "./workflow-recovery.mjs";
import { createWorkflowState, reduceWorkflowEvent, validateWorkflowEvent } from "./workflow-state.mjs";
import { validateWorkflowPlan } from "./workflow-plan.mjs";

const UPSTREAM_FIELDS = Object.freeze([
  "workflowId", "planHash", "stageId", "state", "attempt",
  "executionShape", "role", "taskHash", "resultHash", "adopted", "updatedAt",
]);
const INITIAL_AT = "1970-01-01T00:00:00.000Z";

function exactKeys(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function sourceKind(stateSource) {
  return stateSource?.kind === "upstream" ? "upstream" : "managed";
}

function compatibleStateSource(stateSource) {
  return (exactKeys(stateSource, ["kind"]) && stateSource.kind === "managed") || (
    exactKeys(stateSource, ["kind", "schemaFields", "records"])
    && stateSource.kind === "upstream"
    && Array.isArray(stateSource.schemaFields)
    && stateSource.schemaFields.length === UPSTREAM_FIELDS.length
    && stateSource.schemaFields.every((field, index) => field === UPSTREAM_FIELDS[index])
    && Array.isArray(stateSource.records)
  );
}

export function validateWorkflowEnvelope(envelope) {
  const errors = [];
  if (!exactKeys(envelope, ["schemaVersion", "plan", "binding", "stateSource", "event"])) {
    errors.push("workflow envelope must contain exactly schemaVersion, plan, binding, stateSource, and event");
    return { pass: false, errors };
  }
  if (envelope.schemaVersion !== 1) errors.push("workflow envelope schemaVersion must equal 1");
  const plan = validateWorkflowPlan(envelope.plan);
  if (!plan.pass) errors.push(...plan.errors.map((error) => `plan ${error}`));
  if (!exactKeys(envelope.binding, ["currentArtifactHashes"]) || !envelope.binding.currentArtifactHashes || typeof envelope.binding.currentArtifactHashes !== "object" || Array.isArray(envelope.binding.currentArtifactHashes)) {
    errors.push("workflow envelope binding is invalid");
  }
  if (!compatibleStateSource(envelope.stateSource)) {
    errors.push("workflow stateSource is incompatible");
  }
  if (envelope.event !== null) {
    const event = validateWorkflowEvent(envelope.event);
    if (!event.pass) errors.push(...event.errors.map((error) => `workflow event ${error}`));
  }
  return { pass: errors.length === 0, errors };
}

function workflowAction(action, workflow) {
  if (action.kind === "wait") return { kind: "wait" };
  const context = {
    batchId: workflow.batchId,
    stageId: action.stageId,
    taskHash: action.decision.taskHash,
    executionShape: action.decision.effectiveShape,
    attemptClass: action.packet.workflowContext.attemptClass,
  };
  if (action.kind === "root_inline") {
    return { kind: action.kind, ...context, reasonCode: action.decision.reasonCode };
  }
  if (action.decision.effectiveShape === "typed_child") {
    return { kind: "typed_child", ...context, canary: action.canary, deferredStageIds: action.deferredStageIds, role: action.decision.role, spawnArgs: action.decision.spawnArgs };
  }
  return { kind: "run_isolated", ...context, canary: action.canary, deferredStageIds: action.deferredStageIds, role: action.decision.role, packet: action.packet };
}

function resultFor({ mode, stateSource, status, action = undefined, reasonCode = undefined, rollbackRequired = false, recordsToAppend, outcomesToAppend }) {
  const result = { status, mode, stateSource, rollbackRequired, recordsToAppend, outcomesToAppend };
  if (action !== undefined) result.action = action;
  if (reasonCode !== undefined) result.reasonCode = reasonCode;
  return result;
}

function blocked({ policy, stateSource, reasonCode, rollbackRequired = false, recordsToAppend = [], outcomesToAppend = [] }) {
  return resultFor({
    status: "GEARBOX_WORKFLOW_BLOCKED",
    mode: policy?.mode ?? "off",
    stateSource,
    reasonCode,
    rollbackRequired,
    recordsToAppend,
    outcomesToAppend,
  });
}

function nextRecord(records, state, event) {
  const record = createWorkflowRecord({ previousRecordHash: records.at(-1)?.recordHash ?? null, state, event });
  records.push(record);
  return record;
}

function assertExpectedMaterialization({ plan, planHash, state, policy, capabilities, roleSpecs, event }) {
  if (event.type !== "materialization_started") return;
  const batch = state.activeBatch;
  if (!batch || !batch.stageIds.includes(event.stageId) || state.stages[event.stageId]?.state !== "ready") {
    throw new TypeError("workflow materialization is not currently scheduled");
  }
  const candidate = selectCandidateBatch({ plan, state });
  const stageIds = candidate.kind === undefined ? candidate.stageIds : batch.stageIds;
  const stages = stageIds.map((stageId) => plan.stages.find((stage) => stage.id === stageId));
  const scopes = stages.flatMap((stage) => stage.writeScope);
  const decision = planDispatch({
    policy,
    packet: compileStagePacket({
      plan,
      planHash,
      stageId: event.stageId,
      approvalFacts: state.approvalFacts,
      batch: {
        requestedChildren: stageIds.length,
        writerCount: stages.filter((stage) => stage.writeScope.length > 0).length,
        scopesDisjoint: scopes.every((scope, index) => scopes.slice(index + 1).every((other) =>
          !(scope === other || scope.startsWith(`${other}/`) || other.startsWith(`${scope}/`)),
        )),
      },
    }),
    capabilities,
    roleSpecs,
  });
  if (
    event.batchId !== state.activeBatch?.batchId
    || event.executionShape !== decision.effectiveShape
    || event.role !== (decision.effectiveShape === "root_inline" ? null : decision.role)
    || event.taskHash !== decision.taskHash
  ) {
    throw new TypeError("workflow materialization does not match the scheduled action");
  }
}

function assertExpectedReceipt(state, event) {
  if (event.type !== "materialized") return;
  const attempt = state.stages[event.stageId]?.attempts?.at(-1);
  if (!attempt || !["typed_child", "isolated_role_root"].includes(attempt.executionShape)) return;
  const receipt = attempt.executionShape === "typed_child"
    ? {
        schemaVersion: event.schemaVersion,
        executionShape: attempt.executionShape,
        taskHash: attempt.taskHash,
        executionId: event.executionId,
        canonicalTaskName: event.canonicalTaskName,
        status: event.status,
      }
    : {
        schemaVersion: event.schemaVersion,
        executionShape: attempt.executionShape,
        taskHash: attempt.taskHash,
        dispatchResult: event.dispatchResult,
        status: event.status,
      };
  const validation = validateMaterializationReceipt({
    action: { decision: {
      taskHash: attempt.taskHash,
      selectedShape: attempt.executionShape,
      effectiveShape: attempt.executionShape,
      role: attempt.role,
      spawnArgs: null,
    } },
    receipt,
  });
  if (!validation.pass) throw new TypeError("workflow materialization receipt is invalid");
}

export async function runWorkflowNext({ envelope, policy, capabilities, roleSpecs = ROLE_SPECS, cwd }) {
  const envelopeValidation = validateWorkflowEnvelope(envelope);
  const stateSource = sourceKind(envelope?.stateSource);
  if (!envelopeValidation.pass) {
    return blocked({ policy, stateSource, reasonCode: stateSource === "upstream" ? "WORKFLOW_UPSTREAM_STORE_INCOMPATIBLE" : "WORKFLOW_ENVELOPE_INVALID" });
  }
  const policyValidation = validateDispatchPolicy(policy);
  if (!policyValidation.pass || !["active", "shadow"].includes(policy.mode)) {
    return blocked({ policy, stateSource, reasonCode: "WORKFLOW_POLICY_INVALID" });
  }
  let binding;
  try {
    binding = createWorkflowBinding({ plan: envelope.plan, policy, capabilities, cwd });
  } catch {
    return blocked({ policy, stateSource, reasonCode: "WORKFLOW_BINDING_INVALID" });
  }

  const managedPath = join(resolve(cwd), DEFAULT_WORKFLOW_LEDGER_PATH);
  let persisted;
  try {
    persisted = stateSource === "managed"
      ? readPrivateJsonl(managedPath, { defaultPath: DEFAULT_WORKFLOW_LEDGER_PATH, validate: validateWorkflowRecord })
      : structuredClone(envelope.stateSource.records);
  } catch {
    return blocked({ policy, stateSource, reasonCode: stateSource === "upstream" ? "WORKFLOW_UPSTREAM_STORE_INCOMPATIBLE" : "WORKFLOW_LEDGER_INVALID" });
  }
  if (stateSource === "upstream" && persisted.length > 0 && !validateWorkflowRecordSequence(persisted).pass) {
    return blocked({ policy, stateSource, reasonCode: "WORKFLOW_UPSTREAM_STORE_INCOMPATIBLE" });
  }
  const recordsToAppend = [];
  const outcomesToAppend = [];
  const recordChain = [...persisted];
  let state;
  try {
    if (persisted.length === 0) {
      if (envelope.event !== null) return blocked({ policy, stateSource, reasonCode: "WORKFLOW_EVENT_REJECTED" });
      state = createWorkflowState({ ...binding, plan: envelope.plan, at: INITIAL_AT });
      recordsToAppend.push(nextRecord(recordChain, state, null));
    } else {
      const resumed = resumeWorkflow({ plan: envelope.plan, records: persisted, binding, currentArtifactHashes: envelope.binding.currentArtifactHashes });
      if (!resumed.pass && resumed.reasonCode !== "WORKFLOW_INCOMPLETE_EXECUTION") {
        return blocked({ policy, stateSource, reasonCode: stateSource === "upstream" ? "WORKFLOW_UPSTREAM_STORE_INCOMPATIBLE" : resumed.reasonCode });
      }
      state = resumed.pass ? resumed.state : replayWorkflowRecords({ plan: envelope.plan, records: persisted });
      if (envelope.event !== null) {
        assertExpectedMaterialization({
          plan: envelope.plan,
          planHash: binding.planHash,
          state,
          policy,
          capabilities,
          roleSpecs,
          event: envelope.event,
        });
        assertExpectedReceipt(state, envelope.event);
        state = reduceWorkflowEvent({ plan: envelope.plan, state, event: envelope.event });
        recordsToAppend.push(nextRecord(recordChain, state, envelope.event));
        if (envelope.event.type === "provider_closed") {
          outcomesToAppend.push(createWorkflowOutcomeRecord({ plan: envelope.plan, state, stageId: envelope.event.stageId, generatedAt: state.updatedAt }));
        }
      }
    }

    const planned = planNextWorkflowAction({ plan: envelope.plan, planHash: binding.planHash, state, policy, capabilities, roleSpecs });
    for (const event of planned.readinessEvents) {
      state = reduceWorkflowEvent({ plan: envelope.plan, state, event });
      recordsToAppend.push(nextRecord(recordChain, state, event));
    }
    if (planned.batchEvent) {
      state = reduceWorkflowEvent({ plan: envelope.plan, state, event: planned.batchEvent });
      recordsToAppend.push(nextRecord(recordChain, state, planned.batchEvent));
    }
    if (stateSource === "managed") {
      for (const record of recordsToAppend) {
        appendWorkflowRecord({ kind: "managed", path: managedPath }, record);
      }
      for (const outcome of outcomesToAppend) appendWorkflowOutcome(join(resolve(cwd), DEFAULT_WORKFLOW_OUTCOME_PATH), outcome);
    }
    if (planned.action.kind === "complete") {
      return resultFor({ status: "GEARBOX_WORKFLOW_COMPLETE", mode: policy.mode, stateSource, recordsToAppend, outcomesToAppend });
    }
    if (planned.action.kind === "blocked") {
      return blocked({
        policy, stateSource, reasonCode: planned.action.reasonCode,
        rollbackRequired: policy.mode === "active" && state.delegationStopped,
        recordsToAppend, outcomesToAppend,
      });
    }
    if (state.delegationStopped) {
      return blocked({
        policy, stateSource, reasonCode: state.stopReason,
        rollbackRequired: policy.mode === "active",
        recordsToAppend, outcomesToAppend,
      });
    }
    const action = workflowAction(planned.action, {
      batchId: state.activeBatch?.batchId ?? null,
    });
    return resultFor({ status: "GEARBOX_WORKFLOW_ACTION", mode: policy.mode, stateSource, action, recordsToAppend, outcomesToAppend });
  } catch {
    return blocked({ policy, stateSource, reasonCode: "WORKFLOW_EVENT_REJECTED", recordsToAppend, outcomesToAppend });
  }
}
