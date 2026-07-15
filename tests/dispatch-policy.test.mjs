import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertManagedPolicyTarget,
  createDispatchPolicy,
  DISPATCH_POLICY_RELATIVE_PATH,
  loadDispatchPolicy,
  serializeDispatchPolicy,
  validateDispatchPolicy,
} from "../lib/dispatch-policy.mjs";

function activePolicy() {
  return createDispatchPolicy({
    mode: "active",
    allowTypedBridge: false,
    activation: {
      installId: "20260714-example",
      recordPath: "/tmp/example/gearbox/activations/20260714-example.json",
    },
  });
}

function legacyActivePolicy() {
  return createDispatchPolicy({
    mode: "active",
    allowTypedBridge: false,
    activation: {
      installId: "20260714-legacy",
      manifestPath: "/tmp/example/reports/install-manifest.json",
    },
  });
}

function appServerActivePolicy() {
  return createDispatchPolicy({
    mode: "active",
    allowTypedBridge: false,
    activation: {
      installId: "20260716-app-server",
      recordPath: "/tmp/example/gearbox/activations/20260716-app-server.json",
    },
    rootProvider: {
      kind: "app_server_root",
      enabled: true,
      transport: "stdio",
      protocolVersion: 1,
      launcherPath: "/tmp/example/bin/gearbox-root",
      acceptanceBindingSha256: "e".repeat(64),
    },
  });
}

async function writePolicy(root, value) {
  const path = join(root, "dispatch-policy.json");
  await writeFile(path, `${JSON.stringify(value)}\n`);
  return path;
}

test("active policy is canonical, integrity-bound, and bridge-disabled", () => {
  const policy = activePolicy();
  assert.equal(validateDispatchPolicy(policy).pass, true);
  assert.equal(policy.managedBy, "sol-ultra-gearbox-v2");
  assert.equal(policy.mode, "active");
  assert.equal(policy.allowTypedBridge, false);
  assert.match(policy.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    serializeDispatchPolicy(policy),
    `${JSON.stringify({
      activation: policy.activation,
      allowTypedBridge: false,
      managedBy: "sol-ultra-gearbox-v2",
      mode: "active",
      schemaVersion: 1,
      sha256: policy.sha256,
    })}\n`,
  );
  assert.equal(DISPATCH_POLICY_RELATIVE_PATH, "gearbox/dispatch-policy.json");
});

test("validation rejects fields and modes outside the integrity schema", () => {
  const policy = activePolicy();
  const cases = [
    { ...policy, extra: true },
    { ...policy, mode: "preview" },
    { ...policy, allowTypedBridge: true },
    { ...policy, activation: { ...policy.activation, recordPath: "relative.json" } },
    {
      ...policy,
      activation: {
        ...policy.activation,
        manifestPath: "/tmp/example/reports/install-manifest.json",
      },
    },
    { ...policy, activation: null },
    createDispatchPolicy({ mode: "shadow", allowTypedBridge: false, activation: null }),
  ];
  cases[6] = { ...cases[6], activation: policy.activation };
  for (const value of cases) assert.equal(validateDispatchPolicy(value).pass, false);
});

test("legacy manifest activation remains readable during the re-activation gap", () => {
  const policy = legacyActivePolicy();
  assert.equal(validateDispatchPolicy(policy).pass, true);
  assert.deepEqual(assertManagedPolicyTarget(serializeDispatchPolicy(policy)), policy);
});

test("policy v2 integrity-binds an active App Server root launcher", () => {
  const policy = appServerActivePolicy();
  assert.equal(policy.schemaVersion, 2);
  assert.equal(validateDispatchPolicy(policy).pass, true);
  assert.deepEqual(assertManagedPolicyTarget(serializeDispatchPolicy(policy)), policy);
  for (const rootProvider of [
    { ...policy.rootProvider, enabled: false },
    { ...policy.rootProvider, kind: "app_thread_root" },
    { ...policy.rootProvider, transport: "tcp" },
    { ...policy.rootProvider, launcherPath: "relative" },
    { ...policy.rootProvider, acceptanceBindingSha256: "invalid" },
  ]) {
    assert.equal(validateDispatchPolicy({ ...policy, rootProvider }).pass, false);
  }
});

test("missing, malformed, and tampered policy files resolve off", async () => {
  const root = await mkdtemp(join(tmpdir(), "gearbox-policy-test-"));
  assert.equal((await loadDispatchPolicy(join(root, "missing.json"))).state, "off");

  const parseErrorPath = join(root, "parse-error.json");
  await writeFile(parseErrorPath, "{not-json\n");
  assert.equal((await loadDispatchPolicy(parseErrorPath)).state, "off");

  const malformedPath = await writePolicy(root, "not-an-object");
  assert.equal((await loadDispatchPolicy(malformedPath)).state, "off");

  const policy = activePolicy();
  const path = await writePolicy(root, { ...policy, mode: "shadow" });
  const loaded = await loadDispatchPolicy(path);
  assert.equal(loaded.state, "off");
  assert.equal(loaded.policy, null);
  assert.match(loaded.error, /integrity/);
});

test("load fails closed for invalid activation, shadow activation, and unsupported bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "gearbox-policy-test-"));
  const active = activePolicy();
  const shadow = createDispatchPolicy({
    mode: "shadow",
    allowTypedBridge: false,
    activation: null,
  });
  const cases = [
    { ...active, activation: null },
    { ...shadow, activation: active.activation },
    { ...active, allowTypedBridge: true },
  ];
  for (const value of cases) {
    const path = await writePolicy(root, value);
    const loaded = await loadDispatchPolicy(path);
    assert.equal(loaded.state, "off");
    assert.equal(loaded.policy, null);
  }
});

test("apply allows an absent target and refuses unmanaged or invalid targets", () => {
  assert.equal(assertManagedPolicyTarget(null), null);
  assert.deepEqual(assertManagedPolicyTarget(serializeDispatchPolicy(activePolicy())), activePolicy());
  assert.throws(
    () => assertManagedPolicyTarget('{"mode":"active"}\n'),
    /unmanaged dispatch policy/,
  );
  assert.throws(
    () => assertManagedPolicyTarget('{broken json'),
    /unmanaged dispatch policy/,
  );
});
