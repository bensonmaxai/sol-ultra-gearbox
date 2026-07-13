const LEDGER_VERSION = 1;
const VARIANTS = new Set(["sol_single", "gearbox"]);
const RECORD_FIELDS = new Set([
  "kind",
  "taskFamily",
  "pairId",
  "variant",
  "completed",
  "accepted",
  "durationMs",
  "reworkCount",
  "tokens",
]);
const TOKEN_FIELDS = new Set(["uncachedInput", "cachedInput", "output"]);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonnegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isIdentifier(value) {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validateExactFields(value, allowed, label, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} contains unsupported field: ${key}`);
  }
}

function validateTokens(tokens, errors) {
  if (!isPlainObject(tokens) || Object.keys(tokens).length === 0) {
    errors.push("tokens must be a non-empty object keyed by model");
    return;
  }

  for (const model of Object.keys(tokens)) {
    if (!isIdentifier(model)) {
      errors.push(`tokens has invalid model key: ${model}`);
      continue;
    }
    const breakdown = tokens[model];
    if (!isPlainObject(breakdown)) {
      errors.push(`tokens.${model} must be an object`);
      continue;
    }
    validateExactFields(breakdown, TOKEN_FIELDS, `tokens.${model}`, errors);
    for (const field of TOKEN_FIELDS) {
      if (!isNonnegativeInteger(breakdown[field])) {
        errors.push(`tokens.${model}.${field} must be a nonnegative integer`);
      }
    }
  }
}

function cloneRecord(record) {
  const tokens = {};
  for (const model of Object.keys(record.tokens).sort()) {
    const breakdown = record.tokens[model];
    tokens[model] = {
      uncachedInput: breakdown.uncachedInput,
      cachedInput: breakdown.cachedInput,
      output: breakdown.output,
    };
  }
  return {
    kind: record.kind,
    taskFamily: record.taskFamily,
    pairId: record.pairId,
    variant: record.variant,
    completed: record.completed,
    accepted: record.accepted,
    durationMs: record.durationMs,
    reworkCount: record.reworkCount,
    tokens,
  };
}

function pairKey(record) {
  return `${record.taskFamily}\u0000${record.pairId}`;
}

function assertValid(result, label) {
  if (!result.valid) throw new TypeError(`${label}: ${result.errors.join("; ")}`);
}

export function createLedger() {
  return { version: LEDGER_VERSION, records: [] };
}

export function validateRecord(record) {
  const errors = [];
  if (!isPlainObject(record)) return { valid: false, errors: ["record must be an object"] };

  validateExactFields(record, RECORD_FIELDS, "record", errors);
  if (record.kind !== "real_work") errors.push('kind must equal "real_work"');
  if (!isIdentifier(record.taskFamily)) errors.push("taskFamily must be a safe identifier");
  if (!isIdentifier(record.pairId)) errors.push("pairId must be a safe identifier");
  if (!VARIANTS.has(record.variant)) errors.push("variant must be sol_single or gearbox");
  if (record.completed !== true) errors.push("completed must be true");
  if (record.accepted !== true) errors.push("accepted must be true");
  if (!isNonnegativeNumber(record.durationMs)) {
    errors.push("durationMs must be a nonnegative number");
  }
  if (!Number.isInteger(record.reworkCount) || record.reworkCount < 0) {
    errors.push("reworkCount must be a nonnegative integer");
  }
  validateTokens(record.tokens, errors);
  return { valid: errors.length === 0, errors };
}

export function validateLedger(ledger) {
  const errors = [];
  if (!isPlainObject(ledger)) return { valid: false, errors: ["ledger must be an object"] };
  validateExactFields(ledger, new Set(["version", "records"]), "ledger", errors);
  if (ledger.version !== LEDGER_VERSION) errors.push(`ledger version must equal ${LEDGER_VERSION}`);
  if (!Array.isArray(ledger.records)) {
    errors.push("ledger records must be an array");
    return { valid: false, errors };
  }

  const seen = new Set();
  ledger.records.forEach((record, index) => {
    const validation = validateRecord(record);
    for (const error of validation.errors) errors.push(`records[${index}]: ${error}`);
    if (validation.valid) {
      const key = `${pairKey(record)}\u0000${record.variant}`;
      if (seen.has(key)) errors.push(`records[${index}]: duplicate accepted record`);
      seen.add(key);
    }
  });
  return { valid: errors.length === 0, errors };
}

export function addRecord(ledger, record) {
  assertValid(validateLedger(ledger), "invalid ledger");
  assertValid(validateRecord(record), "invalid record");
  const duplicate = ledger.records.some(
    (existing) => pairKey(existing) === pairKey(record) && existing.variant === record.variant,
  );
  if (duplicate) throw new TypeError("duplicate accepted record for pair and variant");
  return {
    version: LEDGER_VERSION,
    records: [...ledger.records.map(cloneRecord), cloneRecord(record)],
  };
}

function createAggregate() {
  return { recordCount: 0, durationMs: 0, reworkCount: 0, tokensByModel: {} };
}

function addToAggregate(aggregate, record) {
  aggregate.recordCount += 1;
  aggregate.durationMs += record.durationMs;
  aggregate.reworkCount += record.reworkCount;
  for (const model of Object.keys(record.tokens).sort()) {
    if (!aggregate.tokensByModel[model]) {
      aggregate.tokensByModel[model] = { uncachedInput: 0, cachedInput: 0, output: 0 };
    }
    for (const field of TOKEN_FIELDS) {
      aggregate.tokensByModel[model][field] += record.tokens[model][field];
    }
  }
}

export function evaluateLedger(ledger) {
  assertValid(validateLedger(ledger), "invalid ledger");
  const pairs = new Map();
  for (const record of ledger.records) {
    const key = pairKey(record);
    if (!pairs.has(key)) pairs.set(key, new Map());
    pairs.get(key).set(record.variant, record);
  }

  let completePairCount = 0;
  let incompletePairCount = 0;
  const rawEvidence = { sol_single: createAggregate(), gearbox: createAggregate() };
  for (const variants of pairs.values()) {
    if (variants.size === VARIANTS.size) {
      completePairCount += 1;
      for (const record of variants.values()) {
        addToAggregate(rawEvidence[record.variant], record);
      }
    } else {
      incompletePairCount += 1;
    }
  }
  return {
    completePairCount,
    incompletePairCount,
    eligibleForEstimate: completePairCount >= 10,
    rawEvidence,
  };
}
