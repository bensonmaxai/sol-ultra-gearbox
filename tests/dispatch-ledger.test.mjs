import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendDispatchRecord,
  createDispatchRecord,
  validateDispatchRecord,
} from "../lib/dispatch-ledger.mjs";

const taskHash = "a".repeat(64);

function decision(overrides = {}) {
  return {
    taskHash,
    responsibility: "exploration",
    effectiveShape: "typed_child",
    role: "terra_explorer",
    reasonCode: "DELEGATE_TYPED_PERMISSION_MATCH",
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    pass: true,
    retryCount: 0,
    rollbackRequired: false,
    synthetic: false,
    actual: {
      model: "gpt-5.6-terra",
      effort: "medium",
      parentTokens: 120,
      childTokens: 80,
    },
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "dispatch_decision",
    generatedAt: "2026-07-14T00:00:00.000Z",
    taskHash,
    workflowAdapter: "direct",
    responsibility: "exploration",
    executionShape: "typed_child",
    role: "terra_explorer",
    parentPermission: "read-only",
    reasonCode: "DELEGATE_TYPED_PERMISSION_MATCH",
    accepted: true,
    retryCount: 0,
    escalatedToRoot: false,
    actualModel: "gpt-5.6-terra",
    actualEffort: "medium",
    tokens: { parent: 120, child: 80, isolatedRoot: 0 },
    rootVerificationPassed: true,
    synthetic: false,
    ...overrides,
  };
}

test("createDispatchRecord creates an accepted typed-child public record", () => {
  const value = createDispatchRecord({
    decision: decision(),
    result: result(),
    workflowAdapter: "direct",
    parentPermission: "read-only",
    rootVerification: { pass: true },
  });

  assert.equal(validateDispatchRecord(value).pass, true);
  assert.deepEqual(Object.keys(value).sort(), Object.keys(record()).sort());
  assert.deepEqual(value.tokens, { parent: 120, child: 80, isolatedRoot: 0 });
});

test("createDispatchRecord records root-inline work without child tokens", () => {
  const value = createDispatchRecord({
    decision: decision({ effectiveShape: "root_inline", role: null }),
    result: result({ actual: { model: "gpt-5.6-sol", effort: "high", parentTokens: 75, childTokens: null } }),
    workflowAdapter: "direct",
    parentPermission: "workspace-write",
    rootVerification: true,
  });

  assert.equal(value.executionShape, "root_inline");
  assert.equal(value.escalatedToRoot, true);
  assert.deepEqual(value.tokens, { parent: 75, child: 0, isolatedRoot: 0 });
  assert.equal(validateDispatchRecord(value).pass, true);
});

test("createDispatchRecord keeps rejected results, one retry, and synthetic exams auditable", () => {
  const value = createDispatchRecord({
    decision: decision({ effectiveShape: "isolated_role_root" }),
    result: result({
      pass: false,
      retryCount: 1,
      synthetic: true,
      actual: { model: "gpt-5.6-terra", effort: "medium", parentTokens: 30, childTokens: null },
    }),
    workflowAdapter: "direct",
    parentPermission: "workspace-write",
    rootVerification: { pass: true },
  });

  assert.equal(value.accepted, false);
  assert.equal(value.retryCount, 1);
  assert.equal(value.synthetic, true);
  assert.deepEqual(value.tokens, { parent: 0, child: 0, isolatedRoot: 30 });
  assert.equal(validateDispatchRecord(value).pass, true);
});

test("validateDispatchRecord rejects private fields and private home-path values", () => {
  for (const field of [
    "prompt",
    "message",
    "goal",
    "sessionId",
    "path",
    "cwd",
    "auth",
    "secret",
    "token",
    "stdout",
    "stderr",
  ]) {
    assert.equal(validateDispatchRecord({ ...record(), [field]: "private" }).pass, false, field);
  }
  assert.equal(
    validateDispatchRecord(record({ reasonCode: "ROOT_/Users/private-owner/task" })).pass,
    false,
  );
  assert.equal(
    validateDispatchRecord(record({ tokens: { parent: 120, child: "/home/private-owner", isolatedRoot: 0 } })).pass,
    false,
  );
});

test("appendDispatchRecord creates a private canonical JSONL ledger in a temporary fixture", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dispatch-ledger-"));
  const path = join(parent, "nested", "dispatch-ledger.jsonl");
  appendDispatchRecord(path, record());
  appendDispatchRecord(path, record({ retryCount: 1, accepted: false }));

  const source = await readFile(path, "utf8");
  const lines = source.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[0], JSON.stringify(JSON.parse(lines[0])));
  assert.equal(lines[0].endsWith("\n"), false);
  assert.equal((await stat(join(parent, "nested"))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("appendDispatchRecord validates before creating a ledger", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dispatch-ledger-"));
  const path = join(parent, "dispatch-ledger.jsonl");
  assert.throws(() => appendDispatchRecord(path, record({ prompt: "do not persist" })), /invalid dispatch record/);
  await assert.rejects(stat(path), { code: "ENOENT" });
});
