import assert from "node:assert/strict";
import test from "node:test";
import {
  addRecord,
  createLedger,
  evaluateLedger,
  validateRecord,
} from "../lib/cost-evidence.mjs";

function record(overrides = {}) {
  return {
    kind: "real_work",
    taskFamily: "routing_policy",
    pairId: "pair-001",
    variant: "sol_single",
    completed: true,
    accepted: true,
    durationMs: 1200,
    reworkCount: 0,
    tokens: {
      "gpt-5.6-sol": {
        uncachedInput: 100,
        cachedInput: 20,
        output: 50,
      },
    },
    ...overrides,
  };
}

function addCompletePair(ledger, index) {
  const pairId = `pair-${String(index).padStart(3, "0")}`;
  return addRecord(
    addRecord(ledger, record({ pairId })),
    record({ pairId, variant: "gearbox", durationMs: 900 }),
  );
}

test("validation rejects malformed, smoke, and sensitive records", () => {
  assert.equal(validateRecord(record({ kind: "smoke" })).valid, false);
  assert.equal(validateRecord(record({ durationMs: -1 })).valid, false);
  assert.equal(validateRecord(record({ reworkCount: 1.5 })).valid, false);
  assert.equal(
    validateRecord(
      record({
        tokens: {
          "gpt-5.6-sol": { uncachedInput: 1.5, cachedInput: 0, output: 1 },
        },
      }),
    ).valid,
    false,
  );
  assert.equal(validateRecord(record({ prompt: "private work text" })).valid, false);
  assert.equal(
    validateRecord(record({ tokens: { "gpt-5.6-sol": { uncachedInput: 1 } } })).valid,
    false,
  );
});

test("addRecord keeps incomplete pairs and rejects duplicate variants", () => {
  const once = addRecord(createLedger(), record());
  const status = evaluateLedger(once);
  assert.equal(status.completePairCount, 0);
  assert.equal(status.incompletePairCount, 1);
  assert.throws(() => addRecord(once, record()), /duplicate accepted record/);
});

test("nine complete real-work pairs remain ineligible without price or savings", () => {
  let ledger = createLedger();
  for (let index = 1; index <= 9; index += 1) ledger = addCompletePair(ledger, index);

  const status = evaluateLedger(ledger);
  assert.equal(status.completePairCount, 9);
  assert.equal(status.eligibleForEstimate, false);
  assert.equal("savings" in status, false);
  assert.equal("price" in status, false);
  assert.equal("estimatedSavings" in status, false);
});

test("ten complete real-work pairs become eligible with aggregate raw evidence only", () => {
  let ledger = createLedger();
  for (let index = 1; index <= 10; index += 1) ledger = addCompletePair(ledger, index);

  const status = evaluateLedger(ledger);
  assert.equal(status.completePairCount, 10);
  assert.equal(status.eligibleForEstimate, true);
  assert.deepEqual(status.rawEvidence.sol_single, {
    recordCount: 10,
    durationMs: 12000,
    reworkCount: 0,
    tokensByModel: {
      "gpt-5.6-sol": {
        uncachedInput: 1000,
        cachedInput: 200,
        output: 500,
      },
    },
  });
  assert.equal("savings" in status, false);
  assert.equal("price" in status, false);
  assert.equal("estimateCredits" in status, false);
});

test("raw comparison aggregates exclude incomplete pairs", () => {
  let ledger = createLedger();
  ledger = addCompletePair(ledger, 1);
  ledger = addRecord(
    ledger,
    record({ pairId: "pair-incomplete", durationMs: 999999 }),
  );
  const status = evaluateLedger(ledger);
  assert.equal(status.completePairCount, 1);
  assert.equal(status.incompletePairCount, 1);
  assert.equal(status.rawEvidence.sol_single.recordCount, 1);
  assert.equal(status.rawEvidence.sol_single.durationMs, 1200);
});
