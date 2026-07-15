import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  APP_SERVER_ROOT_HISTORY_MODE,
  APP_SERVER_ROOT_SMOKE_MARKER,
  createAppServerRootSmokePacket,
  deriveAppServerRootCapabilities,
  probeAppServerHandshake,
  runAppServerRoot,
  validateAppServerRootReceipt,
  validateRootProviderScope,
} from "../lib/app-server-root-provider.mjs";
import {
  APP_SERVER_ROOT_PROVIDER_CAPABILITIES,
  planRootLaunch,
} from "../lib/dispatch-planner.mjs";
import { createDispatchPolicy } from "../lib/dispatch-policy.mjs";
import { ROLE_SPECS, sha256 } from "../lib/gearbox.mjs";

function packet(overrides = {}) {
  return {
    schemaVersion: 1,
    workflowAdapter: "direct",
    responsibility: "exploration",
    goal: "Inspect the local fixture without disclosing its contents",
    readScope: ["fixtures/src", "fixtures/tests"],
    writeScope: [],
    knownFacts: ["The fixture is local"],
    constraints: ["No network"],
    deliverable: "A verified marker",
    successCriteria: ["Return the marker"],
    checks: ["Use persisted runtime evidence"],
    prohibitedActions: ["Do not request more authority"],
    parentPermission: "workspace-write",
    requiredPermission: "read-only",
    requiresNativeLineage: false,
    requestedRole: null,
    ownerOptIn: false,
    legacyAdapter: false,
    batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
    riskSignals: { ambiguous: false, hiddenCoupling: false, highRisk: false, weakVerification: false },
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

function policy(codexHome) {
  return createDispatchPolicy({
    mode: "active",
    allowTypedBridge: false,
    activation: {
      installId: "provider-test",
      recordPath: join(codexHome, "gearbox", "activations", "provider-test.json"),
    },
    rootProvider: {
      kind: "app_server_root",
      enabled: true,
      transport: "stdio",
      protocolVersion: 1,
      launcherPath: join(codexHome, "bin", "gearbox-root"),
      acceptanceBindingSha256: "a".repeat(64),
    },
  });
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gearbox-app-server-provider-")));
  const cwd = join(root, "repo with spaces");
  const codexHome = join(root, "codex home");
  await mkdir(join(cwd, "fixtures", "src"), { recursive: true });
  await mkdir(join(cwd, "fixtures", "tests"), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(cwd, "README.md"), "fixture readme\n");
  await writeFile(join(cwd, "fixtures", "src", "fixture.txt"), "fixture\n");
  const fake = join(root, "fake-app-server.mjs");
  await writeFile(fake, `
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
const threadId = "thread-private-id";
const turnId = "turn-private-id";
let threadCwd = null;
const rollout = join(process.env.TEST_CODEX_HOME, "sessions", "fake", "rollout.jsonl");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
if (process.env.TEST_STUBBORN_CLOSE) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const value = JSON.parse(line);
  if (value.method === "initialized") return;
  if (value.method === "initialize") return send({ id: value.id, result:
    process.env.TEST_NULL_INITIALIZE ? null : {
      userAgent: "Codex Desktop/" +
        (process.env.TEST_UNSUPPORTED_VERSION ? "9.9.9" : "0.144.2") +
        " (fixture; arm64) dumb (sol-ultra-gearbox-root; 1.0.0)",
      codexHome: process.env.TEST_CODEX_HOME,
      platformFamily: "unix",
      platformOs: "macos",
    }
  });
  if (value.method === "thread/start") {
    if (value.params.historyMode !== "legacy") {
      return send({ id: value.id, error: {
        code: -32601,
        message: "paginated_threads is not supported yet",
      } });
    }
    if (process.env.TEST_REJECT_THREAD_START) {
      return send({ id: value.id, error: {
        code: -32601,
        message: "fixture private thread/start rejection",
      } });
    }
    if (process.env.TEST_THREAD_START_MARKER) {
      await writeFile(process.env.TEST_THREAD_START_MARKER, "started\\n");
    }
    threadCwd = value.params.cwd;
    return send({ id: value.id, result: {
    model: value.params.model,
    reasoningEffort: "ultra",
    modelProvider: "openai",
    cwd: value.params.cwd,
    runtimeWorkspaceRoots: value.params.runtimeWorkspaceRoots,
    sandbox: { type: value.params.sandbox === "read-only" ? "readOnly" : "workspaceWrite" },
    thread: {
      id: threadId,
      sessionId: threadId,
      path: rollout,
      cwd: value.params.cwd,
      modelProvider: "openai",
      turns: [],
    },
    } });
  }
  if (value.method === "turn/start") {
    await mkdir(dirname(rollout), { recursive: true });
    const events = [
      { type: "session_meta", payload: { id: threadId, cwd: threadCwd, thread_source: "appServer" } },
      { type: "turn_context", payload: { model: value.params.model, effort: value.params.effort } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: 7 } } } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: value.params.input[0].text }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "FAKE_APP_SERVER_OK" }] } },
    ];
    await writeFile(rollout, events.map(JSON.stringify).join("\\n") + "\\n");
    if (process.env.TEST_MUTATE_PATH) {
      await mkdir(dirname(join(threadCwd, process.env.TEST_MUTATE_PATH)), { recursive: true });
      await writeFile(join(threadCwd, process.env.TEST_MUTATE_PATH), "drift\\n");
    }
    if (process.env.TEST_MUTATE_EMPTY_DIRECTORY) {
      await mkdir(join(threadCwd, process.env.TEST_MUTATE_EMPTY_DIRECTORY));
    }
    send({ id: value.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
    send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    return;
  }
  if (value.method === "thread/read") return send({ id: value.id, result: {
    thread: { id: threadId, modelProvider: "openai", turns: [{ id: turnId, status: "completed" }] },
  } });
  if (value.method === "thread/archive" || value.method === "thread/unsubscribe") {
    return send({ id: value.id, result: {} });
  }
  if (value.method === "turn/interrupt") return send({ id: value.id, result: {} });
});
`, { mode: 0o700 });
  await chmod(fake, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, codexHome, fake };
}

test("initialize evidence derives the exact supported host capabilities", () => {
  const codexHome = "/private/tmp/codex-home";
  const discovery = deriveAppServerRootCapabilities({
    userAgent: "Codex Desktop/0.144.2 (fixture; arm64) dumb (sol-ultra-gearbox-root; 1.0.0)",
    codexHome,
    platformFamily: "unix",
    platformOs: "macos",
  }, { codexHome });
  assert.equal(discovery.pass, true);
  assert.deepEqual(
    Object.keys(discovery.capabilities).sort(),
    [...APP_SERVER_ROOT_PROVIDER_CAPABILITIES].sort(),
  );
  assert.ok(Object.values(discovery.capabilities).every(Boolean));
  assert.equal(deriveAppServerRootCapabilities({
    userAgent: "Codex Desktop/9.9.9 (fixture)",
    codexHome,
    platformFamily: "unix",
    platformOs: "macos",
  }, { codexHome }).pass, false);
});

test("built-in provider smoke is a deterministic Sol Low read-only turn", () => {
  const value = createAppServerRootSmokePacket();
  const decision = planRootLaunch({
    policy: policy("/private/tmp/codex-home"),
    packet: value,
    capabilities: deriveAppServerRootCapabilities({
      userAgent: "Codex Desktop/0.144.2 (fixture)",
      codexHome: "/private/tmp/codex-home",
      platformFamily: "unix",
      platformOs: "macos",
    }, { codexHome: "/private/tmp/codex-home" }).capabilities,
    roleSpecs: ROLE_SPECS,
  });
  assert.equal(value.deliverable, APP_SERVER_ROOT_SMOKE_MARKER);
  assert.deepEqual(value.writeScope, []);
  assert.equal(decision.selectedShape, "app_server_root");
  assert.equal(decision.routing.root.model, "gpt-5.6-sol");
  assert.equal(decision.routing.root.effort, "low");
  assert.equal(APP_SERVER_ROOT_HISTORY_MODE, "legacy");
});

test("foreground App Server root verifies route, rollout, scope, and close evidence", async (t) => {
  const { cwd, codexHome, fake } = await fixture(t);
  const result = await runAppServerRoot({
    policy: policy(codexHome),
    packet: packet(),
    cwd,
    codexHome,
    serverCommand: [process.execPath, fake],
    requestTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
    environment: { ...process.env, TEST_CODEX_HOME: codexHome, TEST_CWD: cwd },
  });
  assert.equal(result.status, "pass");
  assert.equal(result.decision.routing.root.effort, "medium");
  assert.deepEqual(result.finalTexts, ["FAKE_APP_SERVER_OK"]);
  assert.equal(result.receipt.value.runtime.checks.modelMatches, true);
  assert.equal(result.receipt.value.runtime.checks.effortMatches, true);
  assert.equal(result.receipt.value.runtime.checks.taskMessageMatches, true);
  assert.equal(result.receipt.value.runtime.resultSha256, sha256("FAKE_APP_SERVER_OK"));
  assert.equal(result.receipt.value.scope.changedPathCount, 0);
  assert.equal(result.receipt.value.lifecycle.archived, true);
  assert.equal(result.receipt.value.lifecycle.unsubscribed, true);
  assert.equal(result.receipt.value.lifecycle.serverExitCode, 0);
  assert.equal(result.receipt.value.provider.serverVersion, "0.144.2");
  const validation = validateAppServerRootReceipt(result.receipt.value, {
    policySha256: policy(codexHome).sha256,
  });
  assert.equal(validation.pass, true, JSON.stringify(validation.checks));
  const tampered = structuredClone(result.receipt.value);
  tampered.runtime.checks.effortMatches = false;
  assert.equal(validateAppServerRootReceipt(tampered).pass, false);
  assert.equal((await stat(result.receipt.path)).mode & 0o777, 0o600);
  const source = await readFile(result.receipt.path, "utf8");
  assert.doesNotMatch(source, /repo with spaces|thread-private-id|turn-private-id|Inspect the local fixture/);
});

test("foreground smoke receipt uses the production Sol Low route", async (t) => {
  const { cwd, codexHome, fake } = await fixture(t);
  const result = await runAppServerRoot({
    policy: policy(codexHome),
    packet: createAppServerRootSmokePacket(),
    cwd,
    codexHome,
    serverCommand: [process.execPath, fake],
    requestTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
    environment: { ...process.env, TEST_CODEX_HOME: codexHome, TEST_CWD: cwd },
  });
  assert.equal(result.status, "pass");
  assert.deepEqual(result.receipt.value.route, {
    model: "gpt-5.6-sol",
    effort: "low",
    reasonCode: "ROOT_ROUTE_SOL_LOW_SIMPLE",
  });
});

test("handshake probe initializes and closes without creating a thread or turn", async (t) => {
  const { cwd, codexHome, fake } = await fixture(t);
  const result = await probeAppServerHandshake({
    serverCommand: [process.execPath, fake],
    cwd,
    codexHome,
    requestTimeoutMs: 5_000,
    environment: { ...process.env, TEST_CODEX_HOME: codexHome, TEST_CWD: cwd },
  });
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.equal(result.initialized, true);
  assert.equal(result.serverExitCode, 0);
});

test("handshake fails for a malformed initialize response and bounds stubborn close", async (t) => {
  const { cwd, codexHome, fake } = await fixture(t);
  const malformed = await probeAppServerHandshake({
    serverCommand: [process.execPath, fake],
    cwd,
    codexHome,
    requestTimeoutMs: 5_000,
    closeTimeoutMs: 100,
    environment: {
      ...process.env,
      TEST_CODEX_HOME: codexHome,
      TEST_CWD: cwd,
      TEST_NULL_INITIALIZE: "1",
    },
  });
  assert.equal(malformed.pass, false);
  assert.equal(malformed.initialized, false);

  const startedAt = Date.now();
  const stubborn = await probeAppServerHandshake({
    serverCommand: [process.execPath, fake],
    cwd,
    codexHome,
    requestTimeoutMs: 5_000,
    closeTimeoutMs: 100,
    environment: {
      ...process.env,
      TEST_CODEX_HOME: codexHome,
      TEST_CWD: cwd,
      TEST_STUBBORN_CLOSE: "1",
    },
  });
  assert.equal(stubborn.pass, false);
  assert.equal(stubborn.serverExitSignal, "SIGKILL");
  assert.ok(Date.now() - startedAt < 2_000);
});

test("unsupported App Server version falls back before thread start", async (t) => {
  const { cwd, codexHome, fake } = await fixture(t);
  const marker = join(codexHome, "thread-started.txt");
  const result = await runAppServerRoot({
    policy: policy(codexHome),
    packet: packet(),
    cwd,
    codexHome,
    serverCommand: [process.execPath, fake],
    requestTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
    environment: {
      ...process.env,
      TEST_CODEX_HOME: codexHome,
      TEST_CWD: cwd,
      TEST_UNSUPPORTED_VERSION: "1",
      TEST_THREAD_START_MARKER: marker,
    },
  });
  assert.equal(result.status, "fallback");
  assert.equal(result.decision.selectedShape, "root_inline");
  assert.equal(result.decision.provider.reasonCode, "APP_SERVER_ROOT_HOST_UNAVAILABLE");
  await assert.rejects(stat(marker), /ENOENT/);
});

test("thread/start rejection preserves a concrete privacy-safe failure", async (t) => {
  const { cwd, codexHome, fake } = await fixture(t);
  const result = await runAppServerRoot({
    policy: policy(codexHome),
    packet: packet(),
    cwd,
    codexHome,
    serverCommand: [process.execPath, fake],
    requestTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
    environment: {
      ...process.env,
      TEST_CODEX_HOME: codexHome,
      TEST_CWD: cwd,
      TEST_REJECT_THREAD_START: "1",
    },
  });
  assert.equal(result.status, "fail");
  assert.equal(result.receipt.value.reasonCode, "APP_SERVER_ROOT_THREAD_START_REJECTED");
  assert.equal(result.receipt.value.lifecycle.initialized, true);
  assert.equal(result.receipt.value.lifecycle.threadStarted, false);
  assert.equal(result.receipt.value.lifecycle.turnStarted, false);
  assert.equal(result.receipt.value.diagnostics.failureStage, "thread_start");
  assert.equal(result.receipt.value.diagnostics.serverErrorCode, -32601);
  assert.equal(
    result.receipt.value.diagnostics.serverErrorMessageSha256,
    sha256("fixture private thread/start rejection"),
  );
  assert.doesNotMatch(
    await readFile(result.receipt.path, "utf8"),
    /fixture private thread\/start rejection/,
  );
});

test("a SIGTERM-resistant provider returns a bounded lifecycle failure receipt", async (t) => {
  const { cwd, codexHome, fake } = await fixture(t);
  const startedAt = Date.now();
  const result = await runAppServerRoot({
    policy: policy(codexHome),
    packet: packet(),
    cwd,
    codexHome,
    serverCommand: [process.execPath, fake],
    requestTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
    closeTimeoutMs: 100,
    environment: {
      ...process.env,
      TEST_CODEX_HOME: codexHome,
      TEST_CWD: cwd,
      TEST_STUBBORN_CLOSE: "1",
    },
  });
  assert.equal(result.status, "fail");
  assert.equal(result.receipt.value.reasonCode, "APP_SERVER_ROOT_LIFECYCLE_FAILED");
  assert.equal(result.receipt.value.lifecycle.serverExitSignal, "SIGKILL");
  assert.ok(Date.now() - startedAt < 2_000);
});

test("write outside the declared scope fails closed and persists a privacy-safe receipt", async (t) => {
  const { cwd, codexHome, fake } = await fixture(t);
  await mkdir(join(cwd, "allowed"));
  const value = packet({
    writeScope: ["allowed"],
    requiredPermission: "workspace-write",
    responsibility: "implementation",
  });
  const result = await runAppServerRoot({
    policy: policy(codexHome),
    packet: value,
    cwd,
    codexHome,
    serverCommand: [process.execPath, fake],
    requestTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
    environment: {
      ...process.env,
      TEST_CODEX_HOME: codexHome,
      TEST_CWD: cwd,
      TEST_MUTATE_PATH: "outside.txt",
    },
  });
  assert.equal(result.status, "fail");
  assert.equal(result.receipt.value.reasonCode, "APP_SERVER_ROOT_SCOPE_FAILED");
  assert.equal(result.receipt.value.scope.verified, false);
  assert.doesNotMatch(await readFile(result.receipt.path, "utf8"), /outside\.txt/);
});

test("an empty directory created outside the declared scope also fails closed", async (t) => {
  const { cwd, codexHome, fake } = await fixture(t);
  await mkdir(join(cwd, "allowed"));
  const result = await runAppServerRoot({
    policy: policy(codexHome),
    packet: packet({
      writeScope: ["allowed"],
      requiredPermission: "workspace-write",
      responsibility: "implementation",
    }),
    cwd,
    codexHome,
    serverCommand: [process.execPath, fake],
    requestTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
    environment: {
      ...process.env,
      TEST_CODEX_HOME: codexHome,
      TEST_CWD: cwd,
      TEST_MUTATE_EMPTY_DIRECTORY: "outside-empty-directory",
    },
  });
  assert.equal(result.status, "fail");
  assert.equal(result.receipt.value.reasonCode, "APP_SERVER_ROOT_SCOPE_FAILED");
  assert.equal(result.receipt.value.scope.verified, false);
  assert.doesNotMatch(
    await readFile(result.receipt.path, "utf8"),
    /outside-empty-directory/,
  );
});

test("a new file and its required parent directories pass within exact write scope", async (t) => {
  const { cwd, codexHome, fake } = await fixture(t);
  const result = await runAppServerRoot({
    policy: policy(codexHome),
    packet: packet({
      writeScope: ["allowed/nested/new.txt"],
      requiredPermission: "workspace-write",
      responsibility: "implementation",
    }),
    cwd,
    codexHome,
    serverCommand: [process.execPath, fake],
    requestTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
    environment: {
      ...process.env,
      TEST_CODEX_HOME: codexHome,
      TEST_CWD: cwd,
      TEST_MUTATE_PATH: "allowed/nested/new.txt",
    },
  });
  assert.equal(result.status, "pass");
  assert.equal(result.receipt.value.scope.verified, true);
  assert.equal(result.receipt.value.scope.changedPathCount, 3);
});

test("disabled provider policy returns deterministic root-inline fallback without starting a host", async (t) => {
  const { cwd, codexHome } = await fixture(t);
  const disabledPolicy = createDispatchPolicy({
    mode: "active",
    allowTypedBridge: false,
    activation: {
      installId: "provider-test",
      recordPath: join(codexHome, "gearbox", "activations", "provider-test.json"),
    },
  });
  const result = await runAppServerRoot({
    policy: disabledPolicy,
    packet: packet(),
    cwd,
    codexHome,
    serverCommand: ["/definitely/not/executable"],
  });
  assert.equal(result.status, "fallback");
  assert.equal(result.decision.selectedShape, "root_inline");
  assert.equal(result.decision.provider.reasonCode, "APP_SERVER_ROOT_POLICY_DISABLED");
});

test("workflow policy rejection falls back without starting a host", async (t) => {
  const { cwd, codexHome } = await fixture(t);
  for (const value of [
    packet({ workflowAdapter: "unknown:fixture" }),
    packet({ workflowAdapter: "superpowers:writing-skills", ownerOptIn: false }),
  ]) {
    const result = await runAppServerRoot({
      policy: policy(codexHome),
      packet: value,
      cwd,
      codexHome,
      serverCommand: ["/definitely/not/executable"],
    });
    assert.equal(result.status, "fallback");
    assert.equal(result.decision.selectedShape, "root_inline");
    assert.equal(result.decision.workflowPolicy.pass, false);
    assert.equal(result.decision.provider.reasonCode, "APP_SERVER_ROOT_WORKFLOW_POLICY_REJECTED");
  }
});

test("scope validation rejects traversal and symlinked read roots", async (t) => {
  const { cwd } = await fixture(t);
  await assert.rejects(
    validateRootProviderScope({ cwd, packet: packet({ readScope: ["../escape"] }) }),
    /scope/,
  );
});
