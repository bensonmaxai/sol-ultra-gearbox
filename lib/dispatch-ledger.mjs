import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

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
const FORBIDDEN_FIELDS = new Set([
  "prompt",
  "message",
  "goal",
  "sessionid",
  "path",
  "cwd",
  "auth",
  "secret",
  "token",
  "stdout",
  "stderr",
]);
const HASH = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REASON_CODE = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const PRIVATE_HOME = /\/(?:Users|home)\/(?!example(?:\/|$)|test(?:\/|$)|username(?:\/|$))[^\s"'`]*/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

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

function scanPrivacy(value, label, errors) {
  if (typeof value === "string") {
    if (PRIVATE_HOME.test(value)) errors.push(`${label} contains a private absolute home path`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanPrivacy(item, `${label}[${index}]`, errors));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      errors.push(`${label} contains forbidden field: ${key}`);
    }
    scanPrivacy(child, `${label}.${key}`, errors);
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return value;
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

  scanPrivacy(record, "record", errors);
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
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new TypeError("dispatch ledger parent must be a directory");
  }
  chmodSync(parent, 0o700);

  let source = "";
  if (existsSync(path)) {
    const fileStat = lstatSync(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new TypeError("dispatch ledger must be a regular file");
    }
    source = readFileSync(path, "utf8");
    if (source.length > 0 && !source.endsWith("\n")) {
      throw new TypeError("dispatch ledger has an incomplete record");
    }
  }

  const line = `${JSON.stringify(stable(record))}\n`;
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${source}${line}`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    const descriptor = openSync(temporary, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}
