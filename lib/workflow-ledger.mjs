import { createHash } from "node:crypto";
import {
  appendPrivateJsonl,
  isLosslessJsonObject,
  isPlainObject,
  privacyErrors,
  readPrivateJsonl,
  stableValue,
} from "./private-jsonl.mjs";
import {
  createWorkflowState,
  reduceWorkflowEvent,
  sanitizeWorkflowEventForLedger,
  STAGE_STATES,
  validateWorkflowEvent,
  workflowStateSummary,
  WORKFLOW_EVENT_TYPES,
} from "./workflow-state.mjs";

export const DEFAULT_WORKFLOW_LEDGER_PATH = "reports/workflow-ledger.jsonl";

const RECORD_FIELDS = Object.freeze([
  "schemaVersion",
  "kind",
  "updatedAt",
  "workflowId",
  "planHash",
  "stageId",
  "eventType",
  "eventData",
  "state",
  "stateHash",
  "attempt",
  "attemptClass",
  "executionShape",
  "role",
  "taskHash",
  "resultHash",
  "disposition",
  "adopted",
  "policyMode",
  "policyHash",
  "permissionHash",
  "workspaceHash",
  "previousRecordHash",
  "recordHash",
]);
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INITIALIZED = "workflow_initialized";
const EVENT_TYPES = new Set([INITIALIZED, ...WORKFLOW_EVENT_TYPES]);
const STAGE_STATE_SET = new Set(STAGE_STATES);
const ATTEMPT_CLASSES = new Set(["work", "verification", "recovery"]);
const EXECUTION_SHAPES = new Set(["typed_child", "isolated_role_root", "root_inline"]);
const DISPOSITIONS = new Set(["adopted", "rejected", "blocked", "cancelled"]);
const POLICY_MODES = new Set(["active", "shadow"]);
const UPSTREAM_FIELDS = Object.freeze([
  "workflowId",
  "planHash",
  "stageId",
  "state",
  "attempt",
  "executionShape",
  "role",
  "taskHash",
  "resultHash",
  "adopted",
  "updatedAt",
]);

