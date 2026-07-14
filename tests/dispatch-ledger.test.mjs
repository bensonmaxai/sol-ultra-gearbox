import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ROLE_SPECS } from "../lib/gearbox.mjs";
import {
  appendDispatchRecord,
  createDispatchRecord,
  validateDispatchRecord,
} from "../lib/dispatch-ledger.mjs";
import { planDispatch } from "../lib/dispatch-planner.mjs";

const taskHash = "a".repeat(64);
const execFileAsync = promisify(execFile);

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

function plannerPacket(overrides = {}) {
  return {
    schemaVersion: 1,
    workflowAdapter: "direct",
    responsibility: "exploration",
    goal: "Inspect the bounded fixture",
    readScope: ["tests"],
    writeScope: [],
    knownFacts: ["The fixture is local"],
    constraints: ["No writes"],
    deliverable: "Evidence",
    successCriteria: ["Bounded result"],
    checks: ["Run focused test"],
    prohibitedActions: ["No descendants"],
    parentPermission: "read-only",
    requiredPermission: "read-only",
    requiresNativeLineage: false,
    requestedRole: null,
    ownerOptIn: false,
    legacyAdapter: false,
    batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
    riskSignals: {
      ambiguous: false,
      hiddenCoupling: false,
      highRisk: false,
      weakVerification: false,
    },
    costSignals: {
      estimatedRootToolCalls: 5,
      oneLocation: false,
      packagingDominates: false,
      directlyConsumable: true,
      repetitiveReads: 3,
      moduleCount: 1,
      fileCount: 1,
      bytes: 0,
      lines: 0,
      itemCount: 0,
      includesRegressionTest: false,
      boundedFileCount: 0,
    },
    ...overrides,
  };
}

function plannedDecision(packet = plannerPacket()) {
  return planDispatch({
    policy: { mode: "active", allowTypedBridge: false },
    packet,
    capabilities: {
      agentTypeVisible: true,
      runtimeMetadataAvailable: true,
      bridgeRuntimeVerified: false,
      permissionBypassActive: false,
    },
    roleSpecs: ROLE_SPECS,
  });
}

async function waitForReady(directory, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await readdir(directory)).length === count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("concurrent append workers did not reach the barrier");
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

test("createDispatchRecord accepts a real planner decision without raw task content", () => {
  const value = createDispatchRecord({
    decision: plannedDecision(),
    result: result(),
    workflowAdapter: "direct",
    parentPermission: "read-only",
    rootVerification: { pass: true },
  });

  assert.equal(value.responsibility, "exploration");
  assert.equal(validateDispatchRecord(value).pass, true);
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
    "threadId",
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
    validateDispatchRecord(record({ reasonCode: `ROOT_/${"Users"}/private-owner/task` })).pass,
    false,
  );
  assert.equal(
    validateDispatchRecord(record({ tokens: { parent: 120, child: "/home/private-owner", isolatedRoot: 0 } })).pass,
    false,
  );
});

test("dispatch ledger schema and serialized record remain unchanged", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dispatch-ledger-schema-"));
  const path = join(parent, "dispatch-ledger.jsonl");
  const value = record();
  appendDispatchRecord(path, value);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), value);
  assert.equal(validateDispatchRecord(value).pass, true);
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

test("appendDispatchRecord refuses an existing parent it does not own", async () => {
  const parent = await mkdtemp(join(tmpdir(), "dispatch-ledger-unowned-"));
  const path = join(parent, "dispatch-ledger.jsonl");
  await chmod(parent, 0o755);

  assert.throws(() => appendDispatchRecord(path, record()), /owned 0700 directory/);
  assert.equal((await stat(parent)).mode & 0o777, 0o755);
});

test("appendDispatchRecord retains every complete record from concurrent processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "dispatch-ledger-concurrent-"));
  const parent = join(root, "ledger");
  const ready = join(root, "ready");
  const start = join(root, "start");
  const path = join(parent, "dispatch-ledger.jsonl");
  const count = 12;
  await mkdir(parent, { mode: 0o700 });
  await mkdir(ready, { mode: 0o700 });
  const moduleUrl = new URL("../lib/dispatch-ledger.mjs", import.meta.url).href;
  const worker = [
    'const { appendDispatchRecord } = await import(process.env.LEDGER_MODULE);',
    'import { existsSync, writeFileSync } from "node:fs";',
    'writeFileSync(`${process.env.READY_DIR}/${process.env.RECORD_ID}`, "ready");',
    'while (!existsSync(process.env.START_PATH)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);',
    'appendDispatchRecord(process.env.LEDGER_PATH, JSON.parse(process.env.DISPATCH_RECORD));',
  ].join("\n");
  const workers = Array.from({ length: count }, (_, index) => {
    const value = record({
      taskHash: `${"a".repeat(63)}${index.toString(16)}`,
      tokens: { parent: index, child: 0, isolatedRoot: 0 },
    });
    return execFileAsync(process.execPath, ["--input-type=module", "--eval", worker], {
      env: {
        ...process.env,
        DISPATCH_RECORD: JSON.stringify(value),
        LEDGER_MODULE: moduleUrl,
        LEDGER_PATH: path,
        READY_DIR: ready,
        RECORD_ID: String(index),
        START_PATH: start,
      },
    });
  });

  await waitForReady(ready, count);
  await writeFile(start, "go");
  await Promise.all(workers);

  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, count);
  assert.deepEqual(
    lines.map((line) => validateDispatchRecord(JSON.parse(line)).pass),
    Array(count).fill(true),
  );
  assert.deepEqual(
    new Set(lines.map((line) => JSON.parse(line).tokens.parent)),
    new Set(Array.from({ length: count }, (_, index) => index)),
  );
  assert.deepEqual(await readdir(parent), ["dispatch-ledger.jsonl"]);
});
