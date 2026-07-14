import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import {
  ACCEPTANCE_PARALLEL_CHILDREN,
  ACCEPTANCE_SCENARIOS,
  attachAcceptanceMetadata,
  createAcceptancePacket,
  evaluateAcceptanceViolation,
  planAcceptanceScenario,
  runAcceptanceExam,
  validateAcceptanceDeliverable,
  validateAcceptanceEvidence,
} from "../lib/acceptance-exam.mjs";
import { REQUIRED_CHECKS } from "../lib/dispatch-evidence.mjs";
import { ROLE_SPECS, sha256 } from "../lib/gearbox.mjs";
import { createRuntimeBinding } from "../lib/runtime-evidence.mjs";
import {
  runAcceptanceIsolated,
  validateAcceptanceParallelSpawn,
} from "../scripts/gearbox.mjs";

const EXPECTED = Object.freeze([
  ["Q1_ROOT_TRIVIAL", "root_inline", "ROOT_TRIVIAL"],
  ["Q2_ISOLATED_LUNA", "isolated_role_root", "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH"],
  ["Q3_ISOLATED_TERRA_NO_NATIVE_SCHEMA", "isolated_role_root", "DELEGATE_ISOLATED_SCHEMA_UNAVAILABLE"],
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
    configSha256: sha256("config"),
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
        { role: "luna_clerk", model: "gpt-5.6-luna", effort: "low", depth: 1, sandbox: "read-only", writer: false, descendants: 0, declaredReadScope: "reader-a.txt", markerReturned: true, runtimePersisted: true, tokenUsage: { total_tokens: 1 } },
        { role: "terra_explorer", model: "gpt-5.6-terra", effort: "medium", depth: 1, sandbox: "read-only", writer: false, descendants: 0, declaredReadScope: "reader-b.txt", markerReturned: true, runtimePersisted: true, tokenUsage: { total_tokens: 1 } },
      ],
      writerCount: 0,
      descendantCount: 0,
      spawnsExact: true,
      messagesDistinct: true,
      lineageExact: true,
      filesystemUnchanged: true,
      parentMarkerReturned: true,
      workflowCanary: {
        firstRole: "luna_clerk",
        firstChildPersisted: true,
        listObservedBetweenSpawns: true,
        listReceiptRunningOrCompleted: true,
        secondRole: "terra_explorer",
        secondSpawnAfterCanary: true,
      },
    };
  }
  return result;
}

function dispatchEvidence() {
  const roleSpec = ROLE_SPECS.find((role) => role.name === "luna_clerk");
  const decision = {
    selectedShape: "isolated_role_root",
    role: roleSpec.name,
    reasonCode: "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH",
    taskHash: "a".repeat(64),
    roleHash: "b".repeat(64),
  };
  const checks = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, true]));
  const result = {
    schemaVersion: 1,
    kind: "dispatch_result",
    pass: true,
    taskHash: decision.taskHash,
    executionShape: decision.selectedShape,
    role: decision.role,
    reasonCode: decision.reasonCode,
    expected: { model: roleSpec.model, effort: roleSpec.effort, sandbox: roleSpec.sandbox, depth: 0, roleHash: decision.roleHash },
    actual: { model: roleSpec.model, effort: roleSpec.effort, sandbox: roleSpec.sandbox, depth: 0, parentTokens: 11, childTokens: null, nativeAgentRole: null },
    checks,
    changedFiles: [],
    retryCount: 0,
    rollbackRequired: false,
    synthetic: false,
  };
  return { result, decision, roleSpec };
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

