import assert from "node:assert/strict";
import test from "node:test";
import {
  addRecord,
  createLedger,
  evaluateLedger,
  summarizeObservedUsageReport,
  validateObservedUsageReport,
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

function observedUsageReport(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "real_work_child_runtime",
    generatedAt: "2026-07-13T13:45:00.000Z",
    scope: "child_only",
    parentThreadCount: 4,
    childSessionCount: 15,
    completedTurnCount: 24,
    runtimeMetadataVerifiedSessionCount: 15,
    forkNoneSessionCount: 15,
    nestedSpawnSessionCount: 0,
    policyCompliantSessionCount: 2,
    policyRejectedSessionCount: 13,
    permissionMismatchSessionCount: 13,
    spawnOverrideMismatchSessionCount: 1,
    roles: [
      {
        role: "terra_explorer",
        model: "gpt-5.6-terra",
        effort: "medium",
        sessions: 7,
        completedTurns: 8,
        policyCompliantSessions: 0,
        policyRejectedSessions: 7,
        permissionMismatchSessions: 7,
        spawnOverrideMismatchSessions: 0,
        tokens: {
          uncachedInput: 594377,
          cachedInput: 3254784,
          output: 40790,
        },
      },
      {
        role: "sol_reviewer",
        model: "gpt-5.6-sol",
        effort: "high",
        sessions: 6,
        completedTurns: 13,
        policyCompliantSessions: 0,
        policyRejectedSessions: 6,
        permissionMismatchSessions: 6,
        spawnOverrideMismatchSessions: 1,
        tokens: {
          uncachedInput: 695371,
          cachedInput: 9668352,
          output: 69929,
        },
      },
      {
        role: "terra_worker",
        model: "gpt-5.6-terra",
        effort: "high",
        sessions: 2,
        completedTurns: 3,
        policyCompliantSessions: 2,
        policyRejectedSessions: 0,
        permissionMismatchSessions: 0,
        spawnOverrideMismatchSessions: 0,
        tokens: {
          uncachedInput: 332310,
          cachedInput: 6958848,
          output: 53726,
        },
      },
    ],
    ...overrides,
  };
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

test("observed child runtime is validated separately from comparable pairs", () => {
  const report = observedUsageReport();
  assert.equal(validateObservedUsageReport(report).valid, true);
  const summary = summarizeObservedUsageReport(report);
  assert.equal(summary.childSessionCount, 15);
  assert.equal(summary.completedTurnCount, 24);
  assert.equal(summary.policyCompliantSessionCount, 2);
  assert.equal(summary.permissionMismatchSessionCount, 13);
  assert.equal("completePairCount" in summary, false);
  assert.equal("estimatedSavings" in summary, false);
});

test("observed child runtime rejects private fields and inconsistent totals", () => {
  assert.equal(
    validateObservedUsageReport(observedUsageReport({ threadIds: ["private"] })).valid,
    false,
  );
  assert.equal(
    validateObservedUsageReport(observedUsageReport({ childSessionCount: 14 })).valid,
    false,
  );
  assert.equal(
    validateObservedUsageReport(
      observedUsageReport({ policyCompliantSessionCount: 3 }),
    ).valid,
    false,
  );
  const duplicateRole = observedUsageReport();
  duplicateRole.roles = [...duplicateRole.roles, duplicateRole.roles[0]];
  assert.equal(validateObservedUsageReport(duplicateRole).valid, false);
});
