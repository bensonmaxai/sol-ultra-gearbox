import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createDispatchPolicy } from "../lib/dispatch-policy.mjs";
import { hashWorkflowPlan } from "../lib/workflow-plan.mjs";
import { createWorkflowBinding, resumeWorkflow } from "../lib/workflow-recovery.mjs";
import { createWorkflowRecord } from "../lib/workflow-ledger.mjs";
import { reduceWorkflowEvent } from "../lib/workflow-state.mjs";
import { initializedWorkflow, stage, workflowPlan } from "./helpers/workflow-fixtures.mjs";

const HASH = (letter) => letter.repeat(64);
const CAPABILITIES = Object.freeze({
  agentTypeVisible: true,
  isolatedRunnerVerified: true,
  runtimeMetadataAvailable: true,
  bridgeRuntimeVerified: false,
  permissionBypassActive: false,
});

function ledgerBuilder() {
  const { plan, state: initial } = initializedWorkflow();
  let state = initial;
  let sequence = 0;
  const records = [createWorkflowRecord({ previousRecordHash: null, state, event: null })];
  const apply = (type, fields) => {
    sequence += 1;
    const event = {
      schemaVersion: 1,
      type,
      at: `2026-07-15T02:00:${String(sequence).padStart(2, "0")}.000Z`,
      ...fields,
    };
    state = reduceWorkflowEvent({ plan, state, event });
    records.push(createWorkflowRecord({
      previousRecordHash: records.at(-1).recordHash,
      state,
      event,
    }));
    return state;
  };
  return { plan, records, apply, get state() { return state; } };
}

function adoptedWorkflowLedger() {
  const fixture = ledgerBuilder();
  fixture.apply("stage_ready", { stageId: "audit-core" });
  fixture.apply("stage_ready", { stageId: "audit-cli" });
  fixture.apply("batch_planned", {
    batchId: "batch-resume",
    stageIds: ["audit-core", "audit-cli"],
    canaryStageId: "audit-core",
  });
  fixture.apply("materialization_started", {
    stageId: "audit-core",
    batchId: "batch-resume",
    executionShape: "typed_child",
    role: "terra_explorer",
    taskHash: HASH("a"),
    attemptClass: "work",
  });
  fixture.apply("materialized", {
    stageId: "audit-core",
    batchId: "batch-resume",
    executionId: "ephemeral-agent",
    canonicalTaskName: "/root/audit_core",
    status: "running",
  });
  fixture.apply("evidence_ready", {
    stageId: "audit-core",
    resultHash: HASH("b"),
    artifacts: [{ id: "core-evidence", sha256: HASH("c") }],
    actualModel: "gpt-5.6-terra",
    actualEffort: "medium",
    tokens: 120,
    reasonCode: "DELEGATE_TYPED_PERMISSION_MATCH",
  });
  fixture.apply("verified", { stageId: "audit-core", checkHash: HASH("d") });
  fixture.apply("adopted", {
    stageId: "audit-core",
    rootVerification: { pass: true, checkHash: HASH("e") },
  });
  fixture.apply("provider_closed", {
    stageId: "audit-core",
    disposition: "adopted",
    cleanupPassed: true,
  });
  return {
    ...fixture,
    binding: {
      planHash: fixture.state.planHash,
      policyMode: fixture.state.policyMode,
      policyHash: fixture.state.policyHash,
      permissionHash: fixture.state.permissionHash,
      workspaceHash: fixture.state.workspaceHash,
    },
  };
}

test("resume preserves adopted work and returns only remaining stages", () => {
  const fixture = adoptedWorkflowLedger();
  const resumed = resumeWorkflow({
    plan: fixture.plan,
    records: fixture.records,
    binding: fixture.binding,
    currentArtifactHashes: { "core-evidence": HASH("c") },
  });
  assert.equal(resumed.pass, true);
  assert.equal(resumed.state.stages["audit-core"].state, "closed");
  assert.deepEqual(resumed.remainingStageIds, ["audit-cli", "verify-evidence"]);
  assert.deepEqual(resumed.rerunStageIds, []);
});

