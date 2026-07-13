import assert from "node:assert/strict";
import test from "node:test";
import {
  SMOKE_REUSE_TTL_MS,
  createRuntimeBinding,
  validateSddAdapterEvidence,
  validateTrustedSmoke,
} from "../lib/runtime-evidence.mjs";

const EXPECTED_ROLES = Object.freeze([
  {
    name: "luna_clerk",
    model: "gpt-5.6-luna",
    effort: "low",
    sandbox: "read-only",
  },
  {
    name: "terra_worker",
    model: "gpt-5.6-terra",
    effort: "high",
    sandbox: "workspace-write",
  },
]);
const EXPECTED_ROOT = Object.freeze({ model: "gpt-5.6-sol", effort: "max" });

function binding(overrides = {}) {
  return createRuntimeBinding({
    gitHead: "a".repeat(40),
    gitStatus: "",
    codexVersion: "codex-cli 1.2.3",
    configSha256: "b".repeat(64),
    roleHashes: {
      luna_clerk: "c".repeat(64),
      terra_worker: "d".repeat(64),
    },
    runtimeHashes: {
      "lib/gearbox.mjs": "e".repeat(64),
      "scripts/gearbox.mjs": "f".repeat(64),
    },
    ...overrides,
  });
}

function report(runtimeBinding = binding(), overrides = {}) {
  const generatedAt = new Date("2026-07-13T04:00:00.000Z").toISOString();
  const roles = EXPECTED_ROLES.map((spec) => ({
    role: spec.name,
    pass: true,
    expected: {
      parentModel: "gpt-5.6-sol",
      parentEffort: "max",
      model: spec.model,
      effort: spec.effort,
      sandbox: spec.sandbox,
      depth: 1,
      forkTurns: "none",
    },
    actual: {
      parentModel: "gpt-5.6-sol",
      parentEffort: "max",
      role: spec.name,
      model: spec.model,
      effort: spec.effort,
      sandbox: spec.sandbox,
      depth: 1,
      parentTokenUsage: { total_tokens: 100 },
      tokenUsage: { total_tokens: 50 },
    },
    checks: Object.fromEntries(
      [
        "parentPersisted",
        "childPersisted",
        "parentModelMatches",
        "parentEffortMatches",
        "exactlyOneSpawn",
        "typedRoleRequested",
        "forkTurnsNone",
        "taskMessagePresent",
        "noModelOverride",
        "noEffortOverride",
        "noServiceTierOverride",
        "roleMatches",
        "modelMatches",
        "effortMatches",
        "sandboxMatches",
        "depthOne",
        "noDescendantSpawn",
        "parentTokenUsagePersisted",
        "tokenUsagePersisted",
        "markerReturned",
      ].map((name) => [name, true]),
    ),
    runtimeChecks: {
      commandExitedZero: true,
      commandDidNotTimeout: true,
      noReservedSchemaMismatch: true,
      filesystemScope: true,
      temporaryArtifactsCleaned: true,
    },
    command: { exitCode: 0, timedOut: false, schemaMismatch: false },
    cleanup: { pass: true },
  }));
  return {
    schemaVersion: 2,
    generatedAt,
    pass: true,
    expectedRoleCount: 2,
    rootRuntime: { model: "gpt-5.6-sol", effort: "max", verified: true },
    globalConfigUnchanged: true,
    globalConfigBeforeSha256: runtimeBinding.configSha256,
    globalConfigAfterSha256: runtimeBinding.configSha256,
    runtimeBinding,
    runtimeBindingAfterSha256: runtimeBinding.sha256,
    runtimeBindingStable: true,
    roles,
    ...overrides,
  };
}

test("trusted smoke accepts an exact, recent, clean runtime binding", () => {
  const current = binding();
  const result = validateTrustedSmoke({
    report: report(current),
    currentBinding: current,
    expectedRoles: EXPECTED_ROLES,
    expectedRoot: EXPECTED_ROOT,
    nowMs: Date.parse("2026-07-13T04:10:00.000Z"),
  });
  assert.equal(result.pass, true);
  assert.equal(result.ttlMs, SMOKE_REUSE_TTL_MS);
  assert.equal(result.ageMs, 10 * 60 * 1000);
});

test("trusted smoke fails closed after TTL or with a dirty tree", () => {
  const current = binding();
  const stale = validateTrustedSmoke({
    report: report(current),
    currentBinding: current,
    expectedRoles: EXPECTED_ROLES,
    expectedRoot: EXPECTED_ROOT,
    nowMs: Date.parse("2026-07-13T04:31:00.000Z"),
  });
  assert.equal(stale.pass, false);
  assert.equal(stale.checks.withinTtl, false);

  const dirty = binding({ gitStatus: " M lib/gearbox.mjs\n" });
  const dirtyResult = validateTrustedSmoke({
    report: report(dirty),
    currentBinding: dirty,
    expectedRoles: EXPECTED_ROLES,
    expectedRoot: EXPECTED_ROOT,
    nowMs: Date.parse("2026-07-13T04:10:00.000Z"),
  });
  assert.equal(dirtyResult.pass, false);
  assert.equal(dirtyResult.checks.currentTreeClean, false);
});

