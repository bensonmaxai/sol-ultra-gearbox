import { createHash } from "node:crypto";
import { ROLE_SPECS } from "./gearbox.mjs";
import { hashTaskPacket, planDispatch, validateTaskPacket } from "./dispatch-planner.mjs";
import { validateDispatchResult } from "./dispatch-evidence.mjs";
import { compileStagePacket } from "./workflow-compiler.mjs";
import { scheduleWorkflow, selectCandidateBatch } from "./workflow-scheduler.mjs";
import { reduceWorkflowEvent } from "./workflow-state.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SHAPES = new Set(["typed_child", "isolated_role_root", "root_inline"]);

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

function batchId(planHash, stageIds, attemptNumbers) {
  return createHash("sha256")
    .update(`${planHash}\n${stageIds.join("\n")}\n${attemptNumbers.join("\n")}`)
    .digest("hex");
}

function projectedWithReadiness(plan, state) {
  let projected = structuredClone(state);
  const readinessEvents = plan.stages.filter((stage) => {
    if (projected.stages[stage.id]?.state !== "planned") return false;
    return stage.dependsOn.every((dependency) => {
      const current = projected.stages[dependency];
      return current?.state === "adopted" || (current?.state === "closed" && current.attempts.some((attempt) => attempt.adopted));
    }) && (stage.approvalGate === null || projected.approvalFacts.some((fact) =>
      fact.authority === stage.approvalGate.authority
      && fact.factId === stage.approvalGate.factId
      && fact.scopeHash === projected.planHash,
    ));
  }).map((stage) => ({
    schemaVersion: 1,
    type: "stage_ready",
    at: state.updatedAt,
    stageId: stage.id,
  }));
  for (const event of readinessEvents) {
    projected = reduceWorkflowEvent({ plan, state: projected, event });
  }
  return { projected, readinessEvents };
}

function activeCandidate({ plan, state }) {
  const stageIds = state.activeBatch.stageIds;
  const stages = stageIds.map((stageId) => plan.stages.find((stage) => stage.id === stageId));
  const scopes = stages.flatMap((stage) => stage.writeScope);
  return {
    stageIds,
    requestedChildren: stageIds.length,
    writerCount: stages.filter((stage) => stage.writeScope.length > 0).length,
    scopesDisjoint: scopes.every((scope, index) => scopes.slice(index + 1).every((other) =>
      !(scope === other || scope.startsWith(`${other}/`) || other.startsWith(`${scope}/`)),
    )),
  };
}

function packetsAndDecisions({ plan, planHash, state, candidate, policy, capabilities, roleSpecs }) {
  const packets = new Map();
  const decisions = new Map();
  for (const stageId of candidate.stageIds) {
    const packet = compileStagePacket({
      plan,
      planHash,
      stageId,
      approvalFacts: state.approvalFacts,
      batch: {
        requestedChildren: candidate.requestedChildren,
        writerCount: candidate.writerCount,
        scopesDisjoint: candidate.scopesDisjoint,
      },
    });
    packets.set(stageId, packet);
    decisions.set(stageId, planDispatch({ policy, packet, capabilities, roleSpecs }));
  }
  return { packets, decisions };
}

function workflowRootDecision(decision, reasonCode = undefined) {
  return {
    schemaVersion: 1,
    taskHash: decision.taskHash,
    policyMode: decision.policyMode,
    responsibility: decision.responsibility,
    selectedShape: "root_inline",
    effectiveShape: "root_inline",
    role: null,
    reasonCode: reasonCode ?? decision.reasonCode,
    spawnArgs: null,
    requiresRuntimeEvidence: false,
  };
}

function actionFor({ plan, planHash, batchId: id, stageId, canaryStageId, deferredStageIds, packet, decision, rootReasonCode = undefined }) {
  if (rootReasonCode !== undefined || decision.effectiveShape === "root_inline") {
    return {
      kind: "root_inline",
      stageId,
      packet,
      decision: workflowRootDecision(decision, rootReasonCode),
    };
  }
  return {
    kind: "materialize",
    workflowId: plan.workflowId,
    planHash,
    batchId: id,
    stageId,
    canary: stageId === canaryStageId,
    deferredStageIds,
    packet,
    decision,
  };
}

