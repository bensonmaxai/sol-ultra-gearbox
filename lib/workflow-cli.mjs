import { join, resolve } from "node:path";
import { ROLE_SPECS } from "./gearbox.mjs";
import { planDispatch } from "./dispatch-planner.mjs";
import { validateDispatchPolicy } from "./dispatch-policy.mjs";
import { compileStagePacket } from "./workflow-compiler.mjs";
import { planNextWorkflowAction, validateMaterializationReceipt } from "./workflow-orchestrator.mjs";
import {
  appendWorkflowRecord,
  createWorkflowRecord,
  replayWorkflowRecords,
  validateWorkflowRecord,
} from "./workflow-ledger.mjs";
import { createWorkflowOutcomeRecord } from "./workflow-outcome.mjs";
import { DEFAULT_WORKFLOW_LEDGER_PATH } from "./workflow-ledger.mjs";
import { readPrivateJsonl } from "./private-jsonl.mjs";
import { createWorkflowBinding, resumeWorkflow } from "./workflow-recovery.mjs";
import { createWorkflowState, reduceWorkflowEvent } from "./workflow-state.mjs";
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
  if (exactKeys(envelope.stateSource, ["kind"]) && envelope.stateSource.kind === "managed") {
    // Valid managed source.
  } else if (
    exactKeys(envelope.stateSource, ["kind", "schemaFields", "records"])
    && envelope.stateSource.kind === "upstream"
    && Array.isArray(envelope.stateSource.schemaFields)
    && envelope.stateSource.schemaFields.length === UPSTREAM_FIELDS.length
    && envelope.stateSource.schemaFields.every((field, index) => field === UPSTREAM_FIELDS[index])
    && Array.isArray(envelope.stateSource.records)
  ) {
    // Valid upstream source.
  } else {
    errors.push("workflow stateSource is incompatible");
  }
  if (envelope.event !== null && (!envelope.event || typeof envelope.event !== "object" || Array.isArray(envelope.event))) {
    errors.push("workflow event must be null or an event object");
  }
  return { pass: errors.length === 0, errors };
}

function publicAction(action) {
  if (action.kind === "wait") return { kind: "wait" };
  if (action.kind === "root_inline") {
    return { kind: "root_inline", stageId: action.stageId, reasonCode: action.decision.reasonCode };
  }
  if (action.decision.effectiveShape === "typed_child") {
    return { kind: "typed_child", stageId: action.stageId, spawnArgs: action.decision.spawnArgs };
  }
  return { kind: "run_isolated", stageId: action.stageId, taskHash: action.decision.taskHash, role: action.decision.role };
}

function workflowAction(action, workflow) {
  if (action.kind === "wait") return { kind: "wait" };
  const context = {
    workflowId: workflow.workflowId,
    planHash: workflow.planHash,
    batchId: workflow.batchId,
    stageId: action.stageId,
  };
  if (action.kind === "root_inline") return { kind: action.kind, ...context, decision: action.decision };
  if (action.decision.effectiveShape === "typed_child") {
    return { kind: "typed_child", ...context, canary: action.canary, deferredStageIds: action.deferredStageIds, decision: action.decision, spawnArgs: action.decision.spawnArgs };
  }
  return { kind: "run_isolated", ...context, canary: action.canary, deferredStageIds: action.deferredStageIds, packet: action.packet, decision: action.decision };
}

function resultFor({ mode, source, status, action = undefined, reasonCode = undefined, rollbackRequired = false, recordsToAppend, outcomesToAppend }) {
  const result = { status, mode, source, rollbackRequired, recordsToAppend, outcomesToAppend };
  if (action !== undefined) {
    result.action = action;
    result.public = publicAction(action);
  }
  if (reasonCode !== undefined) result.reasonCode = reasonCode;
  return result;
}

