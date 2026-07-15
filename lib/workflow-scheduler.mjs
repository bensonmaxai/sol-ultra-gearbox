function stageById(plan, stageId) {
  return plan.stages.find((stage) => stage.id === stageId) ?? null;
}

function dependencyAdopted(state, stageId) {
  const dependency = state.stages[stageId];
  return dependency?.state === "adopted" || (
    dependency?.state === "closed" && dependency.attempts.some((attempt) => attempt.adopted)
  );
}

function approvalSatisfied(state, planHash, stage) {
  return stage.approvalGate === null || state.approvalFacts.some((fact) =>
    fact.authority === stage.approvalGate.authority
    && fact.factId === stage.approvalGate.factId
    && fact.scopeHash === planHash,
  );
}

function scopeOverlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function scopesAreDisjoint(stages) {
  const scopes = stages.flatMap((stage) => Array.isArray(stage.writeScope) ? stage.writeScope : []);
  return scopes.every((scope, index) => scopes.slice(index + 1).every((other) => !scopeOverlaps(scope, other)));
}

function candidateForStages(stages) {
  const writerCount = stages.filter((stage) => stage.writeScope.length > 0).length;
  return {
    stageIds: stages.map((stage) => stage.id),
    requestedChildren: stages.length,
    writerCount,
    scopesDisjoint: scopesAreDisjoint(stages),
  };
}

function isComplete(plan, state) {
  return plan.stages.every((stage) => {
    const current = state.stages[stage.id];
    return current?.state === "closed" && (
      current.cancelled === true || current.attempts.some((attempt) => attempt.adopted)
    );
  });
}

export function readyStageIds({ plan, state }) {
  return plan.stages.filter((stage) => {
    const current = state.stages[stage.id];
    return current?.state === "ready"
      && stage.dependsOn.every((stageId) => dependencyAdopted(state, stageId))
      && approvalSatisfied(state, state.planHash, stage);
  }).map((stage) => stage.id);
}

export function selectCandidateBatch({ plan, state }) {
  if (isComplete(plan, state)) return { kind: "complete", disposition: "adopted" };
  const ready = readyStageIds({ plan, state }).map((stageId) => stageById(plan, stageId));
  if (ready.length === 0) return { kind: "none", stageIds: [] };

  const first = ready[0];
  if (first.writeScope.length > 0) return candidateForStages([first]);
  const second = ready[1];
  if (!second || second.writeScope.length > 0) return candidateForStages([first]);
  const pair = candidateForStages([first, second]);
  return pair.scopesDisjoint ? pair : candidateForStages([first]);
}

function rootInline(stageId, reasonCode = undefined) {
  return reasonCode === undefined
    ? { kind: "root_inline", stageId }
    : { kind: "root_inline", stageId, reasonCode };
}

function validDecision(decision) {
  return Boolean(
    decision
    && /^[a-f0-9]{64}$/.test(decision.taskHash ?? "")
    && ["typed_child", "isolated_role_root", "root_inline"].includes(decision.selectedShape)
    && ["typed_child", "isolated_role_root", "root_inline"].includes(decision.effectiveShape)
    && typeof decision.reasonCode === "string"
    && (decision.role === null || typeof decision.role === "string")
    && (decision.spawnArgs === null || (decision.spawnArgs && typeof decision.spawnArgs === "object")),
  );
}

export function scheduleWorkflow({ plan, state, candidate, decisions }) {
  if (candidate?.kind === "complete") return candidate;
  const stageIds = candidate?.stageIds ?? [];
  if (stageIds.length === 0) {
    return state.delegationStopped
      ? { kind: "blocked", reasonCode: state.stopReason }
      : { kind: "wait" };
  }
  const stages = stageIds.map((stageId) => stageById(plan, stageId));
  const firstStageId = stageIds[0];
  if (state.delegationStopped) return rootInline(firstStageId, state.stopReason);

  if (!stageIds.every((stageId) => validDecision(decisions?.get(stageId)))) {
    return rootInline(firstStageId, "ROOT_DECISION_INVALID");
  }

  const rootStageId = stageIds.find((stageId) => decisions.get(stageId)?.effectiveShape === "root_inline");
  if (rootStageId) return rootInline(rootStageId);

  const remainingTotal = state.budget.total - state.budget.consumed.total;
  const verificationHeld = Math.max(0, state.budget.reservedForVerification - state.budget.consumed.verification);
  const recoveryHeld = Math.max(0, state.budget.reservedForRecovery - state.budget.consumed.recovery);
  const unreservedWork = remainingTotal - verificationHeld - recoveryHeld;
  const workCount = stages.filter((stage) => stage.attemptClass === "work").length;
  const verificationCount = stages.filter((stage) => stage.attemptClass === "verification").length;
  const recoveryCount = stages.filter((stage) => stage.attemptClass === "recovery").length;

  if (workCount > 0 && unreservedWork < workCount) {
    return rootInline(firstStageId, "ROOT_WORK_ATTEMPT_RESERVE_PROTECTED");
  }
  if (verificationCount > 0 && verificationHeld < verificationCount) {
    return { kind: "blocked", reasonCode: "WORKFLOW_VERIFICATION_RESERVE_EXHAUSTED" };
  }
  if (recoveryCount > 0 && recoveryHeld < recoveryCount) {
    return rootInline(firstStageId, "ROOT_RECOVERY_RESERVE_EXHAUSTED");
  }
  if (remainingTotal < stageIds.length) {
    return rootInline(firstStageId, "ROOT_WORK_ATTEMPT_RESERVE_PROTECTED");
  }
  if (candidate.writerCount > 0 || !candidate.scopesDisjoint || stageIds.length === 1) {
    return {
      kind: "batch",
      stageIds,
      canaryStageId: firstStageId,
      deferredStageIds: [],
    };
  }
  return {
    kind: "batch",
    stageIds,
    canaryStageId: firstStageId,
    deferredStageIds: stageIds.slice(1),
  };
}
