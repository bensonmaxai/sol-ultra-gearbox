import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDispatchPolicy } from "../lib/dispatch-policy.mjs";
import { ROLE_SPECS } from "../lib/gearbox.mjs";
import { runWorkflowNext, validateWorkflowEnvelope } from "../lib/workflow-cli.mjs";
import { workflowPlan } from "./helpers/workflow-fixtures.mjs";

const capabilities = {
  agentTypeVisible: true,
  isolatedRunnerVerified: true,
  runtimeMetadataAvailable: true,
  bridgeRuntimeVerified: false,
  permissionBypassActive: false,
};

function envelope(overrides = {}) {
  return {
    schemaVersion: 1,
    plan: workflowPlan(),
    binding: { currentArtifactHashes: {} },
    stateSource: { kind: "managed" },
    event: null,
    ...overrides,
  };
}

test("workflow envelope is exact and rejects an unmanaged upstream shape", () => {
  assert.equal(validateWorkflowEnvelope(envelope()).pass, true);
  assert.equal(validateWorkflowEnvelope({ ...envelope(), extra: true }).pass, false);
  assert.equal(validateWorkflowEnvelope({ ...envelope(), stateSource: { kind: "upstream", schemaFields: [], records: [] } }).pass, false);
});

test("first shadow workflow call initializes private managed state and returns a root action without raw goal", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-cli-managed-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await Promise.all([import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(join(cwd, "lib"), { recursive: true }).then(() => writeFile(join(cwd, "lib", "fixture.txt"), "fixture\n"))), import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(join(cwd, "scripts"), { recursive: true }).then(() => writeFile(join(cwd, "scripts", "fixture.txt"), "fixture\n"))), import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(join(cwd, "tests"), { recursive: true }).then(() => writeFile(join(cwd, "tests", "fixture.txt"), "fixture\n")))]);
  const result = await runWorkflowNext({
    envelope: envelope(),
    policy: createDispatchPolicy({ mode: "shadow", allowTypedBridge: false, activation: null }),
    capabilities,
    roleSpecs: ROLE_SPECS,
    cwd,
  });
  assert.equal(result.status, "GEARBOX_WORKFLOW_ACTION");
  assert.equal(result.mode, "shadow");
  assert.equal(result.source, "managed");
  assert.equal(result.action.kind, "root_inline");
  assert.equal(result.action.stageId, "audit-core");
  assert.doesNotMatch(JSON.stringify(result.public), /Audit two modules|workflow-ledger\.jsonl|\/private\//);
  const ledger = join(cwd, "reports", "workflow-ledger.jsonl");
  assert.match(await readFile(ledger, "utf8"), /workflow_initialized/);
});

test("upstream workflow state returns append arrays and never writes managed storage", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-cli-upstream-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const directory of ["lib", "scripts", "tests"]) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, directory), { recursive: true });
    await writeFile(join(cwd, directory, "fixture.txt"), "fixture\n");
  }
  const result = await runWorkflowNext({
    envelope: envelope({ stateSource: { kind: "upstream", schemaFields: ["workflowId", "planHash", "stageId", "state", "attempt", "executionShape", "role", "taskHash", "resultHash", "adopted", "updatedAt"], records: [] } }),
    policy: createDispatchPolicy({ mode: "shadow", allowTypedBridge: false, activation: null }), capabilities, roleSpecs: ROLE_SPECS, cwd,
  });
  assert.equal(result.source, "upstream");
  assert.ok(result.recordsToAppend.length >= 1);
  assert.deepEqual(result.outcomesToAppend, []);
  await assert.rejects(access(join(cwd, "reports", "workflow-ledger.jsonl")));
});

