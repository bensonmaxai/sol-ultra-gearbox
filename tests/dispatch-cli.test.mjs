import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createDispatchPolicy, serializeDispatchPolicy } from "../lib/dispatch-policy.mjs";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const CLI = join(REPO_ROOT, "scripts", "gearbox-dispatch.mjs");

function packet(overrides = {}) {
  return {
    schemaVersion: 1,
    workflowAdapter: "direct",
    responsibility: "exploration",
    goal: "Trace fixture requests",
    readScope: ["fixtures/src", "fixtures/tests"],
    writeScope: [],
    knownFacts: ["RAW_PROMPT_MUST_NOT_APPEAR"],
    constraints: ["No writes"],
    deliverable: "Structured evidence",
    successCriteria: ["All hops are named"],
    checks: ["Inspect five files"],
    prohibitedActions: ["Do not spawn descendants"],
    parentPermission: "workspace-write",
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
      repetitiveReads: 0,
      moduleCount: 2,
      fileCount: 5,
      bytes: 0,
      lines: 0,
      itemCount: 0,
      includesRegressionTest: false,
      boundedFileCount: 0,
    },
    ...overrides,
  };
}

function run(args, env = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function fixture(t, { policy = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), "gearbox-dispatch-home-"));
  const owned = await mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-dispatch-packet-"));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(owned, { recursive: true, force: true })]));
  if (policy) {
    await mkdir(join(home, "gearbox"), { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, "gearbox", "dispatch-policy.json"),
      serializeDispatchPolicy(createDispatchPolicy({ mode: "shadow", allowTypedBridge: false, activation: null })),
      { mode: 0o600 },
    );
  }
  const path = join(owned, "packet.json");
  await writeFile(path, `${JSON.stringify(packet())}\n`, { mode: 0o600 });
  return { home, owned, path };
}

function jsonOnly(result) {
  assert.equal(result.stderr, "");
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.doesNotMatch(result.stdout, /RAW_PROMPT_MUST_NOT_APPEAR/);
  return JSON.parse(result.stdout);
}

test("status and plan use a signed shadow policy and consume only the owned packet", async (t) => {
  const { home, path } = await fixture(t);
  const status = jsonOnly(await run(["status"], { CODEX_HOME: home }));
  assert.deepEqual(status, { status: "GEARBOX_DISPATCH_SHADOW", mode: "shadow" });

  const result = await run(["plan", "--packet", path, "--consume"], { CODEX_HOME: home });
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const output = jsonOnly(result);
  assert.equal(output.status, "GEARBOX_DISPATCH_PLAN");
  assert.equal(output.decision.selectedShape, "isolated_role_root");
  assert.equal(output.decision.effectiveShape, "root_inline");
  await assert.rejects(access(path));
});

test("plan refuses a packet outside the owned temporary directory", async (t) => {
  const { home } = await fixture(t);
  const arbitrary = join(home, "packet.json");
  await writeFile(arbitrary, `${JSON.stringify(packet())}\n`);
  const result = await run(["plan", "--packet", arbitrary, "--consume"], { CODEX_HOME: home });
  assert.equal(result.code, 1);
  const output = jsonOnly(result);
  assert.equal(output.status, "GEARBOX_DISPATCH_OFF");
  assert.equal(await readFile(arbitrary, "utf8"), `${JSON.stringify(packet())}\n`);
});

test("missing policy fails closed before any packet is read or model is launched", async (t) => {
  const { home, path } = await fixture(t, { policy: false });
  const result = await run(["plan", "--packet", path, "--consume"], { CODEX_HOME: home });
  assert.equal(result.code, 1);
  assert.deepEqual(jsonOnly(result), { status: "GEARBOX_DISPATCH_OFF", mode: "off" });
  await access(path);
});
