import { createHash } from "node:crypto";
import {
  appendPrivateJsonl,
  isLosslessJsonObject,
  isPlainObject,
  privacyErrors,
} from "./private-jsonl.mjs";
import { hashWorkflowPlan } from "./workflow-plan.mjs";

export const DEFAULT_WORKFLOW_OUTCOME_PATH = "reports/workflow-outcomes.jsonl";

const RECORD_FIELDS = Object.freeze([
  "schemaVersion",
  "kind",
  "generatedAt",
  "workflowHash",
  "stageIdHash",
  "attemptClass",
  "attemptNumber",
  "materialized",
  "verified",
  "adopted",
  "closed",
  "rootReworkRequired",
  "reservedAttemptsBefore",
  "reservedAttemptsAfter",
  "retryCount",
  "escalatedToRoot",
  "actualModel",
  "actualEffort",
  "tokens",
  "reasonCode",
  "synthetic",
]);
const RESERVE_FIELDS = Object.freeze(["verification", "recovery"]);
const ATTEMPT_CLASSES = new Set(["work", "verification", "recovery"]);
const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_CODE = /^[A-Z][A-Z0-9_:-]{1,127}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hasExactKeys(value, fields) {
  return isPlainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function isNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function assertValid(record) {
  const validation = validateWorkflowOutcomeRecord(record);
  if (!validation.pass) {
    throw new TypeError(`invalid workflow outcome: ${validation.errors.join("; ")}`);
  }
}

export function createWorkflowOutcomeRecord({ plan, state, stageId, generatedAt }) {
  if (!plan || typeof plan.workflowId !== "string" || !Array.isArray(plan.stages)) {
    throw new TypeError("workflow plan is required");
  }
  if (typeof stageId !== "string" || !plan.stages.some((stage) => stage.id === stageId)) {
    throw new TypeError("workflow stage is unknown");
  }
  if (state?.workflowId !== plan.workflowId || state?.planHash !== hashWorkflowPlan(plan)) {
    throw new TypeError("workflow state is not bound to its plan");
  }
  const stage = state?.stages?.[stageId];
  const attempt = stage?.attempts?.at(-1);
  if (!stage || !attempt) throw new TypeError("workflow stage has no attempt outcome");

  const inlineRemediation = attempt.executionShape === "root_inline"
    && (attempt.attemptNumber > 1 || attempt.attemptClass === "recovery");
  const record = {
    schemaVersion: 1,
    kind: "workflow_outcome",
    generatedAt,
    workflowHash: sha256(plan.workflowId),
    stageIdHash: sha256(stageId),
    attemptClass: attempt.attemptClass,
    attemptNumber: attempt.attemptNumber,
    materialized: HASH.test(attempt.materializationHash ?? ""),
    verified: HASH.test(attempt.mechanicalCheckHash ?? ""),
    adopted: attempt.adopted === true,
    closed: stage.state === "closed" && attempt.providerClosed === true,
    rootReworkRequired: stage.correctionUsed === true || inlineRemediation,
    reservedAttemptsBefore: {
      verification: attempt.reservedAttemptsBefore?.verification,
      recovery: attempt.reservedAttemptsBefore?.recovery,
    },
    reservedAttemptsAfter: {
      verification: attempt.reservedAttemptsAfter?.verification,
      recovery: attempt.reservedAttemptsAfter?.recovery,
    },
    retryCount: attempt.attemptNumber > 1 ? 1 : 0,
    escalatedToRoot: attempt.executionShape === "root_inline",
    actualModel: attempt.actualModel ?? null,
    actualEffort: attempt.actualEffort ?? null,
    tokens: attempt.tokens ?? 0,
    reasonCode: attempt.reasonCode ?? attempt.rejection?.reasonCode ?? "WORKFLOW_OUTCOME_RECORDED",
    synthetic: attempt.synthetic === true,
  };
  assertValid(record);
  return record;
}

export function validateWorkflowOutcomeRecord(record) {
  const errors = [];
  if (!isPlainObject(record)) return { pass: false, errors: ["record must be an object"] };

  errors.push(...privacyErrors(record, "record"));
  if (!isLosslessJsonObject(record)) errors.push("record must be a lossless JSON object");
  if (!hasExactKeys(record, RECORD_FIELDS)) {
    errors.push("record must contain exactly the workflow outcome fields");
  }
  if (record.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (record.kind !== "workflow_outcome") errors.push('kind must equal "workflow_outcome"');
  if (
    typeof record.generatedAt !== "string"
    || !Number.isFinite(Date.parse(record.generatedAt))
    || new Date(record.generatedAt).toISOString() !== record.generatedAt
  ) {
    errors.push("generatedAt must be an ISO timestamp");
  }
  for (const field of ["workflowHash", "stageIdHash"]) {
    if (!HASH.test(record[field] ?? "")) errors.push(`${field} must be a SHA-256 hash`);
  }
  if (!ATTEMPT_CLASSES.has(record.attemptClass)) errors.push("attemptClass is invalid");
  if (!Number.isInteger(record.attemptNumber) || record.attemptNumber < 1) {
    errors.push("attemptNumber must be a positive integer");
  }
  for (const field of [
    "materialized",
    "verified",
    "adopted",
    "closed",
    "rootReworkRequired",
    "escalatedToRoot",
    "synthetic",
  ]) {
    if (typeof record[field] !== "boolean") errors.push(`${field} must be a boolean`);
  }
  for (const field of ["reservedAttemptsBefore", "reservedAttemptsAfter"]) {
    if (!hasExactKeys(record[field], RESERVE_FIELDS)) {
      errors.push(`${field} must contain exactly verification and recovery`);
      continue;
    }
    for (const reserve of RESERVE_FIELDS) {
      if (!isNonnegativeInteger(record[field][reserve])) {
        errors.push(`${field}.${reserve} must be a nonnegative integer`);
      }
    }
  }
  if (!Number.isInteger(record.retryCount) || record.retryCount < 0 || record.retryCount > 1) {
    errors.push("retryCount must be zero or one");
  }
  for (const field of ["actualModel", "actualEffort"]) {
    if (!(record[field] === null || isIdentifier(record[field]))) {
      errors.push(`${field} must be a safe identifier or null`);
    }
  }
  if (!isNonnegativeInteger(record.tokens)) errors.push("tokens must be a nonnegative integer");
  if (typeof record.reasonCode !== "string" || !REASON_CODE.test(record.reasonCode)) {
    errors.push("reasonCode must be a safe uppercase code");
  }
  return { pass: errors.length === 0, errors };
}

export function appendWorkflowOutcome(path = DEFAULT_WORKFLOW_OUTCOME_PATH, record) {
  assertValid(record);
  if (typeof path === "string") {
    appendPrivateJsonl(path, record, {
      defaultPath: DEFAULT_WORKFLOW_OUTCOME_PATH,
      validate: validateWorkflowOutcomeRecord,
    });
    return;
  }
  if (!isPlainObject(path) || typeof path.appendOutcome !== "function") {
    throw new TypeError("workflow outcome destination must be a path or explicit upstream sink");
  }
  path.appendOutcome(record);
}