test("resume blocks every binding and artifact drift independently", () => {
  const fixture = adoptedWorkflowLedger();
  for (const [key, reasonCode] of [
    ["planHash", "WORKFLOW_PLAN_HASH_MISMATCH"],
    ["policyHash", "WORKFLOW_POLICY_DRIFT"],
    ["permissionHash", "WORKFLOW_PERMISSION_DRIFT"],
    ["workspaceHash", "WORKFLOW_WORKSPACE_DRIFT"],
  ]) {
    assert.equal(resumeWorkflow({
      plan: fixture.plan,
      records: fixture.records,
      binding: { ...fixture.binding, [key]: HASH("f") },
      currentArtifactHashes: { "core-evidence": HASH("c") },
    }).reasonCode, reasonCode);
  }
  assert.equal(resumeWorkflow({
    plan: fixture.plan,
    records: fixture.records,
    binding: { ...fixture.binding, policyMode: "shadow" },
    currentArtifactHashes: { "core-evidence": HASH("c") },
  }).reasonCode, "WORKFLOW_POLICY_DRIFT");
  assert.equal(resumeWorkflow({
    plan: fixture.plan,
    records: fixture.records,
    binding: fixture.binding,
    currentArtifactHashes: { "core-evidence": HASH("0") },
  }).reasonCode, "WORKFLOW_ARTIFACT_DRIFT");
  assert.equal(resumeWorkflow({
    plan: fixture.plan,
    records: fixture.records,
    binding: fixture.binding,
    currentArtifactHashes: {},
  }).reasonCode, "WORKFLOW_ARTIFACT_DRIFT");
});

test("resume rejects invalid ledgers before drift and never reruns incomplete execution", () => {
  const adopted = adoptedWorkflowLedger();
  const malformed = [...adopted.records, "{broken"];
  assert.equal(resumeWorkflow({
    plan: adopted.plan,
    records: malformed,
    binding: { ...adopted.binding, policyHash: HASH("f") },
    currentArtifactHashes: { "core-evidence": HASH("c") },
  }).reasonCode, "WORKFLOW_LEDGER_INVALID");

  const lastIndex = adopted.records.length - 1;
  for (const changed of [
    { ...adopted.records[lastIndex], previousRecordHash: HASH("f") },
    { ...adopted.records[lastIndex], stateHash: HASH("f") },
    {
      ...adopted.records[lastIndex],
      eventType: "unknown_event",
      eventData: { ...adopted.records[lastIndex].eventData, type: "unknown_event" },
    },
  ]) {
    const records = [...adopted.records.slice(0, -1), changed];
    assert.equal(resumeWorkflow({
      plan: adopted.plan,
      records,
      binding: adopted.binding,
      currentArtifactHashes: { "core-evidence": HASH("c") },
    }).reasonCode, "WORKFLOW_LEDGER_INVALID");
  }

  for (const terminal of ["materializing", "running", "evidence_ready", "verified"]) {
    const fixture = ledgerBuilder();
    fixture.apply("stage_ready", { stageId: "audit-core" });
    fixture.apply("batch_planned", {
      batchId: `batch-${terminal}`,
      stageIds: ["audit-core"],
      canaryStageId: "audit-core",
    });
    fixture.apply("materialization_started", {
      stageId: "audit-core",
      batchId: `batch-${terminal}`,
      executionShape: "root_inline",
      role: null,
      taskHash: HASH("a"),
      attemptClass: "work",
    });
    if (terminal !== "materializing") fixture.apply("materialized", {
      stageId: "audit-core",
      batchId: `batch-${terminal}`,
      status: "completed",
    });
    if (["evidence_ready", "verified"].includes(terminal)) fixture.apply("evidence_ready", {
      stageId: "audit-core",
      resultHash: HASH("b"),
      artifacts: [{ id: "core-evidence", sha256: HASH("c") }],
      actualModel: "gpt-5.6-sol",
      actualEffort: "max",
      tokens: 80,
      reasonCode: "ROOT_INLINE_EXECUTION",
    });
    if (terminal === "verified") fixture.apply("verified", { stageId: "audit-core", checkHash: HASH("d") });
    assert.equal(fixture.state.stages["audit-core"].state, terminal);
    const binding = {
      planHash: fixture.state.planHash,
      policyMode: fixture.state.policyMode,
      policyHash: fixture.state.policyHash,
      permissionHash: fixture.state.permissionHash,
      workspaceHash: fixture.state.workspaceHash,
    };
    assert.equal(resumeWorkflow({
      plan: fixture.plan,
      records: fixture.records,
      binding,
      currentArtifactHashes: {},
    }).reasonCode, "WORKFLOW_INCOMPLETE_EXECUTION");
  }
});

