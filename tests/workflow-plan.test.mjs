import assert from "node:assert/strict";
import test from "node:test";
import { KNOWN_ADAPTERS, RESPONSIBILITY_ROLES } from "../lib/dispatch-planner.mjs";
import {
  hashWorkflowPlan,
  validateWorkflowPlan,
  workflowIndexes,
} from "../lib/workflow-plan.mjs";
import { stage, workflowPlan } from "./helpers/workflow-fixtures.mjs";

const OPTIONS = {
  knownAdapters: KNOWN_ADAPTERS,
  roleNames: Object.values(RESPONSIBILITY_ROLES),
};

function reversedObject(value) {
  if (Array.isArray(value)) return value.map(reversedObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .reverse()
        .map((key) => [key, reversedObject(value[key])]),
    );
  }
  return value;
}

test("valid workflow has a stable canonical hash and complete indexes", () => {
  const plan = workflowPlan();
  assert.deepEqual(validateWorkflowPlan(plan, OPTIONS), { pass: true, errors: [] });
  assert.match(hashWorkflowPlan(plan), /^[a-f0-9]{64}$/);
  assert.equal(hashWorkflowPlan(plan), hashWorkflowPlan(reversedObject(plan)));
  const indexes = workflowIndexes(plan);
  assert.equal(indexes.producerByArtifact.get("verified-report"), "verify-evidence");
  assert.deepEqual([...indexes.ancestorsByStage.get("verify-evidence")].sort(), [
    "audit-cli",
    "audit-core",
  ]);
});

function clonedPlan() {
  return structuredClone(workflowPlan());
}

function errorsFor(mutate) {
  const plan = clonedPlan();
  mutate(plan);
  const result = validateWorkflowPlan(plan, OPTIONS);
  assert.equal(result.pass, false);
  return result.errors.join("\n");
}

test("rejects each declared DAG, artifact, approval, adapter, writer, and reserve violation", () => {
  const invalidPlans = [
    ["duplicate stage", (plan) => plan.stages.push(structuredClone(plan.stages[0])), /duplicate stage id/],
    ["unknown dependency", (plan) => plan.stages[2].dependsOn.push("missing-stage"), /unknown dependency/],
    ["cycle", (plan) => plan.stages[0].dependsOn.push("verify-evidence"), /dependency cycle/],
    ["self dependency", (plan) => plan.stages[0].dependsOn.push("audit-core"), /depends on itself/],
    ["multiple artifact producers", (plan) => plan.stages[1].outputArtifacts = ["core-evidence"], /multiple producers/],
    ["missing artifact producer", (plan) => plan.stages[2].inputArtifacts.push("missing-evidence"), /missing producer/],
    ["non-ancestor artifact", (plan) => plan.stages[0].inputArtifacts.push("cli-evidence"), /not an ancestor/],
    ["verification without work ancestor", (plan) => plan.stages[2].dependsOn = [], /lacks a work ancestor/],
    ["malformed approval gate", (plan) => plan.stages[0].approvalGate = { authority: "owner" }, /approvalGate must contain exactly/],
    ["unknown adapter", (plan) => plan.workflowAdapter = "unknown:workflow", /workflowAdapter is invalid/],
    ["overlapping potential writers", (plan) => {
      for (const item of plan.stages.slice(0, 2)) {
        item.responsibility = "implementation";
        item.requiredPermission = "workspace-write";
        item.writeScope = ["lib/shared.mjs"];
      }
    }, /overlapping writer scopes/],
    ["insufficient verification reserve", (plan) => plan.attemptBudget.reservedForVerification = 0, /enough verification/],
    ["recovery reserve above one", (plan) => plan.attemptBudget.reservedForRecovery = 2, /must not exceed one/],
  ];

  for (const [name, mutate, expected] of invalidPlans) {
    assert.match(errorsFor(mutate), expected, name);
  }
});

test("requires exact fields at every schema level", () => {
  const cases = [
    ["plan", (plan) => plan],
    ["budget", (plan) => plan.attemptBudget],
    ["stage", (plan) => plan.stages[0]],
    ["approval", (plan) => {
      plan.stages[0].approvalGate = {
        authority: "owner",
        factId: "approve-specialist-stage",
        purpose: "stage_execution",
      };
      return plan.stages[0].approvalGate;
    }],
    ["risk", (plan) => plan.stages[0].riskSignals],
    ["cost", (plan) => plan.stages[0].costSignals],
  ];

  for (const [name, select] of cases) {
    for (const field of Object.keys(select(clonedPlan()))) {
      assert.match(errorsFor((plan) => delete select(plan)[field]), /must contain exactly/, `${name} missing ${field}`);
    }
    assert.match(errorsFor((plan) => select(plan).unexpected = true), /must contain exactly/, `${name} extra field`);
  }
});

