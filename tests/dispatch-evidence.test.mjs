import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyDispatchFailure,
  validateDispatchResult,
  verifyIsolatedRoot,
  verifyTypedChildResult,
} from "../lib/dispatch-evidence.mjs";

const taskHash = "a".repeat(64);
const roleHash = "b".repeat(64);
const roleSpec = {
  name: "terra_explorer",
  model: "gpt-5.6-terra",
  effort: "medium",
  sandbox: "read-only",
};
const decision = {
  selectedShape: "isolated_role_root",
  role: roleSpec.name,
  reasonCode: "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH",
  taskHash,
  roleHash,
};
const requiredChecks = {
  runtimePersisted: true,
  modelMatches: true,
  effortMatches: true,
  sandboxMatches: true,
  taskHashMatches: true,
  roleHashMatches: true,
  depthMatches: true,
  noDescendants: true,
  filesystemScope: true,
  commandExitedZero: true,
  commandDidNotTimeout: true,
  cleanupPassed: true,
  deliverableValid: true,
};

function resultFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "dispatch_result",
    pass: true,
    taskHash,
    executionShape: decision.selectedShape,
    role: decision.role,
    reasonCode: decision.reasonCode,
    expected: {
      model: roleSpec.model,
      effort: roleSpec.effort,
      sandbox: roleSpec.sandbox,
      depth: 0,
      roleHash,
    },
    actual: {
      model: roleSpec.model,
      effort: roleSpec.effort,
      sandbox: roleSpec.sandbox,
      depth: 0,
      parentTokens: 100,
      childTokens: null,
      nativeAgentRole: null,
    },
    checks: { ...requiredChecks },
    changedFiles: [],
    retryCount: 0,
    rollbackRequired: false,
    synthetic: true,
    ...overrides,
  };
}

function typedFixtures(role = roleSpec) {
  return {
    parent: {
      sessionMeta: { id: "parent-session" },
      turnContext: {},
      functionCalls: [
        {
          name: "spawn_agent",
          args: {
            agent_type: role.name,
            task_name: "bounded",
            fork_turns: "none",
            message: "bounded task",
          },
        },
      ],
      tokenUsage: { total_tokens: 100 },
    },
    child: {
      sessionMeta: {
        agent_role: role.name,
        source: { subagent: { thread_spawn: { depth: 1, parent_thread_id: "parent-session" } } },
      },
      turnContext: {
        model: role.model,
        effort: role.effort,
        sandbox_policy: { type: role.sandbox },
      },
      functionCalls: [],
      tokenUsage: { total_tokens: 50 },
    },
  };
}

test("validateDispatchResult accepts only the exact complete envelope", () => {
  assert.equal(
    validateDispatchResult({
      result: resultFixture(),
      decision,
      roleSpec,
    }).pass,
    true,
  );
});

test("validateDispatchResult rejects missing and drifting evidence", () => {
  const cases = [
    ["missing runtime metadata", { actual: undefined }],
    ["model drift", { actual: { ...resultFixture().actual, model: "wrong" } }],
    ["effort drift", { actual: { ...resultFixture().actual, effort: "high" } }],
    ["sandbox drift", { actual: { ...resultFixture().actual, sandbox: "workspace-write" } }],
    ["role hash drift", { expected: { ...resultFixture().expected, roleHash: "c".repeat(64) } }],
    ["task hash drift", { taskHash: "d".repeat(64) }],
    [
      "depth drift",
      {
        expected: { ...resultFixture().expected, depth: 1 },
        actual: { ...resultFixture().actual, depth: 1 },
      },
    ],
    ["descendant spawn", { checks: { ...requiredChecks, noDescendants: false } }],
    ["read-only write", { checks: { ...requiredChecks, filesystemScope: false } }],
    ["timeout", { checks: { ...requiredChecks, commandDidNotTimeout: false } }],
    ["cleanup failure", { checks: { ...requiredChecks, cleanupPassed: false } }],
    ["forged negative parent tokens", { actual: { ...resultFixture().actual, parentTokens: -1 } }],
    ["extra field", { extra: true }],
  ];
  for (const [name, overrides] of cases) {
    const result = validateDispatchResult({
      result: resultFixture(overrides),
      decision,
      roleSpec,
    });
    assert.equal(result.pass, false, name);
  }
});

test("validateDispatchResult rejects forged typed-child token totals", () => {
  const typedDecision = { ...decision, selectedShape: "typed_child" };
  const typedResult = resultFixture({
    executionShape: "typed_child",
    expected: { ...resultFixture().expected, depth: 1 },
    actual: {
      ...resultFixture().actual,
      depth: 1,
      childTokens: -1,
      nativeAgentRole: roleSpec.name,
    },
  });
  assert.equal(
    validateDispatchResult({ result: typedResult, decision: typedDecision, roleSpec }).pass,
    false,
  );
});

