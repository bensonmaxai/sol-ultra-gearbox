import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createHash } from "node:crypto";
import { createDispatchPolicy, serializeDispatchPolicy } from "../lib/dispatch-policy.mjs";
import { DISPATCH_RUNTIME_FILES, ROLE_SPECS } from "../lib/gearbox.mjs";
import { workflowPlan } from "./helpers/workflow-fixtures.mjs";

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

function workflowEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    plan: workflowPlan(),
    binding: { currentArtifactHashes: {} },
    stateSource: { kind: "managed" },
    event: null,
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
    const manifestPath = join(home, "reports", "fixture-acceptance", "install-manifest.json");
    const activation = policyMode === "active"
      ? { installId: "fixture", manifestPath }
      : null;
    const policyPath = join(home, "gearbox", "dispatch-policy.json");
    const source = serializeDispatchPolicy(createDispatchPolicy({ mode: policyMode, allowTypedBridge: false, activation }));
    await writeFile(
      policyPath,
      source,
      { mode: 0o600 },
    );
    if (policyMode === "active") {
      const digest = createHash("sha256").update(source).digest("hex");
      const configPath = join(home, "config.toml");
      const configSource = "model = \"gpt-5.6-sol\"\n";
      const configDigest = createHash("sha256").update(configSource).digest("hex");
      await writeFile(configPath, configSource, { mode: 0o600 });
      const agentsPath = join(home, "AGENTS.md");
      const agentsSource = "# Managed fixture\n";
      const agentsDigest = createHash("sha256").update(agentsSource).digest("hex");
      await writeFile(agentsPath, agentsSource, { mode: 0o644 });
      const files = [{
        kind: "dispatch-policy",
        sourcePath: null,
        targetPath: policyPath,
        mode: 0o600,
        sourceSha256: digest,
        afterSha256: digest,
        targetSha256: digest,
        policyMode: "active",
      }];
      for (const spec of ROLE_SPECS) {
        const roleSource = await readFile(join(REPO_ROOT, "roles", spec.sourceFile), "utf8");
        const roleDigest = createHash("sha256").update(roleSource).digest("hex");
        const targetPath = join(home, "agents", spec.installFile);
        await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
        await writeFile(targetPath, roleSource, { mode: 0o644 });
        files.push({
          kind: "role",
          role: spec.name,
          sourcePath: join(home, "roles", spec.sourceFile),
          targetPath,
          afterSha256: roleDigest,
        });
      }
      const launcherSource = await readFile(join(REPO_ROOT, "scripts", "codex-typed-agent"), "utf8");
      const launcherDigest = createHash("sha256").update(launcherSource).digest("hex");
      const launcherPath = join(home, "bin", "codex-typed-agent");
      await mkdir(dirname(launcherPath), { recursive: true, mode: 0o700 });
      await writeFile(launcherPath, launcherSource, { mode: 0o755 });
      files.push({
        kind: "launcher",
        sourcePath: join(home, "scripts", "codex-typed-agent"),
        targetPath: launcherPath,
        mode: 0o755,
        sourceSha256: launcherDigest,
        afterSha256: launcherDigest,
        targetSha256: launcherDigest,
      });
      for (const path of DISPATCH_RUNTIME_FILES) {
        const runtimeSource = `runtime:${path}\n`;
        const runtimeDigest = createHash("sha256").update(runtimeSource).digest("hex");
        const targetPath = join(home, "gearbox", "runtime", path);
        await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
        await writeFile(targetPath, runtimeSource, { mode: 0o644 });
        files.push({
          kind: "dispatch-runtime",
          sourcePath: join(home, path),
          targetPath,
          mode: 0o644,
          sourceSha256: runtimeDigest,
          afterSha256: runtimeDigest,
          targetSha256: runtimeDigest,
        });
      }
      const wrapperSource = "#!/bin/sh\nexit 0\n";
      const wrapperDigest = createHash("sha256").update(wrapperSource).digest("hex");
      const wrapperPath = join(home, "bin", "gearbox-dispatch");
      await mkdir(dirname(wrapperPath), { recursive: true, mode: 0o700 });
      await writeFile(wrapperPath, wrapperSource, { mode: 0o755 });
      files.push({
        kind: "dispatch-wrapper",
        sourcePath: join(home, "scripts", "gearbox-dispatch"),
        targetPath: wrapperPath,
        mode: 0o755,
        sourceSha256: wrapperDigest,
        afterSha256: wrapperDigest,
        targetSha256: wrapperDigest,
      });
      await mkdir(dirname(manifestPath), { recursive: true, mode: 0o700 });
      await writeFile(manifestPath, `${JSON.stringify({
        schemaVersion: 1,
        status: "applied",
        activation: {
          installId: "fixture",
          manifestPath,
          repositoryRoot: home,
          policySha256: JSON.parse(source).sha256,
          acceptanceBindingSha256: "a".repeat(64),
          writingSkillsEvidenceSha256: "b".repeat(64),
        },
        config: { path: configPath, mode: 0o600, afterSha256: configDigest },
        agents: { path: agentsPath, mode: 0o644, afterSha256: agentsDigest },
        staticChecks: { strictConfig: true, configLoad: true, mcpConfig: true, installation: true },
        postInstallRootSmoke: { pass: true, actual: { persisted: true, model: "gpt-5.6-sol", effort: "ultra" } },
        files,
      })}\n`, { mode: 0o600 });
    }
  }
  const path = join(owned, "packet.json");
  await writeFile(path, `${JSON.stringify(packet())}\n`, { mode: 0o600 });
  return { home, owned, path };
}

