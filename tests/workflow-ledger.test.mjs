import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { reduceWorkflowEvent, workflowStateSummary } from "../lib/workflow-state.mjs";
import {
  appendWorkflowRecord,
  createWorkflowRecord,
  replayWorkflowRecords,
  selectWorkflowStore,
  validateWorkflowRecordSequence,
  validateWorkflowRecord,
} from "../lib/workflow-ledger.mjs";
import { readPrivateJsonl } from "../lib/private-jsonl.mjs";
import { initializedWorkflow } from "./helpers/workflow-fixtures.mjs";

let tick = 0;
function event(type, fields = {}) {
  tick += 1;
  return {
    schemaVersion: 1,
    type,
    at: `2026-07-15T01:00:${String(tick).padStart(2, "0")}.000Z`,
    ...fields,
  };
}

function recordSequence() {
  const { plan, state: initial } = initializedWorkflow();
  const initialization = createWorkflowRecord({ previousRecordHash: null, state: initial, event: null });
  const readyEvent = event("stage_ready", { stageId: "audit-core" });
  const ready = reduceWorkflowEvent({ plan, state: initial, event: readyEvent });
  const readyRecord = createWorkflowRecord({ previousRecordHash: initialization.recordHash, state: ready, event: readyEvent });
  const approvalEvent = event("approval_recorded", {
    authority: "owner",
    factId: "workflow-approved",
    scopeHash: initial.planHash,
    recordedAt: "2026-07-15T01:00:00.000Z",
  });
  const approved = reduceWorkflowEvent({ plan, state: ready, event: approvalEvent });
  const approvalRecord = createWorkflowRecord({ previousRecordHash: readyRecord.recordHash, state: approved, event: approvalEvent });
  return { plan, initial, approved, records: [initialization, readyRecord, approvalRecord] };
}

test("workflow records form an exact hash chain and replay deterministic state", () => {
  const { plan, approved, records } = recordSequence();
  assert.deepEqual(records.map((record) => validateWorkflowRecord(record).pass), [true, true, true]);
  assert.equal(records[0].previousRecordHash, null);
  assert.equal(records[1].previousRecordHash, records[0].recordHash);
  assert.equal(records[2].previousRecordHash, records[1].recordHash);
  assert.equal(validateWorkflowRecordSequence(records).pass, true);
  const replayed = replayWorkflowRecords({ plan, records });
  assert.deepEqual(workflowStateSummary(replayed), workflowStateSummary(approved));
});

test("workflow-level batch records persist without inventing a stage identity", () => {
  const { plan, state: initial } = initializedWorkflow();
  const initialization = createWorkflowRecord({ previousRecordHash: null, state: initial, event: null });
  const readyEvent = event("stage_ready", { stageId: "audit-core" });
  const ready = reduceWorkflowEvent({ plan, state: initial, event: readyEvent });
  const readyRecord = createWorkflowRecord({
    previousRecordHash: initialization.recordHash,
    state: ready,
    event: readyEvent,
  });
  const batchEvent = event("batch_planned", {
    batchId: "batch-ledger",
    stageIds: ["audit-core"],
    canaryStageId: "audit-core",
  });
  const batched = reduceWorkflowEvent({ plan, state: ready, event: batchEvent });
  const batchRecord = createWorkflowRecord({
    previousRecordHash: readyRecord.recordHash,
    state: batched,
    event: batchEvent,
  });
  assert.equal(batchRecord.stageId, null);
  assert.equal(validateWorkflowRecord(batchRecord).pass, true);
  assert.deepEqual(
    workflowStateSummary(replayWorkflowRecords({ plan, records: [initialization, readyRecord, batchRecord] })),
    workflowStateSummary(batched),
  );
});