test("verifyIsolatedRoot enforces a zero-spawn isolated root", () => {
  const summary = {
    sessionMeta: { agent_role: null },
    threadSource: "root",
    sessionId: "in-memory-only",
    turnContext: {
      model: roleSpec.model,
      effort: roleSpec.effort,
      sandbox_policy: { type: roleSpec.sandbox },
    },
    functionCalls: [],
    tokenUsage: { total_tokens: 100 },
  };
  const result = verifyIsolatedRoot({
    summary,
    decision,
    roleSpec,
    roleHash,
    before: { changedFiles: [] },
    after: { changedFiles: [] },
    cleanup: { passed: true, commandExitedZero: true, timedOut: false },
  });
  assert.equal(result.pass, true);
  assert.equal(result.actual.nativeAgentRole, null);
  assert.equal(result.actual.childTokens, null);

  const invalid = verifyIsolatedRoot({
    summary: { ...summary, functionCalls: [{ name: "spawn_agent", args: {} }] },
    decision,
    roleSpec,
    roleHash,
    before: { changedFiles: [] },
    after: { changedFiles: ["write.txt"] },
    cleanup: { passed: false, commandExitedZero: false, timedOut: true },
  });
  assert.equal(invalid.pass, false);
  assert.equal(invalid.checks.noDescendants, false);
  assert.equal(invalid.checks.filesystemScope, false);
  assert.equal(invalid.checks.commandDidNotTimeout, false);
  assert.equal(invalid.checks.cleanupPassed, false);

  const subagent = verifyIsolatedRoot({
    summary: { ...summary, threadSource: "subagent" },
    decision,
    roleSpec,
    roleHash,
    before: { changedFiles: [] },
    after: { changedFiles: [] },
    cleanup: { passed: true, commandExitedZero: true, timedOut: false },
  });
  assert.equal(subagent.pass, false);
  assert.equal(subagent.checks.runtimePersisted, false);

  const missingSource = verifyIsolatedRoot({
    summary: { ...summary, threadSource: null },
    decision,
    roleSpec,
    roleHash,
    before: { changedFiles: [] },
    after: { changedFiles: [] },
    cleanup: { passed: true, commandExitedZero: true, timedOut: false },
  });
  assert.equal(missingSource.pass, false);
  assert.equal(missingSource.checks.runtimePersisted, false);

  const wrongShape = verifyIsolatedRoot({
    summary,
    decision: { ...decision, selectedShape: "root_inline" },
    roleSpec,
    roleHash,
    before: { changedFiles: [] },
    after: { changedFiles: [] },
    cleanup: { passed: true, commandExitedZero: true, timedOut: false },
  });
  assert.equal(wrongShape.pass, false);
});

test("verifyTypedChildResult requires exact typed single-parent lineage", () => {
  const typedDecision = {
    ...decision,
    selectedShape: "typed_child",
  };
  const { parent, child } = typedFixtures();
  const result = verifyTypedChildResult({
    parent,
    child,
    decision: typedDecision,
    roleSpec,
    roleHash,
    before: { changedFiles: [] },
    after: { changedFiles: [] },
    cleanup: { passed: true, commandExitedZero: true, timedOut: false },
  });
  assert.equal(result.pass, true);
  assert.equal(result.actual.parentTokens, 100);
  assert.equal(result.actual.childTokens, 50);

  const invalid = verifyTypedChildResult({
    parent: { ...parent, functionCalls: parent.functionCalls.concat(parent.functionCalls) },
    child: { ...child, functionCalls: [{ name: "spawn_agent", args: {} }] },
    decision: typedDecision,
    roleSpec,
    roleHash,
    before: { changedFiles: [] },
    after: { changedFiles: [] },
    cleanup: { passed: true, commandExitedZero: true, timedOut: false },
  });
  assert.equal(invalid.pass, false);
  assert.equal(invalid.checks.noDescendants, false);

  const wrongShape = verifyTypedChildResult({
    parent,
    child,
    decision: { ...typedDecision, selectedShape: "isolated_role_root" },
    roleSpec,
    roleHash,
    before: { changedFiles: [] },
    after: { changedFiles: [] },
    cleanup: { passed: true, commandExitedZero: true, timedOut: false },
  });
  assert.equal(wrongShape.pass, false);
});