test("planned and ready stages resume without adding or duplicating records", () => {
  for (const ready of [false, true]) {
    const fixture = ledgerBuilder();
    if (ready) fixture.apply("stage_ready", { stageId: "audit-core" });
    const before = structuredClone(fixture.records);
    const binding = {
      planHash: fixture.state.planHash,
      policyMode: fixture.state.policyMode,
      policyHash: fixture.state.policyHash,
      permissionHash: fixture.state.permissionHash,
      workspaceHash: fixture.state.workspaceHash,
    };
    const resumed = resumeWorkflow({ plan: fixture.plan, records: fixture.records, binding, currentArtifactHashes: {} });
    assert.equal(resumed.pass, true);
    assert.deepEqual(fixture.records, before);
    assert.deepEqual(resumed.rerunStageIds, []);
  }
});

test("workflow binding hashes exact policy, permissions, and a safe workspace snapshot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "workflow-binding-"));
  for (const directory of ["lib", "scripts", "tests"]) await mkdir(join(cwd, directory));
  await writeFile(join(cwd, "lib", "core.mjs"), "export const value = 1;\n");
  await writeFile(join(cwd, "scripts", "cli.mjs"), "export {};\n");
  await writeFile(join(cwd, "tests", "core.test.mjs"), "export {};\n");
  const plan = workflowPlan();
  const policy = createDispatchPolicy({ mode: "shadow", allowTypedBridge: false, activation: null });
  const first = createWorkflowBinding({ plan, policy, capabilities: CAPABILITIES, cwd });
  const second = createWorkflowBinding({ plan, policy, capabilities: CAPABILITIES, cwd });
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first), ["planHash", "policyMode", "policyHash", "permissionHash", "workspaceHash"]);
  assert.equal(first.planHash, hashWorkflowPlan(plan));

  const permissionDrift = createWorkflowBinding({
    plan,
    policy,
    capabilities: { ...CAPABILITIES, agentTypeVisible: false },
    cwd,
  });
  assert.notEqual(permissionDrift.permissionHash, first.permissionHash);
  await writeFile(join(cwd, "lib", "core.mjs"), "export const value = 2;\n");
  const workspaceDrift = createWorkflowBinding({ plan, policy, capabilities: CAPABILITIES, cwd });
  assert.notEqual(workspaceDrift.workspaceHash, first.workspaceHash);

  await symlink(join(cwd, "lib", "core.mjs"), join(cwd, "scripts", "linked.mjs"));
  assert.throws(() => createWorkflowBinding({ plan, policy, capabilities: CAPABILITIES, cwd }), /symlink/);

  const missingWritePlan = workflowPlan({
    stages: [stage({ id: "writer", readScope: ["lib"], writeScope: ["generated/out.txt"] })],
  });
  assert.doesNotThrow(() => createWorkflowBinding({ plan: missingWritePlan, policy, capabilities: CAPABILITIES, cwd }));
});