test("workflow replay rejects duplicate initialization, broken chains, reordering, and event-state mismatch", () => {
  const { plan, initial, records } = recordSequence();
  assert.throws(() => replayWorkflowRecords({ plan, records: [records[0], records[0]] }), TypeError);
  const wrongPrevious = createWorkflowRecord({
    previousRecordHash: "f".repeat(64),
    state: reduceWorkflowEvent({ plan, state: initial, event: records[1].eventData }),
    event: records[1].eventData,
  });
  assert.throws(() => replayWorkflowRecords({ plan, records: [records[0], wrongPrevious] }), TypeError);
  assert.throws(() => replayWorkflowRecords({ plan, records: [records[0], records[2], records[1]] }), TypeError);

  const mismatchedEvent = {
    ...event("stage_ready", { stageId: "audit-cli" }),
    at: records[1].eventData.at,
  };
  const mismatched = createWorkflowRecord({
    previousRecordHash: records[0].recordHash,
    state: reduceWorkflowEvent({ plan, state: initial, event: records[1].eventData }),
    event: mismatchedEvent,
  });
  assert.throws(() => replayWorkflowRecords({ plan, records: [records[0], mismatched] }), TypeError);
});

test("workflow record validation rejects private fields and private home paths", () => {
  const { records } = recordSequence();
  const forbidden = [
    "prompt", "message", "goal", "sessionId", "threadId", "executionId",
    "path", "cwd", "auth", "secret", "token", "stdout", "stderr",
  ];
  for (const field of forbidden) {
    assert.equal(validateWorkflowRecord({ ...records[1], [field]: "private" }).pass, false, field);
  }
  assert.equal(validateWorkflowRecord({ ...records[1], role: "/Users/private-owner/project" }).pass, false);
  const cyclic = { ...records[1], eventData: { ...records[1].eventData } };
  cyclic.eventData.self = cyclic.eventData;
  assert.equal(validateWorkflowRecord(cyclic).pass, false);
});

test("managed workflow store appends private validated records", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-ledger-"));
  const path = join(root, "reports", "workflow-ledger.jsonl");
  const store = selectWorkflowStore({ managedPath: path });
  const { records } = recordSequence();
  for (const record of records) appendWorkflowRecord(store, record);
  const replayed = readPrivateJsonl(path, { defaultPath: path, validate: validateWorkflowRecord });
  assert.equal(replayed.length, records.length);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("workflow append rejects a broken hash link before it reaches managed storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-chain-"));
  const path = join(root, "reports", "workflow-ledger.jsonl");
  const store = selectWorkflowStore({ managedPath: path });
  const { plan, initial, records } = recordSequence();
  appendWorkflowRecord(store, records[0]);
  const broken = createWorkflowRecord({
    previousRecordHash: "f".repeat(64),
    state: reduceWorkflowEvent({ plan, state: initial, event: records[1].eventData }),
    event: records[1].eventData,
  });
  assert.throws(() => appendWorkflowRecord(store, broken), /hash chain/);
  const stored = readPrivateJsonl(path, { defaultPath: path, validate: validateWorkflowRecord });
  assert.equal(stored.length, 1);
});

test("upstream store is the sole source of truth and incompatible upstream blocks", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-upstream-"));
  const fallback = join(root, "reports", "workflow-ledger.jsonl");
  const received = [];
  const compatible = {
    supports: () => true,
    load: () => received,
    append: (record) => received.push(record),
  };
  const upstream = selectWorkflowStore({ upstream: compatible, managedPath: fallback });
  assert.equal(upstream.kind, "upstream");
  const { records } = recordSequence();
  appendWorkflowRecord(upstream, records[0]);
  assert.equal(received.length, 1);
  await assert.rejects(stat(fallback), { code: "ENOENT" });

  const blocked = selectWorkflowStore({ upstream: { supports: () => false }, managedPath: fallback });
  assert.deepEqual(blocked, { kind: "blocked", reasonCode: "WORKFLOW_UPSTREAM_STORE_INCOMPATIBLE" });
  assert.throws(() => appendWorkflowRecord(blocked, records[0]), /incompatible/);
  await assert.rejects(stat(fallback), { code: "ENOENT" });
});