test("a fresh workflow call resumes adopted work without rematerializing it", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-cli-resume-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const directory of ["lib", "scripts", "tests"]) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, directory), { recursive: true });
    await writeFile(join(cwd, directory, "fixture.txt"), "fixture\n");
  }
  const policy = createDispatchPolicy({ mode: "shadow", allowTypedBridge: false, activation: null });
  let current = envelope();
  let result = await runWorkflowNext({ envelope: current, policy, capabilities, roleSpecs: ROLE_SPECS, cwd });
  const action = result.action;
  assert.match(action.batchId ?? "", /^[a-f0-9]{64}$/);
  const at = "2026-07-15T00:00:00.000Z";
  const events = [
    { schemaVersion: 1, type: "materialization_started", at, stageId: action.stageId, batchId: action.batchId, executionShape: "root_inline", role: null, taskHash: action.decision.taskHash, attemptClass: "work" },
    { schemaVersion: 1, type: "materialized", at, stageId: action.stageId, batchId: action.batchId, status: "running" },
    { schemaVersion: 1, type: "evidence_ready", at, stageId: action.stageId, resultHash: "b".repeat(64), artifacts: [{ id: "core-evidence", sha256: "a".repeat(64) }], actualModel: "gpt-5.6-sol", actualEffort: "ultra", tokens: 1, reasonCode: "WORKFLOW_EVIDENCE_READY" },
    { schemaVersion: 1, type: "verified", at, stageId: action.stageId, checkHash: "c".repeat(64) },
    { schemaVersion: 1, type: "adopted", at, stageId: action.stageId, rootVerification: { pass: true, checkHash: "d".repeat(64) } },
    { schemaVersion: 1, type: "provider_closed", at, stageId: action.stageId, disposition: "adopted", cleanupPassed: true },
  ];
  let releasedStageId = null;
  for (const event of events) {
    result = await runWorkflowNext({
      envelope: envelope({ binding: { currentArtifactHashes: { "core-evidence": "a".repeat(64) } }, event }),
      policy, capabilities, roleSpecs: ROLE_SPECS, cwd,
    });
    assert.notEqual(result.status, "GEARBOX_WORKFLOW_BLOCKED", `${event.type}: ${result.reasonCode}`);
    if (result.action?.stageId) releasedStageId = result.action.stageId;
  }
  assert.equal(releasedStageId, "audit-cli");
  const ledger = await readFile(join(cwd, "reports", "workflow-ledger.jsonl"), "utf8");
  assert.equal((ledger.match(/"eventType":"materialization_started"/g) ?? []).length, 1);
});

test("active typed workflow emits only the canary and rejects an unmatched receipt path", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-cli-typed-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const directory of ["lib", "scripts", "tests"]) {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cwd, directory), { recursive: true });
    await writeFile(join(cwd, directory, "fixture.txt"), "fixture\n");
  }
  const base = workflowPlan();
  const plan = {
    ...base,
    stages: base.stages.map((item) => ({ ...item, parentPermission: "read-only" })),
  };
  const policy = createDispatchPolicy({
    mode: "active", allowTypedBridge: false,
    activation: { installId: "fixture", manifestPath: "/tmp/fixture-manifest.json" },
  });
  const first = await runWorkflowNext({
    envelope: envelope({ plan }), policy, capabilities, roleSpecs: ROLE_SPECS, cwd,
  });
  assert.equal(first.action.kind, "typed_child");
  assert.equal(first.action.stageId, "audit-core");
  assert.equal(first.action.canary, true);
  assert.deepEqual(first.action.deferredStageIds, ["audit-cli"]);
  assert.deepEqual(Object.keys(first.action.spawnArgs).sort(), ["agent_type", "fork_turns", "message"]);
  const bad = await runWorkflowNext({
    envelope: envelope({ plan, event: { schemaVersion: 1, type: "materialization_started", at: "2026-07-15T00:00:00.000Z", stageId: "audit-core", batchId: first.action.batchId, executionShape: "typed_child", role: "terra_explorer", taskHash: "0".repeat(64), attemptClass: "work" } }),
    policy, capabilities, roleSpecs: ROLE_SPECS, cwd,
  });
  assert.equal(bad.status, "GEARBOX_WORKFLOW_BLOCKED");
  const started = await runWorkflowNext({
    envelope: envelope({ plan, event: { schemaVersion: 1, type: "materialization_started", at: "2026-07-15T00:00:00.000Z", stageId: "audit-core", batchId: first.action.batchId, executionShape: "typed_child", role: "terra_explorer", taskHash: first.action.decision.taskHash, attemptClass: "work" } }),
    policy, capabilities, roleSpecs: ROLE_SPECS, cwd,
  });
  assert.equal(started.action.kind, "wait");
  const missingReceipt = await runWorkflowNext({
    envelope: envelope({ plan, event: { schemaVersion: 1, type: "materialized", at: "2026-07-15T00:00:00.000Z", stageId: "audit-core", batchId: first.action.batchId, status: "running" } }),
    policy, capabilities, roleSpecs: ROLE_SPECS, cwd,
  });
  assert.equal(missingReceipt.status, "GEARBOX_WORKFLOW_BLOCKED");
  assert.equal(missingReceipt.action, undefined);
  const released = await runWorkflowNext({
    envelope: envelope({ plan, event: { schemaVersion: 1, type: "materialized", at: "2026-07-15T00:00:00.000Z", stageId: "audit-core", batchId: first.action.batchId, executionId: "agent-1", canonicalTaskName: "/root/audit-core", status: "running" } }),
    policy, capabilities, roleSpecs: ROLE_SPECS, cwd,
  });
  assert.equal(released.action.kind, "typed_child");
  assert.equal(released.action.stageId, "audit-cli");
});

