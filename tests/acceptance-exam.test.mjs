import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCEPTANCE_SCENARIOS,
  runAcceptanceExam,
} from "../lib/acceptance-exam.mjs";
import { createRuntimeBinding } from "../lib/runtime-evidence.mjs";

const EXPECTED = Object.freeze([
  ["Q1_ROOT_TRIVIAL", "root_inline", "ROOT_TRIVIAL"],
  ["Q2_ISOLATED_LUNA", "isolated_role_root", "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH"],
  ["Q3_ISOLATED_TERRA", "isolated_role_root", "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH"],
  ["Q4_TYPED_WORKER", "typed_child", "DELEGATE_TYPED_PERMISSION_MATCH"],
  ["Q5_ROOT_HIGH_RISK", "root_inline", "ROOT_HIGH_RISK"],
  ["Q6_UNKNOWN_SKILL", "root_inline", "ROOT_UNKNOWN_SKILL"],
  ["Q7_BRIDGE_DISABLED", "root_inline", "ROOT_BRIDGE_DISABLED"],
  ["Q8_RUNTIME_MISMATCH_REJECTED", "root_inline", "ROOT_RUNTIME_EVIDENCE_FAILED"],
  ["Q9_WRITE_VIOLATION_REJECTED", "root_inline", "ROOT_PERMISSION_VIOLATION"],
  ["Q10_TWO_TYPED_READERS", "typed_child", "DELEGATE_TYPED_PERMISSION_MATCH"],
]);

function binding(overrides = {}) {
  return createRuntimeBinding({
    gitHead: "a".repeat(40),
    gitStatus: "",
    codexVersion: "codex-cli 1.2.3",
    configSha256: "b".repeat(64),
    roleHashes: { luna_clerk: "c".repeat(64), terra_worker: "d".repeat(64) },
    runtimeHashes: { "lib/acceptance-exam.mjs": "e".repeat(64) },
    ...overrides,
  });
}

function question(scenario, overrides = {}) {
  const result = {
    id: scenario.id,
    selectedShape: scenario.selectedShape,
    reasonCode: scenario.reasonCode,
    pass: true,
    runtime: { persisted: true, model: "gpt-5.6-sol", effort: "ultra", tokenUsage: { total_tokens: 1 } },
    cleanup: { pass: true },
    ...overrides,
  };
  if (scenario.negative) Object.assign(result, { rejected: true, violationDetected: true });
  if (scenario.parallel) {
    result.topology = {
      parent: { model: "gpt-5.6-sol", effort: "ultra", runtimePersisted: true, tokenUsage: { total_tokens: 3 } },
      children: [
        { role: "luna_clerk", depth: 1, sandbox: "read-only", writer: false, descendants: 0, readScope: "fixtures/a", runtimePersisted: true, tokenUsage: { total_tokens: 1 } },
        { role: "terra_explorer", depth: 1, sandbox: "read-only", writer: false, descendants: 0, readScope: "fixtures/b", runtimePersisted: true, tokenUsage: { total_tokens: 1 } },
      ],
      writerCount: 0,
      descendantCount: 0,
    };
  }
  return result;
}

function executors(overrides = {}) {
  return {
    executeRoot: async (scenario) => question(scenario),
    executeIsolated: async (scenario) => question(scenario),
    executeTyped: async (scenario) => question(scenario),
    executeParallel: async (scenario) => question(scenario),
    ...overrides,
  };
}

test("acceptance scenarios are the exact ordered ten-question contract", () => {
  assert.equal(ACCEPTANCE_SCENARIOS.length, 10);
  assert.deepEqual(
    ACCEPTANCE_SCENARIOS.map(({ id, selectedShape, reasonCode }) => [id, selectedShape, reasonCode]),
    EXPECTED,
  );
});

test("acceptance exam requires all ten current, persisted, cleaned results", async () => {
  const currentBinding = binding();
  const report = await runAcceptanceExam({
    policy: { allowTypedBridge: false },
    roleSmoke: { pass: true, roles: [{ role: "terra_worker", pass: true }] },
    runtimeBinding: currentBinding,
    readGlobalConfig: async () => "config",
    ...executors(),
  });
  assert.equal(report.pass, true);
  assert.equal(report.activationEligible, true);
  assert.equal(report.questions.length, 10);
  assert.equal(report.runtimeBindingAfterSha256, currentBinding.sha256);
  assert.equal(report.runtimeBindingStable, true);
  assert.equal(report.globalConfigUnchanged, true);
});

test("acceptance exam fails closed for a skipped question, missing metadata, stale binding, or cleanup failure", async () => {
  const currentBinding = binding();
  const cases = [
    executors({ executeRoot: async (scenario) => scenario.id === "Q1_ROOT_TRIVIAL" ? question(scenario, { pass: false }) : question(scenario) }),
    executors({ executeIsolated: async (scenario) => question(scenario, { runtime: null }) }),
    executors({ executeParallel: async (scenario) => question(scenario, { cleanup: { pass: false } }) }),
  ];
  for (const execute of cases) {
    const report = await runAcceptanceExam({
      policy: { allowTypedBridge: false },
      roleSmoke: { pass: true, roles: [{ role: "terra_worker", pass: true }] },
      runtimeBinding: currentBinding,
      readGlobalConfig: async () => "config",
      ...execute,
    });
    assert.equal(report.pass, false);
    assert.equal(report.activationEligible, false);
  }
  const stale = await runAcceptanceExam({
    policy: { allowTypedBridge: false },
    roleSmoke: { pass: true, roles: [{ role: "terra_worker", pass: true }] },
    runtimeBinding: currentBinding,
    collectRuntimeBinding: async () => binding({ gitHead: "f".repeat(40) }),
    readGlobalConfig: async () => "config",
    ...executors(),
  });
  assert.equal(stale.pass, false);
  assert.equal(stale.runtimeBindingStable, false);
});

test("negative questions pass only after the injected violation is detected, rejected, and cleaned", async () => {
  const currentBinding = binding();
  const report = await runAcceptanceExam({
    policy: { allowTypedBridge: false },
    roleSmoke: { pass: true, roles: [{ role: "terra_worker", pass: true }] },
    runtimeBinding: currentBinding,
    readGlobalConfig: async () => "config",
    ...executors({
      executeRoot: async (scenario) => {
        if (scenario.id === "Q8_RUNTIME_MISMATCH_REJECTED") {
          return question(scenario, { rejected: true, violationDetected: true, cleanup: { pass: true } });
        }
        if (scenario.id === "Q9_WRITE_VIOLATION_REJECTED") {
          return question(scenario, { rejected: true, violationDetected: true, cleanup: { pass: true } });
        }
        return question(scenario);
      },
    }),
  });
  assert.equal(report.pass, true);

  const unsafe = await runAcceptanceExam({
    policy: { allowTypedBridge: false },
    roleSmoke: { pass: true, roles: [{ role: "terra_worker", pass: true }] },
    runtimeBinding: currentBinding,
    readGlobalConfig: async () => "config",
    ...executors({
      executeRoot: async (scenario) =>
        scenario.id === "Q8_RUNTIME_MISMATCH_REJECTED"
          ? { ...question(scenario), rejected: false, violationDetected: true }
          : question(scenario),
    }),
  });
  assert.equal(unsafe.pass, false);
});
