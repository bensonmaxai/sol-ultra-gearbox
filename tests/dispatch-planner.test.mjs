import assert from "node:assert/strict";
import test from "node:test";
import { ROLE_SPECS } from "../lib/gearbox.mjs";
import {
  hashTaskPacket,
  planDispatch,
  renderTaskMessage,
  validateTaskPacket,
} from "../lib/dispatch-planner.mjs";
import { compileStagePacket } from "../lib/workflow-compiler.mjs";
import { hashWorkflowPlan } from "../lib/workflow-plan.mjs";
import { workflowPlan } from "./helpers/workflow-fixtures.mjs";

function packet(overrides = {}) {
  return {
    schemaVersion: 1,
    workflowAdapter: "direct",
    responsibility: "exploration",
    goal: "Trace the fixture request path",
    readScope: ["fixtures/src", "fixtures/tests"],
    writeScope: [],
    knownFacts: ["The fixture has two modules"],
    constraints: ["No writes"],
    deliverable: "Structured path evidence",
    successCriteria: ["Every hop names a file and symbol"],
    checks: ["Confirm at least five files were inspected"],
    prohibitedActions: ["Do not spawn descendants"],
    parentPermission: "workspace-write",
    requiredPermission: "read-only",
    requiresNativeLineage: false,
    requestedRole: null,
    ownerOptIn: false,
    legacyAdapter: false,
    batch: {
      requestedChildren: 1,
      writerCount: 0,
      scopesDisjoint: true,
    },
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

const ACTIVE = { mode: "active", allowTypedBridge: false };
const CAPABILITIES = {
  agentTypeVisible: true,
  isolatedRunnerVerified: true,
  runtimeMetadataAvailable: true,
  bridgeRuntimeVerified: false,
  permissionBypassActive: false,
};

function plan(value, overrides = {}) {
  return planDispatch({
    policy: ACTIVE,
    packet: value,
    capabilities: CAPABILITIES,
    roleSpecs: ROLE_SPECS,
    ...overrides,
  });
}

test("valid packet selects an isolated Terra root for read-only permission mismatch", () => {
  assert.equal(validateTaskPacket(packet()).pass, true);
  const decision = plan(packet());
  assert.equal(decision.selectedShape, "isolated_role_root");
  assert.equal(decision.effectiveShape, "isolated_role_root");
  assert.equal(decision.role, "terra_explorer");
  assert.equal(decision.responsibility, "exploration");
  assert.equal(
    decision.reasonCode,
    "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH",
  );
  assert.equal(decision.spawnArgs, null);
  assert.equal(decision.requiresRuntimeEvidence, true);
});

test("executing-plans is a known adapter for bounded delegated phases", () => {
  const decision = plan(packet({
    workflowAdapter: "superpowers:executing-plans",
  }));
  assert.equal(decision.selectedShape, "isolated_role_root");
  assert.equal(decision.reasonCode, "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH");
});

test("writing-skills uses only the owner-approved isolated Sol pressure tester", () => {
  const value = packet({
    workflowAdapter: "superpowers:writing-skills",
    responsibility: "skill_testing",
    requestedRole: "sol_skill_tester",
    ownerOptIn: true,
  });
  const decision = plan(value);
  assert.equal(decision.selectedShape, "isolated_role_root");
  assert.equal(decision.effectiveShape, "isolated_role_root");
  assert.equal(decision.role, "sol_skill_tester");
  assert.equal(decision.reasonCode, "DELEGATE_ISOLATED_SKILL_PRESSURE_TEST");
  assert.equal(decision.spawnArgs, null);
  assert.equal(decision.requiresRuntimeEvidence, true);

  const noNativeSchema = plan(value, {
    capabilities: { ...CAPABILITIES, agentTypeVisible: false },
  });
  assert.equal(noNativeSchema.selectedShape, "isolated_role_root");
  assert.equal(noNativeSchema.reasonCode, "DELEGATE_ISOLATED_SKILL_PRESSURE_TEST");
});

test("writing-skills pressure testing fails closed without exact approval and runner facts", () => {
  const base = packet({
    workflowAdapter: "superpowers:writing-skills",
    responsibility: "skill_testing",
    requestedRole: "sol_skill_tester",
    ownerOptIn: true,
  });
  const cases = [
    [packet({ ...base, ownerOptIn: false }), "ROOT_OWNER_APPROVAL_REQUIRED", CAPABILITIES],
    [packet({ ...base, requestedRole: "sol_reviewer" }), "ROOT_SCOPE_AMBIGUOUS", CAPABILITIES],
    [packet({ ...base, writeScope: ["SKILL.md"] }), "ROOT_SCOPE_AMBIGUOUS", CAPABILITIES],
    [packet({ ...base, legacyAdapter: true }), "ROOT_SCOPE_AMBIGUOUS", CAPABILITIES],
    [base, "ROOT_ISOLATED_RUNNER_UNAVAILABLE", { ...CAPABILITIES, isolatedRunnerVerified: false }],
  ];
  for (const [candidate, reasonCode, capabilities] of cases) {
    const decision = plan(candidate, { capabilities });
    assert.equal(decision.selectedShape, "root_inline");
    assert.equal(decision.reasonCode, reasonCode);
  }
});

test("isolated skill tester cannot be requested by generic or unrelated adapters", () => {
  for (const workflowAdapter of [
    "direct",
    "superpowers:executing-plans",
    "superpowers:subagent-driven-development",
  ]) {
    const decision = plan(packet({
      workflowAdapter,
      responsibility: "skill_testing",
      requestedRole: "sol_skill_tester",
      ownerOptIn: true,
    }));
    assert.equal(decision.selectedShape, "root_inline");
    assert.equal(decision.reasonCode, "ROOT_SCOPE_AMBIGUOUS");
  }
});

test("verified isolated reads do not require the native child schema", () => {
  const decision = plan(packet(), {
    capabilities: {
      ...CAPABILITIES,
      agentTypeVisible: false,
      isolatedRunnerVerified: true,
    },
  });
  assert.equal(decision.selectedShape, "isolated_role_root");
  assert.equal(decision.effectiveShape, "isolated_role_root");
  assert.equal(decision.reasonCode, "DELEGATE_ISOLATED_SCHEMA_UNAVAILABLE");
  assert.equal(decision.spawnArgs, null);
});

test("missing native schema never promotes an implementation writer to an isolated root", () => {
  const value = packet({
    responsibility: "implementation",
    requiredPermission: "workspace-write",
    writeScope: ["fixtures/src/fix.mjs", "fixtures/tests/fix.test.mjs"],
    parentPermission: "workspace-write",
    batch: {
      requestedChildren: 1,
      writerCount: 1,
      scopesDisjoint: true,
    },
    costSignals: {
      ...packet().costSignals,
      includesRegressionTest: true,
      boundedFileCount: 2,
    },
  });
  const decision = plan(value, {
    capabilities: {
      ...CAPABILITIES,
      agentTypeVisible: false,
      isolatedRunnerVerified: true,
    },
  });
  assert.equal(decision.selectedShape, "root_inline");
  assert.equal(decision.reasonCode, "ROOT_SCHEMA_UNAVAILABLE");
});

test("missing native schema never satisfies a native-lineage requirement with an isolated root", () => {
  const value = packet({
    parentPermission: "read-only",
    requiresNativeLineage: true,
  });
  const capabilities = {
    ...CAPABILITIES,
    agentTypeVisible: false,
    isolatedRunnerVerified: true,
  };
  const decision = plan(value, {
    capabilities,
  });
  assert.equal(decision.selectedShape, "root_inline");
  assert.equal(decision.reasonCode, "ROOT_BRIDGE_DISABLED");

  const bridged = plan(value, {
    policy: { mode: "active", allowTypedBridge: true },
    capabilities: {
      ...capabilities,
      bridgeRuntimeVerified: true,
    },
  });
  assert.equal(bridged.selectedShape, "typed_child_bridge");
  assert.equal(bridged.reasonCode, "DELEGATE_BRIDGE_LINEAGE_REQUIRED");
});

test("planner keeps trivial, risky, unknown, and writer-mismatch work on Sol", () => {
  const cases = [
    [packet({ costSignals: { ...packet().costSignals, estimatedRootToolCalls: 2 } }), "ROOT_TRIVIAL"],
    [packet({ riskSignals: { ...packet().riskSignals, highRisk: true } }), "ROOT_HIGH_RISK"],
    [packet({ workflowAdapter: "unknown:fanout" }), "ROOT_UNKNOWN_SKILL"],
    [
      packet({
        responsibility: "implementation",
        requiredPermission: "workspace-write",
        writeScope: ["fixtures/src/fix.mjs", "fixtures/tests/fix.test.mjs"],
        costSignals: {
          ...packet().costSignals,
          includesRegressionTest: true,
          boundedFileCount: 2,
        },
        batch: {
          requestedChildren: 1,
          writerCount: 1,
          scopesDisjoint: true,
        },
        parentPermission: "read-only",
      }),
      "ROOT_WRITER_PERMISSION_MISMATCH",
    ],
  ];
  for (const [value, reasonCode] of cases) {
    const decision = plan(value);
    assert.equal(decision.effectiveShape, "root_inline");
    assert.equal(decision.reasonCode, reasonCode);
    assert.equal(decision.responsibility, value.responsibility);
    assert.equal(decision.spawnArgs, null);
  }
});

test("planner produces a typed child with only permitted spawn arguments", () => {
  const decision = plan(
    packet({
      parentPermission: "read-only",
    }),
  );
  assert.equal(decision.selectedShape, "typed_child");
  assert.equal(decision.effectiveShape, "typed_child");
  assert.equal(decision.reasonCode, "DELEGATE_TYPED_PERMISSION_MATCH");
  assert.deepEqual(Object.keys(decision.spawnArgs).sort(), [
    "agent_type",
    "fork_turns",
    "message",
  ]);
  assert.equal(decision.spawnArgs.agent_type, "terra_explorer");
  assert.equal(decision.spawnArgs.fork_turns, "none");
});

test("shadow records the recommendation but executes root-inline", () => {
  const decision = plan(packet(), {
    policy: { mode: "shadow", allowTypedBridge: false },
  });
  assert.equal(decision.selectedShape, "isolated_role_root");
  assert.equal(decision.effectiveShape, "root_inline");
  assert.equal(decision.reasonCode, "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH");
});

test("native schema, isolated runner, and runtime availability fail closed independently", () => {
  const cases = [
    [
      { ...CAPABILITIES, agentTypeVisible: false, isolatedRunnerVerified: false },
      "ROOT_SCHEMA_UNAVAILABLE",
    ],
    [
      { ...CAPABILITIES, isolatedRunnerVerified: false },
      "ROOT_ISOLATED_RUNNER_UNAVAILABLE",
    ],
    [{ ...CAPABILITIES, runtimeMetadataAvailable: false }, "ROOT_RUNTIME_EVIDENCE_FAILED"],
  ];
  for (const [capabilities, reasonCode] of cases) {
    assert.equal(plan(packet(), { capabilities }).reasonCode, reasonCode);
  }
});

test("bridge is required for native lineage and fails closed when disabled", () => {
  const nativePacket = packet({
    responsibility: "review",
    requiredPermission: "read-only",
    parentPermission: "workspace-write",
    requiresNativeLineage: true,
  });
  assert.equal(plan(nativePacket).reasonCode, "ROOT_BRIDGE_DISABLED");

  const decision = plan(nativePacket, {
    policy: { mode: "active", allowTypedBridge: true },
    capabilities: { ...CAPABILITIES, bridgeRuntimeVerified: true },
  });
  assert.equal(decision.selectedShape, "typed_child_bridge");
  assert.equal(decision.reasonCode, "DELEGATE_BRIDGE_LINEAGE_REQUIRED");
  assert.equal(decision.spawnArgs, null);
});

test("cost gate rejects work that is not directly consumable", () => {
  const decision = plan(
    packet({
      costSignals: { ...packet().costSignals, directlyConsumable: false },
    }),
  );
  assert.equal(decision.effectiveShape, "root_inline");
  assert.equal(decision.reasonCode, "ROOT_COST_GATE_FAILED");
});

test("specialist roles require exact opt-in and ultra is never automatic", () => {
  const base = {
    responsibility: "implementation",
    requiredPermission: "workspace-write",
    parentPermission: "workspace-write",
    writeScope: ["fixtures/src/fix.mjs", "fixtures/tests/fix.test.mjs"],
    batch: { requestedChildren: 1, writerCount: 1, scopesDisjoint: true },
    costSignals: {
      ...packet().costSignals,
      includesRegressionTest: true,
      boundedFileCount: 2,
    },
  };
  assert.equal(
    plan(packet({ ...base, requestedRole: "terra_max_worker" })).reasonCode,
    "ROOT_SCOPE_AMBIGUOUS",
  );
  assert.equal(
    plan(packet({ ...base, requestedRole: "terra_ultra_specialist" })).reasonCode,
    "ROOT_SCOPE_AMBIGUOUS",
  );
  assert.equal(
    plan(packet({ ...base, requestedRole: "terra_max_worker", ownerOptIn: true }))
      .role,
    "terra_max_worker",
  );
  assert.equal(
    plan(packet({ ...base, requestedRole: null })).role,
    "terra_worker",
  );
});

test("packet validation rejects every missing, unknown, and malformed top-level field", () => {
  for (const key of Object.keys(packet())) {
    const invalid = packet();
    delete invalid[key];
    assert.equal(validateTaskPacket(invalid).pass, false, `missing ${key}`);
  }
  assert.equal(validateTaskPacket(packet({ unexpected: true })).pass, false);
  assert.equal(validateTaskPacket(null).pass, false);
  assert.equal(validateTaskPacket([]).pass, false);
  assert.throws(() => plan({ schemaVersion: 1 }), /invalid task packet/);
});

test("packet hashes deterministically and messages contain all self-contained sections", () => {
  const reordered = Object.fromEntries(Object.entries(packet()).reverse());
  assert.match(hashTaskPacket(packet()), /^[a-f0-9]{64}$/);
  assert.equal(hashTaskPacket(packet()), hashTaskPacket(reordered));

  const message = renderTaskMessage(packet());
  for (const section of [
    "Goal:",
    "Allowed read scope:",
    "Allowed write scope:",
    "Known facts:",
    "Constraints:",
    "Expected deliverable:",
    "Success criteria:",
    "Required checks:",
    "Prohibited actions:",
  ]) {
    assert.match(message, new RegExp(section));
  }
  assert.doesNotMatch(message, /parent history/i);
});

test("batch and permission safety gates remain root-inline", () => {
  const cases = [
    [packet({ batch: { requestedChildren: 3, writerCount: 0, scopesDisjoint: true } }), "ROOT_SCOPE_AMBIGUOUS"],
    [packet({ batch: { requestedChildren: 1, writerCount: 2, scopesDisjoint: true } }), "ROOT_SCOPE_AMBIGUOUS"],
    [packet({ batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: false } }), "ROOT_SCOPE_AMBIGUOUS"],
    [packet(), "ROOT_HIGH_RISK", { ...CAPABILITIES, permissionBypassActive: true }],
  ];
  for (const [value, reasonCode, capabilities] of cases) {
    const decision = plan(value, { capabilities: capabilities ?? CAPABILITIES });
    assert.equal(decision.effectiveShape, "root_inline");
    assert.equal(decision.reasonCode, reasonCode);
  }
});

test("planner accepts a valid packet v2 without changing its routing decision", () => {
  const workflow = workflowPlan({ workflowAdapter: "direct" });
  workflow.stages[2] = {
    ...workflow.stages[2],
    responsibility: "exploration",
    requestedRole: null,
  };
  const packetV2 = compileStagePacket({
    plan: workflow,
    planHash: hashWorkflowPlan(workflow),
    stageId: "verify-evidence",
    approvalFacts: [],
    batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
  });
  const decision = plan(packetV2);
  assert.equal(decision.role, "terra_explorer");
  assert.equal(decision.selectedShape, "isolated_role_root");
  assert.equal(decision.reasonCode, "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH");
});