test("scenario packets obtain their expected decision from the planner and reject drift", () => {
  const scenario = ACCEPTANCE_SCENARIOS[1];
  const decision = planAcceptanceScenario({
    scenario,
    policy: { mode: "active", allowTypedBridge: false },
    capabilities: { agentTypeVisible: true, isolatedRunnerVerified: true, runtimeMetadataAvailable: true, bridgeRuntimeVerified: false, permissionBypassActive: false },
    roleSpecs: ROLE_SPECS,
  });
  assert.equal(createAcceptancePacket(scenario).responsibility, "mechanical");
  assert.equal(decision.selectedShape, scenario.selectedShape);
  assert.equal(decision.reasonCode, scenario.reasonCode);
  assert.throws(() => planAcceptanceScenario({
    scenario,
    policy: { mode: "active", allowTypedBridge: false },
    capabilities: { agentTypeVisible: false, isolatedRunnerVerified: false, runtimeMetadataAvailable: true, bridgeRuntimeVerified: false, permissionBypassActive: false },
    roleSpecs: ROLE_SPECS,
  }), /acceptance scenario decision drift/);
});

test("every non-negative acceptance scenario obtains its declared planner decision", () => {
  for (const scenario of ACCEPTANCE_SCENARIOS.filter((item) => item.negative !== true)) {
    const decision = planAcceptanceScenario({
      scenario,
      policy: { mode: "active", allowTypedBridge: false },
      capabilities: { agentTypeVisible: true, isolatedRunnerVerified: true, runtimeMetadataAvailable: true, bridgeRuntimeVerified: false, permissionBypassActive: false },
      roleSpecs: ROLE_SPECS,
    });
    assert.equal(decision.selectedShape, scenario.selectedShape, scenario.id);
    assert.equal(decision.reasonCode, scenario.reasonCode, scenario.id);
  }
});

test("isolated acceptance deliverables require exact structured results", () => {
  assert.equal(validateAcceptanceDeliverable("Q2_ISOLATED_LUNA", '{"count":25}'), true);
  assert.equal(validateAcceptanceDeliverable("Q2_ISOLATED_LUNA", '{"count":"25"}'), false);
  assert.equal(validateAcceptanceDeliverable("Q2_ISOLATED_LUNA", '{"count":25,"claim":true}'), false);
  assert.equal(validateAcceptanceDeliverable("Q3_ISOLATED_TERRA_NO_NATIVE_SCHEMA", '{"filenames":["trace-0.txt","trace-1.txt","trace-2.txt","trace-3.txt","trace-4.txt"]}'), true);
  assert.equal(validateAcceptanceDeliverable("Q3_ISOLATED_TERRA_NO_NATIVE_SCHEMA", '{"filenames":["trace-4.txt","trace-3.txt","trace-2.txt","trace-1.txt","trace-0.txt"]}'), false);
  assert.equal(validateAcceptanceDeliverable("Q3_ISOLATED_TERRA_NO_NATIVE_SCHEMA", "```json\n{}\n```"), false);
});

test("parallel acceptance requires exact typed fields and a distinct non-empty task message", () => {
  const expected = ACCEPTANCE_PARALLEL_CHILDREN[0];
  const args = {
    agent_type: expected.role,
    fork_turns: "none",
    message: `Execute this exact bounded contract. ${expected.message}`,
    task_name: expected.taskName,
  };
  const valid = validateAcceptanceParallelSpawn(args, expected);
  assert.equal(valid.pass, true);
  assert.equal(valid.checks.messageExact, false);
  assert.equal(valid.checks.messagePresent, true);
  assert.equal(validateAcceptanceParallelSpawn({ ...args, message: "" }, expected).pass, false);
  assert.equal(validateAcceptanceParallelSpawn({ ...args, task_name: "wrong" }, expected).pass, false);
  assert.equal(validateAcceptanceParallelSpawn({ ...args, model: "gpt-5.6-luna" }, expected).pass, false);
});