function exactKeys(value, fields) {
  return isPlainObject(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function isHash(value) {
  return typeof value === "string" && HASH.test(value);
}

function isSafeId(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function isIsoTimestamp(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function canonicalHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function recordHash(record) {
  const { recordHash: ignored, ...source } = record;
  void ignored;
  return canonicalHash(source);
}

function stateHash(state) {
  return canonicalHash(workflowStateSummary(state));
}

function currentAttempt(stage) {
  return stage?.attempts?.at(-1) ?? null;
}

function dispositionFor(event, attempt) {
  if (event === null) return null;
  if (event.type === "provider_closed") return event.disposition;
  if (event.type === "adopted") return "adopted";
  if (event.type === "rejected") return "rejected";
  if (event.type === "stage_blocked") return "blocked";
  if (event.type === "stage_cancelled") return "cancelled";
  return attempt?.providerDisposition ?? null;
}

function assertValidRecord(record) {
  const validation = validateWorkflowRecord(record);
  if (!validation.pass) {
    throw new TypeError(`invalid workflow record: ${validation.errors.join("; ")}`);
  }
}

export function createWorkflowRecord({ previousRecordHash, state, event }) {
  if (!state || typeof state !== "object") throw new TypeError("workflow state is required");
  const initialization = event === null;
  const workflowLevel = initialization
    || event?.type === "approval_recorded"
    || event?.type === "batch_planned";
  const eventData = initialization ? null : sanitizeWorkflowEventForLedger(event);
  if (!initialization && state.updatedAt !== eventData.at) {
    throw new TypeError("workflow event timestamp must match state updatedAt");
  }
  const stageId = workflowLevel ? null : eventData.stageId;
  const stage = stageId === null ? null : state.stages?.[stageId];
  if (stageId !== null && !stage) throw new TypeError("workflow event stage is missing from state");
  const attempt = currentAttempt(stage);
  const record = {
    schemaVersion: 1,
    kind: "workflow_transition",
    updatedAt: state.updatedAt,
    workflowId: state.workflowId,
    planHash: state.planHash,
    stageId,
    eventType: initialization ? INITIALIZED : eventData.type,
    eventData,
    state: stage?.state ?? null,
    stateHash: stateHash(state),
    attempt: stage?.attemptNumber ?? null,
    attemptClass: attempt?.attemptClass ?? null,
    executionShape: attempt?.executionShape ?? null,
    role: attempt?.role ?? null,
    taskHash: attempt?.taskHash ?? null,
    resultHash: attempt?.resultHash ?? null,
    disposition: dispositionFor(eventData, attempt),
    adopted: stage === null ? null : attempt?.adopted === true,
    policyMode: state.policyMode,
    policyHash: state.policyHash,
    permissionHash: state.permissionHash,
    workspaceHash: state.workspaceHash,
    previousRecordHash,
    recordHash: null,
  };
  record.recordHash = recordHash(record);
  assertValidRecord(record);
  return record;
}

export function validateWorkflowRecord(record) {
  const errors = [];
  if (!isPlainObject(record)) return { pass: false, errors: ["record must be an object"] };
  const lossless = isLosslessJsonObject(record);
  if (!lossless) errors.push("record must be a lossless JSON object");
  errors.push(...privacyErrors(record, "record"));
  if (!exactKeys(record, RECORD_FIELDS)) {
    errors.push("record must contain exactly the workflow-transition fields");
  }
  if (record.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  if (record.kind !== "workflow_transition") errors.push('kind must equal "workflow_transition"');
  if (!isIsoTimestamp(record.updatedAt)) errors.push("updatedAt must be an ISO timestamp");
  if (!isSafeId(record.workflowId)) errors.push("workflowId must be a safe identifier");
  for (const field of ["planHash", "stateHash", "policyHash", "permissionHash", "workspaceHash", "recordHash"]) {
    if (!isHash(record[field])) errors.push(`${field} must be a SHA-256 hash`);
  }
  if (!EVENT_TYPES.has(record.eventType)) errors.push("eventType is invalid");
  if (!POLICY_MODES.has(record.policyMode)) errors.push("policyMode is invalid");
  if (!(record.previousRecordHash === null || isHash(record.previousRecordHash))) {
    errors.push("previousRecordHash must be a SHA-256 hash or null");
  }

  const initialization = record.eventType === INITIALIZED;
  const workflowLevel = initialization
    || record.eventType === "approval_recorded"
    || record.eventType === "batch_planned";
  if (initialization) {
    if (record.eventData !== null) errors.push("initialization eventData must be null");
  } else if (lossless) {
    const eventValidation = validateWorkflowEvent(record.eventData);
    if (!eventValidation.pass) errors.push(...eventValidation.errors.map((error) => `eventData ${error}`));
    if (record.eventData?.type !== record.eventType) errors.push("eventType must match eventData.type");
    if (record.eventData?.at !== record.updatedAt) errors.push("eventData.at must match updatedAt");
    if (eventValidation.pass) {
      const sanitized = sanitizeWorkflowEventForLedger(record.eventData);
      if (JSON.stringify(stableValue(sanitized)) !== JSON.stringify(stableValue(record.eventData))) {
        errors.push("eventData must already be privacy-safe and sanitized");
      }
    }
  }

  if (workflowLevel) {
    for (const field of ["stageId", "state", "attempt", "attemptClass", "executionShape", "role", "taskHash", "resultHash", "disposition", "adopted"]) {
      if (record[field] !== null) errors.push(`${field} must be null for a workflow-level event`);
    }
  } else {
    if (!isSafeId(record.stageId)) errors.push("stageId must be a safe identifier");
    if (record.eventData?.stageId !== record.stageId) errors.push("stageId must match eventData.stageId");
    if (!STAGE_STATE_SET.has(record.state)) errors.push("state is invalid");
    if (!Number.isInteger(record.attempt) || record.attempt < 0) errors.push("attempt must be a nonnegative integer");
    if (typeof record.adopted !== "boolean") errors.push("adopted must be a boolean");
    if (!(record.attemptClass === null || ATTEMPT_CLASSES.has(record.attemptClass))) errors.push("attemptClass is invalid");
    if (!(record.executionShape === null || EXECUTION_SHAPES.has(record.executionShape))) errors.push("executionShape is invalid");
    if (!(record.role === null || isSafeId(record.role))) errors.push("role must be a safe identifier or null");
    for (const field of ["taskHash", "resultHash"]) {
      if (!(record[field] === null || isHash(record[field]))) errors.push(`${field} must be a SHA-256 hash or null`);
    }
    if (!(record.disposition === null || DISPOSITIONS.has(record.disposition))) errors.push("disposition is invalid");
  }
  if (initialization && record.previousRecordHash !== null) {
    errors.push("initialization previousRecordHash must be null");
  }
  if (!initialization && !isHash(record.previousRecordHash)) {
    errors.push("non-initialization record requires previousRecordHash");
  }
  if (lossless && isHash(record.recordHash) && recordHash(record) !== record.recordHash) {
    errors.push("recordHash does not match the canonical record");
  }
  return { pass: errors.length === 0, errors };
}

export function appendWorkflowRecord(store, record) {
  assertValidRecord(record);
  if (store?.kind === "managed" && typeof store.path === "string") {
    const existing = readPrivateJsonl(store.path, {
      defaultPath: DEFAULT_WORKFLOW_LEDGER_PATH,
      validate: validateWorkflowRecord,
    });
    assertAppendLink(existing, record);
    return appendPrivateJsonl(store.path, record, {
      defaultPath: DEFAULT_WORKFLOW_LEDGER_PATH,
      validate: validateWorkflowRecord,
    });
  }
  if (store?.kind === "upstream" && typeof store.append === "function") {
    const existing = store.load();
    if (!Array.isArray(existing)) throw new TypeError("workflow upstream load must return records");
    for (const item of existing) assertValidRecord(item);
    assertAppendLink(existing, record);
    return store.append(record);
  }
  if (store?.kind === "blocked") {
    throw new TypeError("workflow upstream store is incompatible");
  }
  throw new TypeError("workflow store is invalid");
}

function assertAppendLink(existing, record) {
  let previous = null;
  for (const [index, item] of existing.entries()) {
    if (item.previousRecordHash !== previous) throw new TypeError("workflow record hash chain is broken");
    if ((index === 0) !== (item.eventType === INITIALIZED)) {
      throw new TypeError("workflow record initialization order is invalid");
    }
    previous = item.recordHash;
  }
  if (existing.length === 0) {
    if (record.eventType !== INITIALIZED || record.previousRecordHash !== null) {
      throw new TypeError("workflow record hash chain must begin with initialization");
    }
    return;
  }
  if (record.eventType === INITIALIZED || record.previousRecordHash !== previous) {
    throw new TypeError("workflow record hash chain does not match the previous record");
  }
}

export function validateWorkflowRecordSequence(records) {
  const errors = [];
  if (!Array.isArray(records) || records.length === 0) {
    return { pass: false, errors: ["workflow record sequence must be a non-empty array"] };
  }
  for (const [index, record] of records.entries()) {
    const validation = validateWorkflowRecord(record);
    if (!validation.pass) {
      errors.push(...validation.errors.map((error) => `record ${index}: ${error}`));
    }
  }
  if (errors.length > 0) return { pass: false, errors };
  if (records[0].eventType !== INITIALIZED) errors.push("workflow record sequence must begin with initialization");
  const binding = records[0];
  let previous = null;
  for (const [index, record] of records.entries()) {
    if (record.previousRecordHash !== previous) errors.push(`record ${index}: hash chain is broken`);
    if (index > 0 && record.eventType === INITIALIZED) errors.push(`record ${index}: duplicate initialization`);
    for (const field of ["workflowId", "planHash", "policyMode", "policyHash", "permissionHash", "workspaceHash"]) {
      if (record[field] !== binding[field]) errors.push(`record ${index}: ${field} binding drifted`);
    }
    previous = record.recordHash;
  }
  return { pass: errors.length === 0, errors };
}

export function replayWorkflowRecords({ plan, records }) {
  if (!plan) throw new TypeError("workflow replay requires a plan");
  const sequenceValidation = validateWorkflowRecordSequence(records);
  if (!sequenceValidation.pass) throw new TypeError(`invalid workflow record sequence: ${sequenceValidation.errors.join("; ")}`);

  const binding = records[0];
  let state = createWorkflowState({
    plan,
    planHash: binding.planHash,
    policyMode: binding.policyMode,
    policyHash: binding.policyHash,
    permissionHash: binding.permissionHash,
    workspaceHash: binding.workspaceHash,
    at: binding.updatedAt,
  });
  let previousRecordHash = null;

  for (const [index, record] of records.entries()) {
    if (index > 0) {
      state = reduceWorkflowEvent({ plan, state, event: record.eventData });
    }
    const expected = createWorkflowRecord({
      previousRecordHash,
      state,
      event: index === 0 ? null : record.eventData,
    });
    if (JSON.stringify(stableValue(expected)) !== JSON.stringify(stableValue(record))) {
      throw new TypeError("workflow record does not match replayed state");
    }
    previousRecordHash = record.recordHash;
  }
  return state;
}

export function selectWorkflowStore({
  upstream = null,
  managedPath = DEFAULT_WORKFLOW_LEDGER_PATH,
} = {}) {
  if (upstream !== null) {
    let supported = false;
    try {
      supported = typeof upstream.supports === "function"
        && upstream.supports(UPSTREAM_FIELDS) === true
        && typeof upstream.load === "function"
        && typeof upstream.append === "function";
    } catch {
      supported = false;
    }
    if (!supported) {
      return { kind: "blocked", reasonCode: "WORKFLOW_UPSTREAM_STORE_INCOMPATIBLE" };
    }
    return { kind: "upstream", load: upstream.load, append: upstream.append };
  }
  if (typeof managedPath !== "string" || managedPath.length === 0) {
    throw new TypeError("managed workflow ledger path is required");
  }
  return { kind: "managed", path: managedPath };
}
