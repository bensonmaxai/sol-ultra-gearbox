import { createHash } from "node:crypto";
import { KNOWN_ADAPTERS, RESPONSIBILITY_ROLES } from "./dispatch-planner.mjs";

export const WORKFLOW_SCHEMA_VERSION = 1;
export const ATTEMPT_CLASSES = Object.freeze([
  "work",
  "verification",
  "recovery",
]);

const TOP_LEVEL_FIELDS = Object.freeze([
  "schemaVersion",
  "workflowId",
  "goal",
  "workflowAdapter",
  "inputArtifacts",
  "attemptBudget",
  "stages",
]);
const BUDGET_FIELDS = Object.freeze([
  "total",
  "reservedForVerification",
  "reservedForRecovery",
]);
const STAGE_FIELDS = Object.freeze([
  "id",
  "responsibility",
  "dependsOn",
  "attemptClass",
  "inputArtifacts",
  "outputArtifacts",
  "approvalGate",
  "readScope",
  "writeScope",
  "interfaces",
  "knownFacts",
  "constraints",
  "deliverable",
  "successCriteria",
  "checks",
  "prohibitedActions",
  "parentPermission",
  "requiredPermission",
  "requestedRole",
  "riskSignals",
  "costSignals",
]);
const APPROVAL_FIELDS = Object.freeze(["authority", "factId", "purpose"]);
const RISK_FIELDS = Object.freeze([
  "ambiguous",
  "hiddenCoupling",
  "highRisk",
  "weakVerification",
]);
const COST_BOOLEAN_FIELDS = Object.freeze([
  "oneLocation",
  "packagingDominates",
  "directlyConsumable",
  "includesRegressionTest",
]);
const COST_NUMBER_FIELDS = Object.freeze([
  "estimatedRootToolCalls",
  "repetitiveReads",
  "moduleCount",
  "fileCount",
  "bytes",
  "lines",
  "itemCount",
  "boundedFileCount",
]);
const COST_FIELDS = Object.freeze([...COST_BOOLEAN_FIELDS, ...COST_NUMBER_FIELDS]);
const APPROVAL_PURPOSES = new Set(["stage_execution", "role_opt_in"]);
const PERMISSIONS = new Set(["read-only", "workspace-write"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

export function hashWorkflowPlan(plan) {
  return createHash("sha256")
    .update(JSON.stringify(stable(plan)))
    .digest("hex");
}

function hasExactKeys(value, fields) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isRelativeScope(value) {
  return (
    isNonEmptyString(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function isStringList(value) {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function hasDuplicates(values) {
  return new Set(values).size !== values.length;
}

function pathOverlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function workflowIndexes(plan) {
  const stages = Array.isArray(plan?.stages) ? plan.stages : [];
  const stagesById = new Map();
  const producerByArtifact = new Map();

  for (const stage of stages) {
    if (stage && typeof stage === "object" && typeof stage.id === "string") {
      stagesById.set(stage.id, stage);
    }
  }
  for (const stage of stages) {
    if (!stage || typeof stage !== "object" || !Array.isArray(stage.outputArtifacts)) continue;
    for (const artifact of stage.outputArtifacts) {
      if (typeof artifact === "string") producerByArtifact.set(artifact, stage.id);
    }
  }

  const ancestorsByStage = new Map();
  const visiting = new Set();
  function ancestors(id) {
    if (ancestorsByStage.has(id)) return ancestorsByStage.get(id);
    if (visiting.has(id)) return new Set();
    visiting.add(id);
    const result = new Set();
    const stage = stagesById.get(id);
    const dependencies = Array.isArray(stage?.dependsOn) ? stage.dependsOn : [];
    for (const dependency of dependencies) {
      if (!stagesById.has(dependency)) continue;
      result.add(dependency);
      for (const ancestor of ancestors(dependency)) result.add(ancestor);
    }
    visiting.delete(id);
    ancestorsByStage.set(id, result);
    return result;
  }

  for (const id of stagesById.keys()) ancestors(id);
  return { stagesById, producerByArtifact, ancestorsByStage };
}

function validateExactFields(value, fields, label, errors) {
  if (hasExactKeys(value, fields)) return true;
  errors.push(`${label} must contain exactly: ${fields.join(", ")}`);
  return false;
}

function validateStringList(value, label, errors, { ids = false, scopes = false } = {}) {
  if (!isStringList(value)) {
    errors.push(`${label} must be an array of non-empty strings`);
    return false;
  }
  if (hasDuplicates(value)) errors.push(`${label} must not contain duplicates`);
  if (ids && value.some((item) => !isSafeId(item))) {
    errors.push(`${label} must contain safe identifiers`);
  }
  if (scopes && value.some((item) => !isRelativeScope(item))) {
    errors.push(`${label} must contain non-empty relative paths without . or ..`);
  }
  return true;
}

function validateApprovalGate(value, label, errors) {
  if (value === null) return;
  if (!validateExactFields(value, APPROVAL_FIELDS, label, errors)) return;
  if (value.authority !== "owner") errors.push(`${label}.authority must equal owner`);
  if (!isSafeId(value.factId)) errors.push(`${label}.factId must be a safe identifier`);
  if (!APPROVAL_PURPOSES.has(value.purpose)) errors.push(`${label}.purpose is invalid`);
}

function validateStage(stage, index, roleNames, errors) {
  const label = `stages[${index}]`;
  if (!validateExactFields(stage, STAGE_FIELDS, label, errors)) return;
  if (!isSafeId(stage.id)) errors.push(`${label}.id must be a safe identifier`);
  if (!Object.hasOwn(RESPONSIBILITY_ROLES, stage.responsibility)) {
    errors.push(`${label}.responsibility is invalid`);
  }
  validateStringList(stage.dependsOn, `${label}.dependsOn`, errors, { ids: true });
  if (!ATTEMPT_CLASSES.includes(stage.attemptClass)) {
    errors.push(`${label}.attemptClass is invalid`);
  }
  validateStringList(stage.inputArtifacts, `${label}.inputArtifacts`, errors, { ids: true });
  validateStringList(stage.outputArtifacts, `${label}.outputArtifacts`, errors, { ids: true });
  validateApprovalGate(stage.approvalGate, `${label}.approvalGate`, errors);
  if (!validateStringList(stage.readScope, `${label}.readScope`, errors, { scopes: true })) {
    // The list error is sufficient when this field is structurally invalid.
  } else if (stage.readScope.length === 0) {
    errors.push(`${label}.readScope must not be empty`);
  }
  validateStringList(stage.writeScope, `${label}.writeScope`, errors, { scopes: true });
  for (const field of [
    "interfaces",
    "knownFacts",
    "constraints",
    "successCriteria",
    "checks",
    "prohibitedActions",
  ]) {
    validateStringList(stage[field], `${label}.${field}`, errors);
  }
  if (!isNonEmptyString(stage.deliverable)) {
    errors.push(`${label}.deliverable must be a non-empty string`);
  }
  if (!PERMISSIONS.has(stage.parentPermission)) {
    errors.push(`${label}.parentPermission is invalid`);
  }
  if (!PERMISSIONS.has(stage.requiredPermission)) {
    errors.push(`${label}.requiredPermission is invalid`);
  }
  if (!(stage.requestedRole === null || roleNames.has(stage.requestedRole))) {
    errors.push(`${label}.requestedRole is invalid`);
  }
  if (!validateExactFields(stage.riskSignals, RISK_FIELDS, `${label}.riskSignals`, errors)) {
    // Exact field validation is the only useful structural error here.
  } else if (RISK_FIELDS.some((field) => typeof stage.riskSignals[field] !== "boolean")) {
    errors.push(`${label}.riskSignals must contain boolean flags`);
  }
  if (!validateExactFields(stage.costSignals, COST_FIELDS, `${label}.costSignals`, errors)) {
    return;
  }
  if (COST_BOOLEAN_FIELDS.some((field) => typeof stage.costSignals[field] !== "boolean")) {
    errors.push(`${label}.costSignals must contain boolean flags`);
  }
  if (COST_NUMBER_FIELDS.some((field) => !isNonNegativeInteger(stage.costSignals[field]))) {
    errors.push(`${label}.costSignals must contain non-negative integer counts`);
  }
}

function graphErrors(plan, indexes, errors) {
  const { stagesById, producerByArtifact, ancestorsByStage } = indexes;
  const stageIds = new Set();
  const outputArtifacts = new Set();
  const inputArtifacts = new Set(Array.isArray(plan.inputArtifacts) ? plan.inputArtifacts : []);
  const visiting = new Set();
  const visited = new Set();

  for (const stage of plan.stages) {
    if (!stage || typeof stage !== "object") continue;
    if (typeof stage.id === "string") {
      if (stageIds.has(stage.id)) errors.push(`duplicate stage id: ${stage.id}`);
      stageIds.add(stage.id);
    }
    if (Array.isArray(stage.outputArtifacts)) {
      for (const artifact of stage.outputArtifacts) {
        if (outputArtifacts.has(artifact)) errors.push(`multiple producers for artifact: ${artifact}`);
        outputArtifacts.add(artifact);
      }
    }
  }

  function walk(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`dependency cycle includes: ${id}`);
      return;
    }
    visiting.add(id);
    const stage = stagesById.get(id);
    for (const dependency of stage?.dependsOn ?? []) {
      if (dependency === id) errors.push(`stage depends on itself: ${id}`);
      else if (!stagesById.has(dependency)) errors.push(`unknown dependency: ${dependency}`);
      else walk(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const id of stagesById.keys()) walk(id);

  for (const stage of plan.stages) {
    if (!stage || typeof stage !== "object" || typeof stage.id !== "string") continue;
    const ancestors = ancestorsByStage.get(stage.id) ?? new Set();
    for (const artifact of stage.inputArtifacts ?? []) {
      if (inputArtifacts.has(artifact)) continue;
      const producer = producerByArtifact.get(artifact);
      if (!producer) errors.push(`missing producer for artifact: ${artifact}`);
      else if (!ancestors.has(producer)) {
        errors.push(`artifact producer is not an ancestor: ${artifact}`);
      }
    }
    if (stage.attemptClass === "verification") {
      const hasWorkAncestor = [...ancestors].some(
        (ancestor) => stagesById.get(ancestor)?.attemptClass === "work",
      );
      if (!hasWorkAncestor) errors.push(`verification stage lacks a work ancestor: ${stage.id}`);
    }
  }
}

function writerErrors(plan, indexes, errors) {
  const stages = plan.stages.filter(
    (stage) => stage && typeof stage === "object" && Array.isArray(stage.writeScope) && stage.writeScope.length > 0,
  );
  for (let leftIndex = 0; leftIndex < stages.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < stages.length; rightIndex += 1) {
      const left = stages[leftIndex];
      const right = stages[rightIndex];
      const overlaps = left.writeScope.some((leftPath) =>
        right.writeScope.some((rightPath) => pathOverlaps(leftPath, rightPath)),
      );
      if (!overlaps) continue;
      const leftAncestors = indexes.ancestorsByStage.get(left.id) ?? new Set();
      const rightAncestors = indexes.ancestorsByStage.get(right.id) ?? new Set();
      if (!leftAncestors.has(right.id) && !rightAncestors.has(left.id)) {
        errors.push(`overlapping writer scopes: ${left.id} and ${right.id}`);
      }
    }
  }
}

export function validateWorkflowPlan(plan, options = {}) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { pass: false, errors: ["plan must be an object"] };
  }
  if (!validateExactFields(plan, TOP_LEVEL_FIELDS, "plan", errors)) {
    return { pass: false, errors };
  }

  const knownAdapters = new Set(options.knownAdapters ?? KNOWN_ADAPTERS);
  const roleNames = new Set(options.roleNames ?? Object.values(RESPONSIBILITY_ROLES));
  if (plan.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    errors.push(`schemaVersion must equal ${WORKFLOW_SCHEMA_VERSION}`);
  }
  if (!isSafeId(plan.workflowId)) errors.push("workflowId must be a safe identifier");
  if (!isNonEmptyString(plan.goal)) errors.push("goal must be a non-empty string");
  if (!knownAdapters.has(plan.workflowAdapter)) errors.push("workflowAdapter is invalid");
  validateStringList(plan.inputArtifacts, "inputArtifacts", errors, { ids: true });

  if (validateExactFields(plan.attemptBudget, BUDGET_FIELDS, "attemptBudget", errors)) {
    for (const field of BUDGET_FIELDS) {
      if (!isNonNegativeInteger(plan.attemptBudget[field])) {
        errors.push(`attemptBudget.${field} must be a non-negative integer`);
      }
    }
    if (
      isNonNegativeInteger(plan.attemptBudget.total) &&
      isNonNegativeInteger(plan.attemptBudget.reservedForVerification) &&
      isNonNegativeInteger(plan.attemptBudget.reservedForRecovery) &&
      plan.attemptBudget.reservedForVerification + plan.attemptBudget.reservedForRecovery > plan.attemptBudget.total
    ) {
      errors.push("attemptBudget reserves exceed total");
    }
    if (plan.attemptBudget.reservedForRecovery > 1) {
      errors.push("attemptBudget.reservedForRecovery must not exceed one");
    }
  }

  if (!Array.isArray(plan.stages) || plan.stages.length === 0) {
    errors.push("stages must be a non-empty array");
    return { pass: false, errors };
  }
  for (let index = 0; index < plan.stages.length; index += 1) {
    validateStage(plan.stages[index], index, roleNames, errors);
  }

  const indexes = workflowIndexes(plan);
  graphErrors(plan, indexes, errors);
  writerErrors(plan, indexes, errors);

  const verificationStages = plan.stages.filter((stage) => stage?.attemptClass === "verification").length;
  const recoveryStages = plan.stages.filter((stage) => stage?.attemptClass === "recovery").length;
  if (plan.attemptBudget?.reservedForVerification < verificationStages) {
    errors.push("attemptBudget does not reserve enough verification attempts");
  }
  if (plan.attemptBudget?.reservedForRecovery < recoveryStages) {
    errors.push("attemptBudget does not reserve enough recovery attempts");
  }

  return { pass: errors.length === 0, errors };
}