test("production isolated executor accepts only its exact scenario deliverable", async () => {
  for (const [scenario, deliverable] of [
    [ACCEPTANCE_SCENARIOS[1], '{"count":25}'],
    [ACCEPTANCE_SCENARIOS[2], '{"filenames":["trace-0.txt","trace-1.txt","trace-2.txt","trace-3.txt","trace-4.txt"]}'],
  ]) {
    const decision = planAcceptanceScenario({
      scenario,
      policy: { mode: "active", allowTypedBridge: false },
      capabilities: { agentTypeVisible: true, isolatedRunnerVerified: true, runtimeMetadataAvailable: true, bridgeRuntimeVerified: false, permissionBypassActive: false },
      roleSpecs: ROLE_SPECS,
    });
    const executeIsolatedRole = async ({ roleSpec, roleSource, cwd, taskHash, onDeliverable }) => {
      assert.deepEqual(
        await readdir(cwd),
        scenario.id === "Q2_ISOLATED_LUNA"
          ? ["records.txt"]
          : ["trace-0.txt", "trace-1.txt", "trace-2.txt", "trace-3.txt", "trace-4.txt"],
      );
      const accepted = await onDeliverable(deliverable);
      const checks = Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, true]));
      checks.deliverableValid = accepted;
      return {
        schemaVersion: 1,
        kind: "dispatch_result",
        pass: accepted,
        taskHash,
        executionShape: "isolated_role_root",
        role: roleSpec.name,
        reasonCode: decision.reasonCode,
        expected: { model: roleSpec.model, effort: roleSpec.effort, sandbox: roleSpec.sandbox, depth: 0, roleHash: sha256(roleSource) },
        actual: { model: roleSpec.model, effort: roleSpec.effort, sandbox: roleSpec.sandbox, depth: 0, parentTokens: 7, childTokens: null, nativeAgentRole: null },
        checks,
        changedFiles: [],
        retryCount: 0,
        rollbackRequired: false,
        synthetic: false,
      };
    };
    const accepted = await runAcceptanceIsolated(scenario, { decision, executeIsolatedRole });
    assert.equal(accepted.pass, true);
    assert.equal(accepted.cleanup.pass, true);
    assert.equal(accepted.dispatchEvidence.result.checks.deliverableValid, true);

    const rejected = await runAcceptanceIsolated(scenario, {
      decision,
      executeIsolatedRole: (options) => executeIsolatedRole({ ...options, onDeliverable: () => options.onDeliverable('{"wrong":true}') }),
    });
    assert.equal(rejected.pass, false);
    assert.equal(rejected.cleanup.pass, true);
  }
});

