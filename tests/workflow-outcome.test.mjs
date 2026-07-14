import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  appendWorkflowOutcome,
  createWorkflowOutcomeRecord,
  validateWorkflowOutcomeRecord,
} from "../lib/workflow-outcome.mjs";
import { readPrivateJsonl } from "../lib/private-jsonl.mjs";
import { reduceWorkflowEvent } from "../lib/workflow-state.mjs";
import { initializedWorkflow } from "./helpers/workflow-fixtures.mjs";

const HASH = (letter) => letter.repeat(64);

function adoptedState() {
  const { plan, state: initial } = initializedWorkflow();
  let state = initial;
  let tick = 0;
  const apply = (type, fields) => {
    tick += 1;
    state = reduceWorkflowEvent({
      plan,
      state,
      event: { schemaVersion: 1, type, at: `2026-07-15T03:00:${String(tick).padStart(2, "0")}.000Z`, ...fields },
    });
  };
  apply("stage_ready", { stageId: "audit-core" });
  apply("batch_planned", { batchId: "batch-outcome", stageIds: ["audit-core"], canaryStageId: "audit-core" });
  apply("materialization_started", {
    stageId: "audit-core", batchId: "batch-outcome", executionShape: "typed_child",
    role: "terra_explorer", taskHash: HASH("a"), attemptClass: "work",
  });
  apply("materialized", {
    stageId: "audit-core", batchId: "batch-outcome", executionId: "ephemeral-agent",
    canonicalTaskName: "/root/outcome", status: "running",
  });
  apply("evidence_ready", {
    stageId: "audit-core", resultHash: HASH("b"), artifacts: [{ id: "core-evidence", sha256: HASH("c") }],
    actualModel: "gpt-5.6-terra", actualEffort: "medium", tokens: 120,
    reasonCode: "DELEGATE_TYPED_PERMISSION_MATCH",
  });
  apply("verified", { stageId: "audit-core", checkHash: HASH("d") });
  apply("adopted", { stageId: "audit-core", rootVerification: { pass: true, checkHash: HASH("e") } });
  apply("provider_closed", { stageId: "audit-core", disposition: "adopted", cleanupPassed: true });
  return { plan, state };
}

test("workflow outcome derives exact privacy-safe attempt evidence", () => {
  const { plan, state } = adoptedState();
  const record = createWorkflowOutcomeRecord({
    plan,
    state,
    stageId: "audit-core",
    generatedAt: "2026-07-15T03:30:00.000Z",
  });
  assert.equal(validateWorkflowOutcomeRecord(record).pass, true);
  assert.equal(record.materialized, true);
  assert.equal(record.verified, true);
  assert.equal(record.adopted, true);
  assert.equal(record.closed, true);
  assert.equal(record.rootReworkRequired, false);
  assert.equal(record.retryCount, 0);
  assert.equal(record.escalatedToRoot, false);
  assert.equal(record.tokens, 120);
  assert.equal(Object.hasOwn(record, "workflowId"), false);
  assert.equal(Object.hasOwn(record, "stageId"), false);
  const serialized = JSON.stringify(record);
  for (const privateName of ["verified-audit", "audit-core", "executionId", "ephemeral-agent", "/root/outcome"]) {
    assert.equal(serialized.includes(privateName), false, privateName);
  }
});

test("workflow outcome derives inline remediation and one retry only from state", () => {
  const { plan, state } = adoptedState();
  const remediated = structuredClone(state);
  const stage = remediated.stages["audit-core"];
  const attempt = stage.attempts[0];
  stage.correctionUsed = true;
  stage.attemptNumber = 2;
  attempt.attemptNumber = 2;
  attempt.executionShape = "root_inline";
  const record = createWorkflowOutcomeRecord({
    plan,
    state: remediated,
    stageId: "audit-core",
    generatedAt: "2026-07-15T03:30:00.000Z",
  });
  assert.equal(record.rootReworkRequired, true);
  assert.equal(record.retryCount, 1);
  assert.equal(record.escalatedToRoot, true);
});

test("workflow outcome refuses state that is not bound to the supplied plan", () => {
  const { plan, state } = adoptedState();
  assert.throws(() => createWorkflowOutcomeRecord({
    plan: { ...plan, workflowId: "different-workflow" },
    state,
    stageId: "audit-core",
    generatedAt: "2026-07-15T03:30:00.000Z",
  }), /not bound/);
});

test("workflow outcome validator rejects extras, unsafe counts, codes, and nested private paths", () => {
  const { plan, state } = adoptedState();
  const record = createWorkflowOutcomeRecord({
    plan,
    state,
    stageId: "audit-core",
    generatedAt: "2026-07-15T03:30:00.000Z",
  });
  for (const changed of [
    { ...record, prompt: "private" },
    { ...record, tokens: -1 },
    { ...record, retryCount: 2 },
    { ...record, reasonCode: "unsafe code" },
    { ...record, reservedAttemptsBefore: { verification: "/Users/private-owner", recovery: 1 } },
  ]) {
    assert.equal(validateWorkflowOutcomeRecord(changed).pass, false);
  }
});

test("workflow outcomes use a separate private managed file or one explicit upstream sink", async () => {
  const { plan, state } = adoptedState();
  const record = createWorkflowOutcomeRecord({
    plan,
    state,
    stageId: "audit-core",
    generatedAt: "2026-07-15T03:30:00.000Z",
  });
  const root = await mkdtemp(join(tmpdir(), "workflow-outcome-"));
  const path = join(root, "reports", "workflow-outcomes.jsonl");
  appendWorkflowOutcome(path, record);
  const records = readPrivateJsonl(path, { defaultPath: path, validate: validateWorkflowOutcomeRecord });
  assert.deepEqual(records, [record]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const received = [];
  appendWorkflowOutcome({ appendOutcome: (value) => received.push(value) }, record);
  assert.deepEqual(received, [record]);
});