test("verifyTypedChildResult rejects mismatched or missing parent lineage", () => {
  const typedDecision = { ...decision, selectedShape: "typed_child" };
  const { parent, child } = typedFixtures();
  for (const childVariant of [
    {
      ...child,
      sessionMeta: {
        ...child.sessionMeta,
        source: { subagent: { thread_spawn: { depth: 1, parent_thread_id: "other-session" } } },
      },
    },
    {
      ...child,
      sessionMeta: {
        ...child.sessionMeta,
        source: { subagent: { thread_spawn: { depth: 1 } } },
      },
    },
  ]) {
    const result = verifyTypedChildResult({
      parent,
      child: childVariant,
      decision: typedDecision,
      roleSpec,
      roleHash,
      before: { changedFiles: [] },
      after: { changedFiles: [] },
      cleanup: { passed: true, commandExitedZero: true, timedOut: false },
    });
    assert.equal(result.pass, false);
  }
});

test("verifyTypedChildResult enforces read-only and writer file scopes", () => {
  const typedDecision = { ...decision, selectedShape: "typed_child" };
  const readOnly = typedFixtures();
  const readOnlyWrite = verifyTypedChildResult({
    ...readOnly,
    decision: typedDecision,
    roleSpec,
    roleHash,
    before: { changedFiles: [] },
    after: { changedFiles: ["write.txt"] },
    cleanup: { passed: true, commandExitedZero: true, timedOut: false },
  });
  assert.equal(readOnlyWrite.pass, false);
  assert.equal(readOnlyWrite.checks.filesystemScope, false);

  const writer = {
    ...roleSpec,
    name: "terra_worker",
    effort: "high",
    sandbox: "workspace-write",
  };
  const writerDecision = { ...typedDecision, role: writer.name };
  const writerRun = typedFixtures(writer);
  const base = {
    ...writerRun,
    decision: writerDecision,
    roleSpec: writer,
    roleHash,
    before: { changedFiles: [] },
    cleanup: { passed: true, commandExitedZero: true, timedOut: false },
  };
  assert.equal(
    verifyTypedChildResult({ ...base, after: { changedFiles: ["src/a.mjs"] } }).pass,
    false,
    "writer scope is required",
  );
  assert.equal(
    verifyTypedChildResult({
      ...base,
      allowedWriteScope: ["src"],
      after: { changedFiles: ["test/a.mjs"] },
    }).pass,
    false,
    "writer out-of-scope file is rejected",
  );
  assert.equal(
    verifyTypedChildResult({
      ...base,
      allowedWriteScope: ["src"],
      after: { changedFiles: ["src/a.mjs"] },
    }).pass,
    true,
    "writer in-scope file is accepted",
  );
});

test("classifyDispatchFailure allows only the first deliverable correction", () => {
  assert.deepEqual(
    classifyDispatchFailure(resultFixture({ checks: { ...requiredChecks, filesystemScope: false } })),
    { retryAllowed: false, fallbackReason: "ROOT_PERMISSION_VIOLATION", rollbackRequired: true },
  );
  assert.deepEqual(
    classifyDispatchFailure(resultFixture({ checks: { ...requiredChecks, modelMatches: false } })),
    { retryAllowed: false, fallbackReason: "ROOT_RUNTIME_EVIDENCE_FAILED", rollbackRequired: true },
  );
  assert.deepEqual(
    classifyDispatchFailure(resultFixture({ checks: { ...requiredChecks, deliverableValid: false } })),
    { retryAllowed: true, fallbackReason: "ROOT_CHILD_RESULT_REJECTED", rollbackRequired: false },
  );
  assert.deepEqual(
    classifyDispatchFailure(resultFixture({ retryCount: 1, checks: { ...requiredChecks, deliverableValid: false } })),
    { retryAllowed: false, fallbackReason: "ROOT_RETRY_BUDGET_EXHAUSTED", rollbackRequired: false },
  );
  assert.deepEqual(
    classifyDispatchFailure(resultFixture()),
    { retryAllowed: false, fallbackReason: null, rollbackRequired: false },
  );
});

test("deliverable-only rejection does not require rollback", () => {
  const result = verifyIsolatedRoot({
    summary: {
      sessionMeta: { agent_role: null },
      threadSource: "root",
      turnContext: {
        model: roleSpec.model,
        effort: roleSpec.effort,
        sandbox_policy: { type: roleSpec.sandbox },
      },
      functionCalls: [],
      tokenUsage: { total_tokens: 1 },
    },
    decision: { ...decision, selectedShape: "root_inline" },
    roleSpec,
    roleHash,
    before: { changedFiles: [] },
    after: { changedFiles: [] },
    cleanup: { passed: true, commandExitedZero: true, timedOut: false },
  });
  assert.equal(result.checks.deliverableValid, false);
  assert.equal(result.rollbackRequired, false);
});