test("hard rejection requires rollback only in active mode", async (t) => {
  for (const mode of ["active", "shadow"]) {
    const cwd = await mkdtemp(join(tmpdir(), `workflow-cli-hard-${mode}-`));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    for (const directory of ["lib", "scripts", "tests"]) {
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(join(cwd, directory), { recursive: true });
      await writeFile(join(cwd, directory, "fixture.txt"), "fixture\n");
    }
    const base = workflowPlan();
    const plan = mode === "active"
      ? { ...base, stages: base.stages.map((item) => ({ ...item, parentPermission: "read-only" })) }
      : base;
    const policy = createDispatchPolicy({
      mode, allowTypedBridge: false,
      activation: mode === "active" ? { installId: "fixture", manifestPath: "/tmp/fixture-manifest.json" } : null,
    });
    const first = await runWorkflowNext({ envelope: envelope({ plan }), policy, capabilities, roleSpecs: ROLE_SPECS, cwd });
    const action = first.action;
    const at = "2026-07-15T00:00:00.000Z";
    const start = {
      schemaVersion: 1, type: "materialization_started", at, stageId: action.stageId, batchId: action.batchId,
      executionShape: action.decision.effectiveShape, role: action.decision.role, taskHash: action.decision.taskHash, attemptClass: "work",
    };
    await runWorkflowNext({ envelope: envelope({ plan, event: start }), policy, capabilities, roleSpecs: ROLE_SPECS, cwd });
    const materialized = action.decision.effectiveShape === "typed_child"
      ? { schemaVersion: 1, type: "materialized", at, stageId: action.stageId, batchId: action.batchId, executionId: "agent-1", canonicalTaskName: "/root/audit-core", status: "running" }
      : { schemaVersion: 1, type: "materialized", at, stageId: action.stageId, batchId: action.batchId, status: "running" };
    await runWorkflowNext({ envelope: envelope({ plan, event: materialized }), policy, capabilities, roleSpecs: ROLE_SPECS, cwd });
    await runWorkflowNext({
      envelope: envelope({ plan, event: { schemaVersion: 1, type: "evidence_ready", at, stageId: action.stageId, resultHash: "b".repeat(64), artifacts: [{ id: "core-evidence", sha256: "a".repeat(64) }], actualModel: "gpt-5.6-sol", actualEffort: "ultra", tokens: 1, reasonCode: "WORKFLOW_EVIDENCE_READY" } }),
      policy, capabilities, roleSpecs: ROLE_SPECS, cwd,
    });
    const rejected = await runWorkflowNext({
      envelope: envelope({ plan, event: { schemaVersion: 1, type: "rejected", at, stageId: action.stageId, final: true, hardFailure: true, reasonCode: "WORKFLOW_HARD_FAILURE" } }),
      policy, capabilities, roleSpecs: ROLE_SPECS, cwd,
    });
    assert.equal(rejected.status, "GEARBOX_WORKFLOW_BLOCKED");
    assert.equal(rejected.rollbackRequired, mode === "active");
    assert.doesNotMatch(JSON.stringify(rejected), /fixture-manifest|\/tmp\//);
  }
});
