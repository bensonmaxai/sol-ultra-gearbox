import {
  hashWorkflowPlan,
  validateWorkflowPlan,
} from "./workflow-plan.mjs";

export { validateWorkflowContext } from "./dispatch-planner.mjs";

export function compileStagePacket({
  plan,
  planHash,
  stageId,
  approvalFacts,
  batch,
}) {
  const validation = validateWorkflowPlan(plan);
  if (!validation.pass || hashWorkflowPlan(plan) !== planHash) {
    throw new TypeError("workflow plan must be valid and hash-bound");
  }
  const stage = plan.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new TypeError("workflow stage is unknown");
  const approvalSatisfied = stage.approvalGate === null || approvalFacts.some(
    (fact) =>
      fact.authority === stage.approvalGate.authority &&
      fact.factId === stage.approvalGate.factId &&
      fact.scopeHash === planHash,
  );
  if (!approvalSatisfied) {
    throw new TypeError("workflow stage approval is not satisfied");
  }
  return {
    schemaVersion: 2,
    workflowAdapter: plan.workflowAdapter,
    responsibility: stage.responsibility,
    goal: stage.deliverable,
    readScope: stage.readScope,
    writeScope: stage.writeScope,
    knownFacts: stage.knownFacts,
    constraints: stage.constraints,
    deliverable: stage.deliverable,
    successCriteria: stage.successCriteria,
    checks: stage.checks,
    prohibitedActions: [
      ...stage.prohibitedActions,
      "Block and report missing information instead of guessing",
    ],
    parentPermission: stage.parentPermission,
    requiredPermission: stage.requiredPermission,
    requiresNativeLineage: false,
    requestedRole: stage.requestedRole,
    ownerOptIn: approvalSatisfied && stage.approvalGate?.authority === "owner",
    legacyAdapter: false,
    batch,
    riskSignals: stage.riskSignals,
    costSignals: stage.costSignals,
    workflowContext: {
      workflowId: plan.workflowId,
      planHash,
      stageId: stage.id,
      dependsOn: stage.dependsOn,
      inputArtifacts: stage.inputArtifacts,
      outputArtifacts: stage.outputArtifacts,
      interfaces: stage.interfaces,
      attemptClass: stage.attemptClass,
      missingInformationPolicy: "block_and_report",
    },
  };
}