test("rejects invalid identifiers, scopes, strings, and signal types", () => {
  const cases = [
    [(plan) => plan.workflowId = "bad/id", /workflowId must be a safe identifier/],
    [(plan) => plan.stages[0].id = "x".repeat(129), /stages\[0\].id must be a safe identifier/],
    [(plan) => plan.stages[0].inputArtifacts = ["bad/id"], /inputArtifacts must contain safe identifiers/],
    [(plan) => plan.stages[0].readScope = ["."], /relative paths/],
    [(plan) => plan.stages[0].writeScope = ["../lib"], /relative paths/],
    [(plan) => plan.stages[0].interfaces = [""], /interfaces must be an array of non-empty strings/],
    [(plan) => plan.stages[0].riskSignals.ambiguous = "false", /riskSignals must contain boolean flags/],
    [(plan) => plan.stages[0].costSignals.lines = -1, /costSignals must contain non-negative integer counts/],
  ];
  for (const [mutate, expected] of cases) assert.match(errorsFor(mutate), expected);
});

test("requires producer ancestry and permits ordered overlapping writers", () => {
  const plan = workflowPlan({
    stages: [
      stage({
        id: "write-one",
        responsibility: "implementation",
        requiredPermission: "workspace-write",
        writeScope: ["lib"],
        outputArtifacts: ["first-evidence"],
      }),
      stage({
        id: "write-two",
        responsibility: "implementation",
        dependsOn: ["write-one"],
        inputArtifacts: ["first-evidence"],
        requiredPermission: "workspace-write",
        writeScope: ["lib/shared.mjs"],
        outputArtifacts: ["second-evidence"],
      }),
    ],
  });
  assert.deepEqual(validateWorkflowPlan(plan, OPTIONS), { pass: true, errors: [] });

  const cyclic = clonedPlan();
  cyclic.stages[0].dependsOn = ["verify-evidence"];
  assert.doesNotThrow(() => workflowIndexes(cyclic));
});

test("covers attempt classes, role names, and recovery reserve", () => {
  assert.match(errorsFor((plan) => plan.stages[0].attemptClass = "unknown"), /attemptClass is invalid/);
  assert.match(errorsFor((plan) => plan.stages[0].requestedRole = "unknown_role"), /requestedRole is invalid/);
  assert.match(errorsFor((plan) => {
    plan.stages[0].attemptClass = "recovery";
    plan.attemptBudget.reservedForRecovery = 0;
  }), /enough recovery/);
});

test("returns validation errors when dependsOn is not iterable", () => {
  const plan = clonedPlan();
  plan.stages[0].dependsOn = 42;
  let result;
  assert.doesNotThrow(() => result = validateWorkflowPlan(plan, OPTIONS));
  assert.equal(result.pass, false);
  assert.match(result.errors.join("\n"), /dependsOn must be an array of non-empty strings/);
});

test("returns validation errors when inputArtifacts is not iterable", () => {
  const plan = clonedPlan();
  plan.stages[0].inputArtifacts = 42;
  let result;
  assert.doesNotThrow(() => result = validateWorkflowPlan(plan, OPTIONS));
  assert.equal(result.pass, false);
  assert.match(result.errors.join("\n"), /inputArtifacts must be an array of non-empty strings/);
});

test("rejects a stage output that collides with a plan input artifact", () => {
  const plan = clonedPlan();
  plan.stages[1].outputArtifacts = ["repository-snapshot"];
  plan.stages[2].inputArtifacts = ["core-evidence", "repository-snapshot"];
  const result = validateWorkflowPlan(plan, OPTIONS);
  assert.equal(result.pass, false);
  assert.match(result.errors.join("\n"), /multiple producers for artifact: repository-snapshot/);
});

test("returns validation errors for malformed competing writer scopes", () => {
  const plan = clonedPlan();
  plan.stages[0].writeScope = [42];
  plan.stages[1].writeScope = [43];
  let result;
  assert.doesNotThrow(() => result = validateWorkflowPlan(plan, OPTIONS));
  assert.equal(result.pass, false);
  assert.match(result.errors.join("\n"), /writeScope must be an array of non-empty strings/);
});