export function planNextWorkflowAction({ plan, planHash, state, policy, capabilities, roleSpecs = ROLE_SPECS }) {
  if (state.activeBatch) {
    if (!state.activeBatch.canaryReady) return { readinessEvents: [], batchEvent: null, action: { kind: "wait" } };
    const candidate = activeCandidate({ plan, state });
    const stageId = candidate.stageIds.find((id) => id !== state.activeBatch.canaryStageId && state.stages[id]?.state === "ready");
    if (!stageId) return { readinessEvents: [], batchEvent: null, action: { kind: "wait" } };
    const { packets, decisions } = packetsAndDecisions({ plan, planHash, state, candidate, policy, capabilities, roleSpecs });
    const decision = decisions.get(stageId);
    const id = state.activeBatch.batchId;
    return {
      readinessEvents: [],
      batchEvent: null,
      action: actionFor({
        plan,
        planHash,
        batchId: id,
        stageId,
        canaryStageId: state.activeBatch.canaryStageId,
        deferredStageIds: candidate.stageIds.filter((id) => id !== stageId && id !== state.activeBatch.canaryStageId),
        packet: packets.get(stageId),
        decision,
        rootReasonCode: state.delegationStopped ? state.stopReason : undefined,
      }),
    };
  }

  const { projected, readinessEvents } = projectedWithReadiness(plan, state);
  const candidate = selectCandidateBatch({ plan, state: projected });
  if (candidate.kind === "complete") return { readinessEvents, batchEvent: null, action: candidate };
  if (candidate.kind === "none") return { readinessEvents, batchEvent: null, action: projected.delegationStopped ? { kind: "blocked", reasonCode: projected.stopReason } : { kind: "wait" } };
  const { packets, decisions } = packetsAndDecisions({ plan, planHash, state: projected, candidate, policy, capabilities, roleSpecs });
  const scheduled = scheduleWorkflow({ plan, state: projected, candidate, decisions });
  if (scheduled.kind === "wait" || scheduled.kind === "blocked" || scheduled.kind === "complete") {
    return { readinessEvents, batchEvent: null, action: scheduled };
  }
  const stageIds = scheduled.kind === "root_inline" ? [scheduled.stageId] : scheduled.stageIds;
  const id = batchId(planHash, stageIds, stageIds.map((stageId) => projected.stages[stageId].attemptNumber + 1));
  const canaryStageId = scheduled.kind === "root_inline" ? scheduled.stageId : scheduled.canaryStageId;
  const batchEvent = { schemaVersion: 1, type: "batch_planned", at: state.updatedAt, batchId: id, stageIds, canaryStageId };
  const stageId = canaryStageId;
  return {
    readinessEvents,
    batchEvent,
    action: actionFor({
      plan,
      planHash,
      batchId: id,
      stageId,
      canaryStageId,
      deferredStageIds: scheduled.kind === "batch" ? scheduled.deferredStageIds : [],
      packet: packets.get(stageId),
      decision: decisions.get(stageId),
      rootReasonCode: scheduled.kind === "root_inline" ? scheduled.reasonCode : undefined,
    }),
  };
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function expectedShape(action) {
  return action?.decision?.effectiveShape;
}

export function validateMaterializationReceipt({ action, receipt }) {
  const errors = [];
  const shape = expectedShape(action);
  const taskHash = action?.decision?.taskHash;
  if (!SHAPES.has(shape) || !HASH.test(taskHash ?? "")) return { pass: false, sanitized: null, errors: ["action decision is invalid"] };
  if (shape === "root_inline") return { pass: false, sanitized: null, errors: ["root-inline materialization is internal"] };
  const expected = shape === "typed_child"
    ? ["schemaVersion", "executionShape", "taskHash", "executionId", "canonicalTaskName", "status"]
    : ["schemaVersion", "executionShape", "taskHash", "dispatchResult", "status"];
  if (!exactKeys(receipt, expected)) errors.push("receipt contains missing or extra fields");
  if (receipt?.schemaVersion !== 1) errors.push("receipt schema is invalid");
  if (receipt?.executionShape !== shape) errors.push("receipt execution shape does not match action");
  if (receipt?.taskHash !== taskHash) errors.push("receipt task hash does not match action");
  if (shape === "typed_child") {
    if (typeof receipt?.executionId !== "string" || receipt.executionId.length === 0 || typeof receipt?.canonicalTaskName !== "string" || receipt.canonicalTaskName.length === 0) errors.push("typed receipt identity is invalid");
    if (!["running", "completed"].includes(receipt?.status)) errors.push("typed receipt status is invalid");
  } else {
    const roleSpec = ROLE_SPECS.find((spec) => spec.name === action.decision.role);
    const evidence = validateDispatchResult({ result: receipt?.dispatchResult, decision: action.decision, roleSpec });
    if (!evidence.pass || receipt?.dispatchResult?.pass !== true) errors.push("isolated dispatch result is invalid");
    if (receipt?.status !== "completed") errors.push("isolated receipt must be completed");
  }
  if (errors.length > 0) return { pass: false, sanitized: null, errors };
  return {
    pass: true,
    sanitized: {
      materializationHash: hash(receipt),
      taskHash,
      executionShape: shape,
      status: receipt.status,
    },
    errors: [],
  };
}

function validateDecision(decision) {
  if (!decision || !HASH.test(decision.taskHash ?? "") || !SHAPES.has(decision.effectiveShape) || !SHAPES.has(decision.selectedShape)) {
    throw new TypeError("decision is invalid");
  }
  if (decision.selectedShape === "typed_child" && (!decision.spawnArgs || !exactKeys(decision.spawnArgs, ["agent_type", "fork_turns", "message"]))) {
    throw new TypeError("typed decision spawn arguments are invalid");
  }
}

function inputFor(decision, input) {
  if (!input || input.taskHash !== decision.taskHash || input.executionShape !== decision.effectiveShape) {
    throw new TypeError("execution shape or task hash does not match decision");
  }
  if (Object.hasOwn(input, "packet")) {
    const validation = validateTaskPacket(input.packet);
    if (!validation.pass || hashTaskPacket(input.packet) !== decision.taskHash) {
      throw new TypeError("task packet does not match decision");
    }
  }
}

export function providerForDecision(decision) {
  validateDecision(decision);
  const materialize = (input) => {
    inputFor(decision, input);
    if (decision.effectiveShape === "typed_child") return { kind: "typed_child_spawn", taskHash: decision.taskHash, packet: input.packet, spawnArgs: decision.spawnArgs };
    if (decision.effectiveShape === "isolated_role_root") return { kind: "run_isolated", taskHash: decision.taskHash, packet: input.packet, role: decision.role };
    return { kind: "root_inline", taskHash: decision.taskHash, packet: input.packet };
  };
  return {
    capabilities() {
      return ["materialize", "readiness", "collectEvidence", "close"];
    },
    materialize,
    readiness(input) {
      inputFor(decision, input);
      return input.receipt ? validateMaterializationReceipt({ action: { decision }, receipt: input.receipt }) : { pass: decision.effectiveShape === "root_inline", errors: [] };
    },
    collectEvidence(input) {
      inputFor(decision, input);
      if (decision.effectiveShape === "root_inline") {
        return { kind: "root_collect_evidence", taskHash: decision.taskHash, executionShape: "root_inline" };
      }
      const roleSpec = ROLE_SPECS.find((spec) => spec.name === decision.role);
      const validation = validateDispatchResult({ result: input.dispatchResult, decision, roleSpec });
      if (!validation.pass) throw new TypeError("dispatch result is invalid");
      return { kind: "dispatch_evidence_validated", taskHash: decision.taskHash, executionShape: decision.effectiveShape };
    },
    close(input) {
      inputFor(decision, input);
      if (!["adopted", "rejected", "blocked"].includes(input.disposition)) {
        throw new TypeError("provider disposition is invalid");
      }
      return {
        kind: "provider_close",
        taskHash: decision.taskHash,
        executionShape: decision.effectiveShape,
        disposition: input.disposition,
      };
    },
  };
}