test("trusted smoke rejects config, Codex, role, runtime, and commit drift", () => {
  const original = binding();
  const variants = [
    binding({ gitHead: "1".repeat(40) }),
    binding({ codexVersion: "codex-cli 9.9.9" }),
    binding({ configSha256: "2".repeat(64) }),
    binding({ roleHashes: { luna_clerk: "3".repeat(64) } }),
    binding({ runtimeHashes: { "scripts/gearbox.mjs": "4".repeat(64) } }),
  ];
  for (const currentBinding of variants) {
    const result = validateTrustedSmoke({
      report: report(original),
      currentBinding,
      expectedRoles: EXPECTED_ROLES,
      expectedRoot: EXPECTED_ROOT,
      nowMs: Date.parse("2026-07-13T04:10:00.000Z"),
    });
    assert.equal(result.pass, false);
    assert.equal(result.checks.bindingMatchesCurrent, false);
  }
});

test("trusted smoke rejects tampering and incomplete runtime evidence", () => {
  const current = binding();
  const tampered = { ...current, codexVersion: "codex-cli tampered" };
  const cases = [
    report(tampered),
    report(current, { pass: false }),
    report(current, { rootRuntime: { verified: false } }),
    report(current, { roles: [{ pass: true }] }),
    report(current, { runtimeBindingStable: false }),
    report(current, { runtimeBindingAfterSha256: "0".repeat(64) }),
    report(current, { schemaVersion: 1 }),
  ];
  for (const candidate of cases) {
    assert.equal(
      validateTrustedSmoke({
        report: candidate,
        currentBinding: current,
        expectedRoles: EXPECTED_ROLES,
        expectedRoot: EXPECTED_ROOT,
        nowMs: Date.parse("2026-07-13T04:10:00.000Z"),
      }).pass,
      false,
    );
  }
});

function sddPhase(role, overrides = {}) {
  const expected =
    role === "terra_worker"
      ? { model: "gpt-5.6-terra", effort: "high", sandbox: "workspace-write" }
      : { model: "gpt-5.6-sol", effort: "high", sandbox: "read-only" };
  return {
    role,
    pass: true,
    startedAt: role === "terra_worker" ? "2026-07-13T04:00:00.000Z" : "2026-07-13T04:02:00.000Z",
    completedAt: role === "terra_worker" ? "2026-07-13T04:01:00.000Z" : "2026-07-13T04:03:00.000Z",
    actual: {
      role,
      parentModel: "gpt-5.6-sol",
      parentEffort: "max",
      ...expected,
      depth: 1,
      parentTokenUsage: { total_tokens: 100 },
      tokenUsage: { total_tokens: 50 },
    },
    checks: Object.fromEntries(
      [
        "parentPersisted",
        "childPersisted",
        "parentModelMatches",
        "parentEffortMatches",
        "exactlyOneSpawn",
        "typedRoleRequested",
        "forkTurnsNone",
        "taskMessagePresent",
        "noModelOverride",
        "noEffortOverride",
        "noServiceTierOverride",
        "roleMatches",
        "modelMatches",
        "effortMatches",
        "sandboxMatches",
        "depthOne",
        "noDescendantSpawn",
        "parentTokenUsagePersisted",
        "tokenUsagePersisted",
        "markerReturned",
      ].map((name) => [name, true]),
    ),
    runtimeChecks: {
      commandExitedZero: true,
      commandDidNotTimeout: true,
      noReservedSchemaMismatch: true,
      filesystemScope: true,
      temporaryArtifactsCleaned: true,
    },
    command: { exitCode: 0, timedOut: false, schemaMismatch: false },
    cleanup: { pass: true },
    ...overrides,
  };
}

test("SDD adapter evidence requires sequential worker and read-only reviewer phases", () => {
  const runtimeBinding = binding();
  const value = {
    schemaVersion: 1,
    kind: "sdd_adapter_contract",
    generatedAt: "2026-07-13T04:03:01.000Z",
    pass: true,
    globalConfigUnchanged: true,
    globalConfigBeforeSha256: runtimeBinding.configSha256,
    globalConfigAfterSha256: runtimeBinding.configSha256,
    runtimeBinding,
    runtimeBindingAfterSha256: runtimeBinding.sha256,
    runtimeBindingStable: true,
    phases: [sddPhase("terra_worker"), sddPhase("sol_reviewer")],
    sequenceChecks: {
      workerCompletedBeforeReview: true,
      workerChangedOnlyTarget: true,
      reviewerObservedFinalState: true,
      reviewerChangedNoFiles: true,
    },
    cleanup: { pass: true },
    boundary: {
      workflow: "superpowers:subagent-driven-development",
      verification: "adapter_contract",
      codexCoreHookTested: false,
      permissionStrategy: "sequential_isolated_roots",
    },
  };
  assert.equal(validateSddAdapterEvidence(value).pass, true);

  const parallelized = {
    ...value,
    phases: [
      sddPhase("terra_worker", { completedAt: "2026-07-13T04:03:00.000Z" }),
      sddPhase("sol_reviewer"),
    ],
  };
  assert.equal(validateSddAdapterEvidence(parallelized).pass, false);

  const broadReviewer = {
    ...value,
    phases: [
      sddPhase("terra_worker"),
      sddPhase("sol_reviewer", {
        actual: {
          ...sddPhase("sol_reviewer").actual,
          sandbox: "workspace-write",
        },
      }),
    ],
  };
  assert.equal(validateSddAdapterEvidence(broadReviewer).pass, false);
});
