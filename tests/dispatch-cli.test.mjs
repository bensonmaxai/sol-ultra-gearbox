import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function run(args, env = {}, cwd = REPO_ROOT) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
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

async function fixture(t, { policy = true, policyMode = "shadow" } = {}) {
  const home = await mkdtemp(join(tmpdir(), "gearbox-dispatch-home-"));
  const owned = await mkdtemp(join(tmpdir(), "sol-ultra-gearbox-v2-packet-dispatch-"));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(owned, { recursive: true, force: true })]));
  if (policy) {
    await mkdir(join(home, "gearbox"), { recursive: true, mode: 0o700 });
    const activation = policyMode === "active"
      ? { installId: "fixture", manifestPath: "/tmp/fixture-manifest.json" }
      : null;
    await writeFile(
      join(home, "gearbox", "dispatch-policy.json"),
      serializeDispatchPolicy(createDispatchPolicy({ mode: policyMode, allowTypedBridge: false, activation })),
      { mode: 0o600 },
    );
  }
  const path = join(owned, "packet.json");
  await writeFile(path, `${JSON.stringify(packet())}\n`, { mode: 0o600 });
  return { home, owned, path };
}

async function fakeCodex(path) {
  const source = `#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const after = (flag) => args[args.indexOf(flag) + 1];
const config = (key) => { for (let i = 0; i < args.length; i += 1) if (args[i] === "-c" && (args[i + 1] ?? "").startsWith(key + "=")) return JSON.parse(args[i + 1].slice(key.length + 1)); return null; };
const cwd = after("-C");
const marker = /append ([^\\s]+) on a separate final line/.exec(args.at(-1))?.[1] ?? "MISSING";
const mode = process.env.FAKE_CLI_MODE ?? "success";
await writeFile(process.env.FAKE_CLI_LOG, JSON.stringify({ cwd, sentinelVisible: existsSync(join(cwd, "sentinel.txt")), allowedVisible: existsSync(join(cwd, "allowed", "visible.txt")) }));
if (mode === "scope_symlink") { await rm(cwd, { recursive: true, force: true }); await symlink(process.env.FAKE_CLI_ESCAPE, cwd); }
const sessions = join(process.env.CODEX_HOME, "sessions", "fake");
await mkdir(sessions, { recursive: true });
const final = mode === "marker_mismatch" ? "WRONG" : "{\\"kind\\":\\"fake-deliverable\\",\\"value\\":\\"verified\\"}\\n" + marker;
const events = [
  { type: "session_meta", payload: { id: "fake-root", thread_source: "user", cwd } },
  { type: "turn_context", payload: { model: mode === "model_mismatch" ? "gpt-5.6-sol" : config("model"), effort: config("model_reasoning_effort"), sandbox_policy: { type: after("-s") } } },
  { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 5 } } } },
  { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: final }] } },
];
await writeFile(join(sessions, "rollout.jsonl"), events.map(JSON.stringify).join("\\n"));
`;
  await writeFile(path, source, { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
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

  const result = await run([
    "plan", "--packet", path, "--consume",
    "--agent-type-visible", "true",
    "--runtime-metadata-available", "true",
    "--permissions-enforced", "true",
  ], { CODEX_HOME: home });
  assert.equal(result.code, 0, `${result.stdout}${result.stderr}`);
  const output = jsonOnly(result);
  assert.equal(output.status, "GEARBOX_DISPATCH_PLAN");
  assert.equal(output.decision.selectedShape, "isolated_role_root");
  assert.equal(output.decision.effectiveShape, "root_inline");
  await assert.rejects(access(path));
});

test("plan fails closed when current capability facts are missing or unsafe", async (t) => {
  const { home, path } = await fixture(t);
  const missing = jsonOnly(await run(["plan", "--packet", path], { CODEX_HOME: home }));
  assert.equal(missing.decision.selectedShape, "root_inline");
  assert.equal(missing.decision.reasonCode, "ROOT_SCHEMA_UNAVAILABLE");

  for (const [flag, value, reason] of [
    ["--agent-type-visible", "false", "ROOT_SCHEMA_UNAVAILABLE"],
    ["--runtime-metadata-available", "false", "ROOT_RUNTIME_EVIDENCE_FAILED"],
    ["--permissions-enforced", "false", "ROOT_HIGH_RISK"],
  ]) {
    const capabilities = [
      "--agent-type-visible", flag === "--agent-type-visible" ? value : "true",
      "--runtime-metadata-available", flag === "--runtime-metadata-available" ? value : "true",
      "--permissions-enforced", flag === "--permissions-enforced" ? value : "true",
    ];
    const result = jsonOnly(await run(["plan", "--packet", path, ...capabilities], { CODEX_HOME: home }));
    assert.equal(result.decision.selectedShape, "root_inline");
    assert.equal(result.decision.reasonCode, reason);
  }
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

test("active isolated execution materializes only allowed read scope and never releases failed deliverables", async (t) => {
  const { home } = await fixture(t, { policyMode: "active" });
  const source = await mkdtemp(join(tmpdir(), "gearbox-dispatch-source-"));
  const escape = await mkdtemp(join(tmpdir(), "gearbox-dispatch-escape-"));
  const isolatedTmp = await mkdtemp(join(tmpdir(), "gearbox-dispatch-runtime-tmp-"));
  const owned = await mkdtemp(join(isolatedTmp, "sol-ultra-gearbox-v2-packet-dispatch-"));
  const path = join(owned, "packet.json");
  const log = join(home, "fake-log.json");
  t.after(() => Promise.all([rm(source, { recursive: true, force: true }), rm(escape, { recursive: true, force: true }), rm(isolatedTmp, { recursive: true, force: true })]));
  await mkdir(join(source, "allowed"));
  await writeFile(join(source, "allowed", "visible.txt"), "visible\n");
  await writeFile(join(source, "sentinel.txt"), "private\n");
  await writeFile(join(home, "auth.json"), "fixture auth\n");
  await mkdir(join(home, "agents"));
  await writeFile(join(home, "agents", "terra-explorer.toml"), await readFile(join(REPO_ROOT, "roles", "terra-explorer.toml"), "utf8"));
  const fake = await fakeCodex(join(home, "fake-codex.mjs"));
  await writeFile(path, `${JSON.stringify(packet({ readScope: ["allowed"] }))}\n`, { mode: 0o600 });
  const capabilityArgs = ["--agent-type-visible", "true", "--runtime-metadata-available", "true", "--permissions-enforced", "true"];
  const env = { CODEX_HOME: home, CODEX_BIN: fake, FAKE_CLI_LOG: log, FAKE_CLI_ESCAPE: escape, TMPDIR: isolatedTmp };
  const missingCapabilities = await run(["run-isolated", "--packet", path], env, source);
  assert.equal(missingCapabilities.code, 1);
  assert.equal(jsonOnly(missingCapabilities).status, "GEARBOX_DISPATCH_NOT_ISOLATED");
  await assert.rejects(access(log));
  const success = await run(["run-isolated", "--packet", path, ...capabilityArgs], env, source);
  assert.equal(success.code, 0, success.stdout);
  assert.equal(jsonOnly(success).status, "GEARBOX_DISPATCH_RESULT");
  assert.match(success.stdout, /verified/);
  assert.deepEqual(JSON.parse(await readFile(log, "utf8")), {
    cwd: JSON.parse(await readFile(log, "utf8")).cwd,
    sentinelVisible: false,
    allowedVisible: true,
  });

  for (const mode of ["model_mismatch", "marker_mismatch", "scope_symlink"]) {
    await writeFile(path, `${JSON.stringify(packet({ readScope: ["allowed"] }))}\n`, { mode: 0o600 });
    const failed = await run(["run-isolated", "--packet", path, ...capabilityArgs], { ...env, FAKE_CLI_MODE: mode }, source);
    assert.equal(failed.code, 1);
    assert.doesNotMatch(failed.stdout, /verified/);
    if (mode === "scope_symlink") {
      await rm(JSON.parse(await readFile(log, "utf8")).cwd, { recursive: true, force: true });
    }
  }
  const duplicate = await run([
    "plan", "--packet", path,
    "--agent-type-visible", "true",
    "--agent-type-visible", "true",
  ], env, source);
  assert.equal(duplicate.code, 1);
  assert.deepEqual(jsonOnly(duplicate), { status: "GEARBOX_DISPATCH_OFF", mode: "off" });
});