function blocked({ policy, source, reasonCode, rollbackRequired = false, recordsToAppend = [], outcomesToAppend = [] }) {
  return resultFor({
    status: "GEARBOX_WORKFLOW_BLOCKED",
    mode: policy?.mode ?? "off",
    source,
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
  const stageIds = batch?.stageIds ?? [];
  if (!batch || !stageIds.includes(event.stageId) || state.stages[event.stageId]?.state !== "ready") {
    throw new TypeError("workflow materialization is not currently scheduled");
  }
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
    || (decision.effectiveShape !== "root_inline" && event.taskHash !== decision.taskHash)
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
  const source = sourceKind(envelope?.stateSource);
  if (!envelopeValidation.pass) return blocked({ policy, source, reasonCode: "WORKFLOW_ENVELOPE_INVALID" });
  const policyValidation = validateDispatchPolicy(policy);
  if (!policyValidation.pass || !["active", "shadow"].includes(policy.mode)) {
    return blocked({ policy, source, reasonCode: "WORKFLOW_POLICY_INVALID" });
  }
  let binding;
  try {
    binding = createWorkflowBinding({ plan: envelope.plan, policy, capabilities, cwd });
  } catch (error) {
    throw error;
    return blocked({ policy, source, reasonCode: "WORKFLOW_BINDING_INVALID" });
  }

  const managedPath = join(resolve(cwd), DEFAULT_WORKFLOW_LEDGER_PATH);
  let persisted;
  try {
    persisted = source === "managed"
      ? readPrivateJsonl(managedPath, { defaultPath: DEFAULT_WORKFLOW_LEDGER_PATH, validate: validateWorkflowRecord })
      : structuredClone(envelope.stateSource.records);
  } catch {
    return blocked({ policy, source, reasonCode: source === "upstream" ? "WORKFLOW_UPSTREAM_STORE_INCOMPATIBLE" : "WORKFLOW_LEDGER_INVALID" });
  }
  const recordsToAppend = [];
  const outcomesToAppend = [];
  const recordChain = [...persisted];
  let state;
  try {
    if (persisted.length === 0) {
      if (envelope.event !== null) return blocked({ policy, source, reasonCode: "WORKFLOW_EVENT_REJECTED" });
      state = createWorkflowState({ ...binding, plan: envelope.plan, at: INITIAL_AT });
      recordsToAppend.push(nextRecord(recordChain, state, null));
    } else {
      const resumed = resumeWorkflow({ plan: envelope.plan, records: persisted, binding, currentArtifactHashes: envelope.binding.currentArtifactHashes });
      if (!resumed.pass && resumed.reasonCode !== "WORKFLOW_INCOMPLETE_EXECUTION") {
        return blocked({ policy, source, reasonCode: resumed.reasonCode });
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
    if (source === "managed") {
      const persistedRecords = [...persisted];
      for (const record of recordsToAppend) {
        appendWorkflowRecord({ kind: "managed", path: managedPath }, record);
        persistedRecords.push(record);
      }
    }
    if (planned.action.kind === "complete") {
      return resultFor({ status: "GEARBOX_WORKFLOW_COMPLETE", mode: policy.mode, source, recordsToAppend, outcomesToAppend });
    }
    if (planned.action.kind === "blocked") {
      return blocked({
        policy, source, reasonCode: planned.action.reasonCode,
        rollbackRequired: policy.mode === "active" && state.delegationStopped,
        recordsToAppend, outcomesToAppend,
      });
    }
    if (state.delegationStopped) {
      return blocked({
        policy, source, reasonCode: state.stopReason,
        rollbackRequired: policy.mode === "active",
        recordsToAppend, outcomesToAppend,
      });
    }
    const action = workflowAction(planned.action, {
      workflowId: envelope.plan.workflowId,
      planHash: binding.planHash,
      batchId: state.activeBatch?.batchId ?? null,
    });
    return resultFor({ status: "GEARBOX_WORKFLOW_ACTION", mode: policy.mode, source, action, recordsToAppend, outcomesToAppend });
  } catch {
    return blocked({ policy, source, reasonCode: "WORKFLOW_EVENT_REJECTED", recordsToAppend, outcomesToAppend });
  }
}
