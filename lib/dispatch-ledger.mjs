import { appendPrivateJsonl, isPlainObject, privacyErrors } from "./private-jsonl.mjs";

export const DEFAULT_DISPATCH_LEDGER_PATH = "reports/dispatch-ledger.jsonl";

const RECORD_FIELDS = Object.freeze([
  "schemaVersion",
  "kind",
  "generatedAt",
  "taskHash",
  "workflowAdapter",
  "responsibility",
  "executionShape",
  "role",
  "parentPermission",
  "reasonCode",
  "accepted",
  "retryCount",
  "escalatedToRoot",
  "actualModel",
  "actualEffort",
  "tokens",
  "rootVerificationPassed",
  "synthetic",
]);
const TOKEN_FIELDS = Object.freeze(["parent", "child", "isolatedRoot"]);
const EXECUTION_SHAPES = new Set([
  "typed_child",
  "typed_child_bridge",
  "isolated_role_root",
  "root_inline",
]);
const PERMISSIONS = new Set(["read-only", "workspace-write"]);
const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_CODE = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;

function hasExactKeys(value, fields) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function isIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function verificationPassed(rootVerification) {
  return rootVerification === true || rootVerification?.pass === true;
}

function runtimeTokens(result, executionShape) {
  const parentTokens = isNonnegativeInteger(result?.actual?.parentTokens)
    ? result.actual.parentTokens
    : 0;
  const childTokens = isNonnegativeInteger(result?.actual?.childTokens)
    ? result.actual.childTokens
    : 0;
  if (executionShape === "isolated_role_root") {
    return { parent: 0, child: 0, isolatedRoot: parentTokens };
  }
  return { parent: parentTokens, child: childTokens, isolatedRoot: 0 };
}

function assertValid(record) {
  const validation = validateDispatchRecord(record);
  if (!validation.pass) {
    throw new TypeError(`invalid dispatch record: ${validation.errors.join("; ")}`);
  }
}

export function createDispatchRecord({
  decision,
  result,
  workflowAdapter,
  parentPermission,
  rootVerification,
}) {
  const executionShape = decision?.effectiveShape ?? decision?.selectedShape;
  const rootVerificationPassed = verificationPassed(rootVerification);
  const record = {
    schemaVersion: 1,
    kind: "dispatch_decision",
    generatedAt: new Date().toISOString(),
    taskHash: decision?.taskHash,
    workflowAdapter,
    responsibility: decision?.responsibility,
    executionShape,
    role: decision?.role ?? null,
    parentPermission,
    reasonCode: decision?.reasonCode,
    accepted: result?.pass === true && rootVerificationPassed,
    retryCount: result?.retryCount ?? 0,
    escalatedToRoot: executionShape === "root_inline" || result?.rollbackRequired === true,
    actualModel: result?.actual?.model ?? null,
    actualEffort: result?.actual?.effort ?? null,
    tokens: runtimeTokens(result, executionShape),
    rootVerificationPassed,
    synthetic: result?.synthetic === true,
  };
  assertValid(record);
  return record;
}

export function validateDispatchRecord(record) {
  const errors = [];
  if (!isPlainObject(record)) return { pass: false, errors: ["record must be an object"] };

  errors.push(...privacyErrors(record, "record"));
  if (!hasExactKeys(record, RECORD_FIELDS)) {
    errors.push("record must contain exactly the public dispatch-ledger fields");
  }
  if (record.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (record.kind !== "dispatch_decision") errors.push('kind must equal "dispatch_decision"');
  if (
    typeof record.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.generatedAt)) ||
    new Date(record.generatedAt).toISOString() !== record.generatedAt
  ) {
    errors.push("generatedAt must be an ISO timestamp");
  }
  if (!HASH.test(record.taskHash ?? "")) errors.push("taskHash must be a SHA-256 hash");
  for (const field of ["workflowAdapter", "responsibility"]) {
    if (!isIdentifier(record[field])) errors.push(`${field} must be a safe identifier`);
  }
  if (!EXECUTION_SHAPES.has(record.executionShape)) {
    errors.push("executionShape is invalid");
  }
  if (!(record.role === null || isIdentifier(record.role))) {
    errors.push("role must be a safe identifier or null");
  }
  if (!PERMISSIONS.has(record.parentPermission)) errors.push("parentPermission is invalid");
  if (typeof record.reasonCode !== "string" || !REASON_CODE.test(record.reasonCode)) {
    errors.push("reasonCode must be a safe code");
  }
  for (const field of ["accepted", "escalatedToRoot", "rootVerificationPassed", "synthetic"]) {
    if (typeof record[field] !== "boolean") errors.push(`${field} must be a boolean`);
  }
  if (!Number.isInteger(record.retryCount) || record.retryCount < 0 || record.retryCount > 1) {
    errors.push("retryCount must be zero or one");
  }
  for (const field of ["actualModel", "actualEffort"]) {
    if (!(record[field] === null || isIdentifier(record[field]))) {
      errors.push(`${field} must be a safe identifier or null`);
    }
  }
  if (!hasExactKeys(record.tokens, TOKEN_FIELDS)) {
    errors.push("tokens must contain exactly parent, child, and isolatedRoot");
  } else {
    for (const field of TOKEN_FIELDS) {
      if (!isNonnegativeInteger(record.tokens[field])) {
        errors.push(`tokens.${field} must be a nonnegative integer`);
      }
    }
  }
  return { pass: errors.length === 0, errors };
}

export function appendDispatchRecord(path = DEFAULT_DISPATCH_LEDGER_PATH, record) {
  assertValid(record);
  appendPrivateJsonl(path, record, {
    defaultPath: DEFAULT_DISPATCH_LEDGER_PATH,
    validate: validateDispatchRecord,
  });
}