async function fakeCodex(path) {
  const source = `#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
const args = process.argv.slice(2);
const after = (flag) => args[args.indexOf(flag) + 1];
const config = (key) => { for (let i = 0; i < args.length; i += 1) if (args[i] === "-c" && (args[i + 1] ?? "").startsWith(key + "=")) return JSON.parse(args[i + 1].slice(key.length + 1)); return null; };
const cwd = after("-C");
const marker = /append ([^\\s]+) on a separate final line/.exec(args.at(-1))?.[1] ?? "MISSING";
const mode = process.env.FAKE_CLI_MODE ?? "success";
const binary = join(cwd, "allowed", "binary.bin");
await writeFile(process.env.FAKE_CLI_LOG, JSON.stringify({
  cwd,
  sentinelVisible: existsSync(join(cwd, "sentinel.txt")),
  allowedVisible: existsSync(join(cwd, "allowed", "visible.txt")),
  binaryHex: existsSync(binary) ? readFileSync(binary).toString("hex") : null,
}));
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

test("status and plan use an integrity-bound shadow policy and consume only the owned packet", async (t) => {
  const { home, path } = await fixture(t);
  const status = jsonOnly(await run(["status"], { CODEX_HOME: home }));
  assert.deepEqual(status, { status: "GEARBOX_DISPATCH_SHADOW", mode: "shadow" });

  const result = await run([
    "plan", "--packet", path, "--consume",
    "--agent-type-visible", "true",
    "--isolated-runner-verified", "true",
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

  const isolated = jsonOnly(await run([
    "plan", "--packet", path,
    "--agent-type-visible", "false",
    "--isolated-runner-verified", "true",
    "--runtime-metadata-available", "true",
    "--permissions-enforced", "true",
  ], { CODEX_HOME: home }));
  assert.equal(isolated.decision.selectedShape, "isolated_role_root");
  assert.equal(isolated.decision.reasonCode, "DELEGATE_ISOLATED_SCHEMA_UNAVAILABLE");

  for (const [flag, value, reason] of [
    ["--isolated-runner-verified", "false", "ROOT_ISOLATED_RUNNER_UNAVAILABLE"],
    ["--runtime-metadata-available", "false", "ROOT_RUNTIME_EVIDENCE_FAILED"],
    ["--permissions-enforced", "false", "ROOT_HIGH_RISK"],
  ]) {
    const capabilities = [
      "--agent-type-visible", "true",
      "--isolated-runner-verified", flag === "--isolated-runner-verified" ? value : "true",
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

test("workflow-next fails closed before consuming an owned packet when policy is off", async (t) => {
  const { home, path } = await fixture(t, { policy: false });
  const source = `${JSON.stringify(workflowEnvelope())}\n`;
  await writeFile(path, source, { mode: 0o600 });
  const result = await run(["workflow-next", "--packet", path, "--consume"], { CODEX_HOME: home });
  assert.equal(result.code, 1);
  assert.deepEqual(jsonOnly(result), { status: "GEARBOX_DISPATCH_OFF", mode: "off" });
  assert.equal(await readFile(path, "utf8"), source);
});

test("workflow-next returns the managed public action without a raw plan goal", async (t) => {
  const { home, path } = await fixture(t);
  const source = await mkdtemp(join(tmpdir(), "gearbox-workflow-source-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  for (const directory of ["lib", "scripts", "tests"]) {
    await mkdir(join(source, directory), { recursive: true });
    await writeFile(join(source, directory, "fixture.txt"), "fixture\n");
  }
  await writeFile(path, `${JSON.stringify(workflowEnvelope())}\n`, { mode: 0o600 });
  const result = await run([
    "workflow-next", "--packet", path,
    "--agent-type-visible", "true",
    "--isolated-runner-verified", "true",
    "--runtime-metadata-available", "true",
    "--permissions-enforced", "true",
  ], { CODEX_HOME: home }, source);
  assert.equal(result.code, 0, result.stdout);
  const value = jsonOnly(result);
  assert.equal(value.status, "GEARBOX_WORKFLOW_ACTION");
  assert.equal(value.source, "managed");
  assert.equal(value.public.kind, "root_inline");
  assert.doesNotMatch(result.stdout, /Audit two modules|workflow-ledger\.jsonl|\/private\//);
});

test("active policy requires its applied manifest before planning", async (t) => {
  const { home, path } = await fixture(t, { policyMode: "active" });
  const valid = await run(["status"], { CODEX_HOME: home });
  const activeStatus = jsonOnly(valid);
  assert.equal(activeStatus.mode, "active");
  assert.equal(activeStatus.integrity, "pass");
  assert.equal(activeStatus.allowTypedBridge, false);
  assert.match(activeStatus.policySha256, /^[a-f0-9]{64}$/);
  assert.match(activeStatus.configSha256, /^[a-f0-9]{64}$/);
  assert.match(activeStatus.agentsSha256, /^[a-f0-9]{64}$/);
  assert.match(activeStatus.launcherSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(activeStatus.roleHashes).sort(), ROLE_SPECS.map((spec) => spec.name).sort());
  assert.deepEqual(
    Object.keys(activeStatus.runtimeHashes).sort(),
    [...DISPATCH_RUNTIME_FILES, "scripts/gearbox-dispatch"].sort(),
  );
  assert.doesNotMatch(valid.stdout, /manifestPath|install-manifest|\/Users\//);
  const policy = JSON.parse(await readFile(join(home, "gearbox", "dispatch-policy.json"), "utf8"));
  const manifestSource = await readFile(policy.activation.manifestPath, "utf8");
  const manifest = JSON.parse(manifestSource);
  const maxRootManifest = structuredClone(manifest);
  maxRootManifest.postInstallRootSmoke.actual.effort = "max";
  await writeFile(policy.activation.manifestPath, `${JSON.stringify(maxRootManifest)}\n`, { mode: 0o600 });
  const maxRootStatus = jsonOnly(await run(["status"], { CODEX_HOME: home }));
  assert.equal(maxRootStatus.mode, "active");
  assert.equal(maxRootStatus.integrity, "pass");
  for (const mutate of [
    (value) => { value.status = "applying"; },
    (value) => { value.activation.acceptanceBindingSha256 = "invalid"; },
    (value) => { value.activation.writingSkillsEvidenceSha256 = "invalid"; },
    (value) => { value.files[0].mode = 0o644; },
    (value) => { value.files.push({ ...value.files[0] }); },
    (value) => { value.staticChecks.configLoad = false; },
    (value) => { value.postInstallRootSmoke.actual.effort = "high"; },
  ]) {
    const drift = structuredClone(manifest);
    mutate(drift);
    await writeFile(policy.activation.manifestPath, `${JSON.stringify(drift)}\n`, { mode: 0o600 });
    const blocked = await run(["plan", "--packet", path], { CODEX_HOME: home });
    assert.deepEqual(jsonOnly(blocked), { status: "GEARBOX_DISPATCH_OFF", mode: "off" });
    assert.doesNotMatch(blocked.stdout, /manifest|acceptanceBinding|policySha256/);
  }
  await writeFile(policy.activation.manifestPath, manifestSource, { mode: 0o600 });
  const runtimeEntry = manifest.files.find((entry) => entry.kind === "dispatch-runtime");
  const runtimeSource = await readFile(runtimeEntry.targetPath, "utf8");
  await writeFile(runtimeEntry.targetPath, `${runtimeSource}drift\n`);
  assert.deepEqual(
    jsonOnly(await run(["status"], { CODEX_HOME: home })),
    { status: "GEARBOX_DISPATCH_OFF", mode: "off" },
  );
  await writeFile(runtimeEntry.targetPath, runtimeSource);
  await chmod(runtimeEntry.targetPath, 0o600);
  assert.deepEqual(
    jsonOnly(await run(["status"], { CODEX_HOME: home })),
    { status: "GEARBOX_DISPATCH_OFF", mode: "off" },
  );
  await chmod(runtimeEntry.targetPath, 0o644);
  const wrapperEntry = manifest.files.find((entry) => entry.kind === "dispatch-wrapper");
  await chmod(wrapperEntry.targetPath, 0o644);
  assert.deepEqual(
    jsonOnly(await run(["status"], { CODEX_HOME: home })),
    { status: "GEARBOX_DISPATCH_OFF", mode: "off" },
  );
  await chmod(wrapperEntry.targetPath, 0o755);
  const configSource = await readFile(manifest.config.path, "utf8");
  await writeFile(manifest.config.path, `${configSource}drift = true\n`);
  assert.deepEqual(
    jsonOnly(await run(["status"], { CODEX_HOME: home })),
    { status: "GEARBOX_DISPATCH_OFF", mode: "off" },
  );
  await writeFile(manifest.config.path, configSource);
  await chmod(manifest.config.path, 0o620);
  assert.deepEqual(
    jsonOnly(await run(["status"], { CODEX_HOME: home })),
    { status: "GEARBOX_DISPATCH_OFF", mode: "off" },
  );
  await chmod(manifest.config.path, 0o600);
  const roleEntry = manifest.files.find((entry) => entry.kind === "role");
  await chmod(roleEntry.targetPath, 0o600);
  assert.deepEqual(
    jsonOnly(await run(["status"], { CODEX_HOME: home })),
    { status: "GEARBOX_DISPATCH_OFF", mode: "off" },
  );
  await chmod(roleEntry.targetPath, 0o644);
  await chmod(join(home, "gearbox", "dispatch-policy.json"), 0o644);
  const wrongMode = await run(["status"], { CODEX_HOME: home });
  assert.deepEqual(jsonOnly(wrongMode), { status: "GEARBOX_DISPATCH_OFF", mode: "off" });
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
  await writeFile(join(source, "allowed", "binary.bin"), Buffer.from([0x00, 0xff, 0x01, 0xfe]));
  await writeFile(join(source, "sentinel.txt"), "private\n");
  await writeFile(join(escape, "secret.txt"), "outside scope\n");
  await symlink(escape, join(source, "linked"));
  await writeFile(join(home, "auth.json"), "fixture auth\n");
  await mkdir(join(home, "agents"), { recursive: true });
  await writeFile(join(home, "agents", "terra-explorer.toml"), await readFile(join(REPO_ROOT, "roles", "terra-explorer.toml"), "utf8"));
  const fake = await fakeCodex(join(home, "fake-codex.mjs"));
  await writeFile(path, `${JSON.stringify(packet({ readScope: ["allowed"] }))}\n`, { mode: 0o600 });
  const capabilityArgs = ["--agent-type-visible", "false", "--isolated-runner-verified", "true", "--runtime-metadata-available", "true", "--permissions-enforced", "true"];
  const env = { CODEX_HOME: home, CODEX_BIN: fake, FAKE_CLI_LOG: log, FAKE_CLI_ESCAPE: escape, TMPDIR: isolatedTmp };
  const missingCapabilities = await run(["run-isolated", "--packet", path], env, source);
  assert.equal(missingCapabilities.code, 1);
  assert.equal(jsonOnly(missingCapabilities).status, "GEARBOX_DISPATCH_NOT_ISOLATED");
  await assert.rejects(access(log));
  const success = await run(["run-isolated", "--packet", path, ...capabilityArgs], env, source);
  assert.equal(success.code, 0, success.stdout);
  const successOutput = jsonOnly(success);
  assert.equal(successOutput.status, "GEARBOX_DISPATCH_RESULT");
  assert.equal(successOutput.result.reasonCode, successOutput.decision.reasonCode);
  assert.match(success.stdout, /verified/);
  const successLog = JSON.parse(await readFile(log, "utf8"));
  assert.deepEqual(successLog, {
    cwd: successLog.cwd,
    sentinelVisible: false,
    allowedVisible: true,
    binaryHex: "00ff01fe",
  });

  await rm(log, { force: true });
  await writeFile(path, `${JSON.stringify(packet({ readScope: ["linked/secret.txt"] }))}\n`);
  const ancestorSymlink = await run(["run-isolated", "--packet", path, ...capabilityArgs], env, source);
  assert.equal(ancestorSymlink.code, 1);
  assert.deepEqual(jsonOnly(ancestorSymlink), { status: "GEARBOX_DISPATCH_OFF", mode: "off" });
  await assert.rejects(access(log));

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

test("active writing-skills execution uses only the isolated Sol tester route", async (t) => {
  const { home, path } = await fixture(t, { policyMode: "active" });
  const source = await mkdtemp(join(tmpdir(), "gearbox-writing-skills-source-"));
  const log = join(home, "writing-skills-log.json");
  t.after(() => rm(source, { recursive: true, force: true }));
  await writeFile(join(source, "scenario.md"), "pressure scenario\n", "utf8");
  await writeFile(join(source, "SKILL.md"), "target guidance\n", "utf8");
  await writeFile(join(home, "auth.json"), "fixture auth\n", "utf8");
  const fake = await fakeCodex(join(home, "fake-writing-skills-codex.mjs"));
  const value = packet({
    workflowAdapter: "superpowers:writing-skills",
    responsibility: "skill_testing",
    requestedRole: "sol_skill_tester",
    ownerOptIn: true,
    readScope: ["scenario.md", "SKILL.md"],
  });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const capabilities = [
    "--agent-type-visible", "true",
    "--isolated-runner-verified", "true",
    "--runtime-metadata-available", "true",
    "--permissions-enforced", "true",
  ];
  const result = await run(
    ["run-isolated", "--packet", path, ...capabilities],
    {
      CODEX_HOME: home,
      CODEX_BIN: fake,
      FAKE_CLI_LOG: log,
      FAKE_CLI_ESCAPE: source,
    },
    source,
  );
  assert.equal(result.code, 0, result.stdout);
  const output = jsonOnly(result);
  assert.equal(output.status, "GEARBOX_DISPATCH_RESULT");
  assert.equal(output.decision.role, "sol_skill_tester");
  assert.equal(
    output.decision.reasonCode,
    "DELEGATE_ISOLATED_SKILL_PRESSURE_TEST",
  );
  assert.equal(output.result.actual.model, "gpt-5.6-sol");
  assert.equal(output.result.actual.effort, "high");
  assert.equal(output.result.actual.sandbox, "read-only");
  assert.equal(output.result.actual.depth, 0);

  await writeFile(path, `${JSON.stringify({
    ...value,
    workflowAdapter: "direct",
  })}\n`, { mode: 0o600 });
  const generic = jsonOnly(await run(
    ["plan", "--packet", path, ...capabilities],
    { CODEX_HOME: home },
    source,
  ));
  assert.equal(generic.decision.selectedShape, "root_inline");
  assert.equal(generic.decision.reasonCode, "ROOT_SCOPE_AMBIGUOUS");
});