test("negative acceptance uses the real dispatch validator and classifier", () => {
  const evidence = dispatchEvidence();
  const runtime = evaluateAcceptanceViolation({ ...evidence, violation: "runtime_mismatch" });
  assert.deepEqual(
    { pass: runtime.pass, rejected: runtime.rejected, violationDetected: runtime.violationDetected, reasonCode: runtime.reasonCode },
    { pass: true, rejected: true, violationDetected: true, reasonCode: "ROOT_RUNTIME_EVIDENCE_FAILED" },
  );
  const filesystem = evaluateAcceptanceViolation({ ...evidence, violation: "filesystem_write" });
  assert.deepEqual(
    { pass: filesystem.pass, rejected: filesystem.rejected, violationDetected: filesystem.violationDetected, reasonCode: filesystem.reasonCode },
    { pass: true, rejected: true, violationDetected: true, reasonCode: "ROOT_PERMISSION_VIOLATION" },
  );
  const invalidBase = structuredClone(evidence);
  invalidBase.result.actual.model = "gpt-5.6-invalid";
  assert.equal(evaluateAcceptanceViolation({ ...invalidBase, violation: "runtime_mismatch" }).pass, false);
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
  assert.equal(validateAcceptanceEvidence(report).pass, true);
  const decorated = attachAcceptanceMetadata(report, {
    reportDirectory: "/private/reports/current",
    reuse: { mode: "trusted_recent_acceptance" },
  });
  assert.equal(decorated.reportDirectory, "/private/reports/current");
  assert.equal(decorated.reuse.mode, "trusted_recent_acceptance");
  assert.equal(validateAcceptanceEvidence(decorated).pass, true);
  assert.equal(Object.keys(decorated).includes("reportDirectory"), false);
  assert.equal(Object.keys(decorated).includes("reuse"), false);
  assert.equal(validateAcceptanceEvidence({ ...report, rawPrompt: "must not escape" }).pass, false);
  const wrongConfigBinding = structuredClone(report);
  wrongConfigBinding.runtimeBinding.configSha256 = "f".repeat(64);
  assert.equal(validateAcceptanceEvidence(wrongConfigBinding).checks.configBinding, false);
  const leakedQuestion = structuredClone(report);
  leakedQuestion.questions[0].rawResult = { secret: true };
  assert.equal(validateAcceptanceEvidence(leakedQuestion).pass, false);
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

test("parallel acceptance rejects child runtime drift, inferred writers, or weak lineage", async () => {
  const currentBinding = binding();
  for (const mutate of [
    (topology) => { topology.children[0].model = "gpt-5.6-sol"; },
    (topology) => { topology.children[1].writer = true; topology.writerCount = 1; },
    (topology) => { topology.lineageExact = false; },
    (topology) => { topology.messagesDistinct = false; },
    (topology) => { topology.filesystemUnchanged = false; },
  ]) {
    const report = await runAcceptanceExam({
      policy: { allowTypedBridge: false },
      roleSmoke: { pass: true, roles: [{ role: "terra_worker", pass: true }] },
      runtimeBinding: currentBinding,
      readGlobalConfig: async () => "config",
      ...executors({
        executeParallel: async (scenario) => {
          const result = question(scenario);
          mutate(result.topology);
          return result;
        },
      }),
    });
    assert.equal(report.pass, false);
  }
});

test("parallel acceptance rejects every Q10 canary topology mutation", async () => {
  const currentBinding = binding();
  const mutations = [
    (topology) => { topology.workflowCanary.firstRole = "terra_explorer"; },
    (topology) => { topology.workflowCanary.listObservedBetweenSpawns = false; },
    (topology) => { topology.workflowCanary.listObservedBetweenSpawns = false; },
    (topology) => { topology.workflowCanary.listReceiptRunningOrCompleted = false; },
    (topology) => { topology.workflowCanary.firstChildPersisted = false; },
    (topology) => { topology.workflowCanary.secondSpawnAfterCanary = false; },
    (topology) => { topology.spawnsExact = false; },
    (topology) => { topology.messagesDistinct = false; },
    (topology) => { topology.children[0].model = "gpt-5.6-sol"; },
    (topology) => { topology.children[0].effort = "high"; },
    (topology) => { topology.children[0].sandbox = "workspace-write"; },
    (topology) => { topology.lineageExact = false; },
    (topology) => { topology.writerCount = 1; },
    (topology) => { topology.descendantCount = 1; },
    (topology) => { topology.filesystemUnchanged = false; },
  ];
  for (const mutate of mutations) {
    const report = await runAcceptanceExam({
      policy: { allowTypedBridge: false },
      roleSmoke: { pass: true, roles: [{ role: "terra_worker", pass: true }] },
      runtimeBinding: currentBinding,
      readGlobalConfig: async () => "config",
      ...executors({
        executeParallel: async (scenario) => {
          const result = question(scenario);
          mutate(result.topology);
          return result;
        },
      }),
    });
    assert.equal(report.pass, false);
  }
  const cleanupDrift = await runAcceptanceExam({
    policy: { allowTypedBridge: false },
    roleSmoke: { pass: true, roles: [{ role: "terra_worker", pass: true }] },
    runtimeBinding: currentBinding,
    readGlobalConfig: async () => "config",
    ...executors({ executeParallel: async (scenario) => question(scenario, { cleanup: { pass: false } }) }),
  });
  assert.equal(cleanupDrift.pass, false);
});

test("Q10 publishes only the workflow canary boolean", async () => {
  const report = await runAcceptanceExam({
    policy: { allowTypedBridge: false },
    roleSmoke: { pass: true, roles: [{ role: "terra_worker", pass: true }] },
    runtimeBinding: binding(),
    readGlobalConfig: async () => "config",
    ...executors(),
  });
  assert.deepEqual(Object.keys(report.questions[9]).sort(), ["cleanup", "id", "pass", "reasonCode", "runtime", "selectedShape", "workflowCanary"]);
  assert.equal(report.questions[9].workflowCanary, true);
  assert.equal(JSON.stringify(report.questions[9]).includes("firstChildPersisted"), false);
});
