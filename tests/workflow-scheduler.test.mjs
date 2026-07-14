import assert from "node:assert/strict";
import test from "node:test";
import {
  readyStageIds,
  scheduleWorkflow,
  selectCandidateBatch,
} from "../lib/workflow-scheduler.mjs";
import { initializedWorkflow, stage, workflowPlan } from "./helpers/workflow-fixtures.mjs";

function decision(stageId, shape = "isolated_role_root") {
  return {
    taskHash: `${stageId[0]}`.repeat(64),
    selectedShape: shape,
    effectiveShape: shape,
    role: shape === "root_inline" ? null : "terra_explorer",
    reasonCode: shape === "root_inline" ? "ROOT_TRIVIAL" : "DELEGATE_TEST",
    spawnArgs: null,
  };
}

test("two independent readers form one canary-gated batch", () => {
  const { plan, state } = initializedWorkflow({ ready: ["audit-core", "audit-cli"] });
  const candidate = selectCandidateBatch({ plan, state });
  assert.deepEqual(scheduleWorkflow({
    plan,
    state,
    candidate,
    decisions: new Map([
      ["audit-core", decision("audit-core")],
      ["audit-cli", decision("audit-cli")],
    ]),
  }), {
    kind: "batch",
    stageIds: ["audit-core", "audit-cli"],
    canaryStageId: "audit-core",
    deferredStageIds: ["audit-cli"],
  });
});

test("ready stages require adopted dependencies and satisfied approval gates", () => {
  const plan = workflowPlan({
    stages: [
      stage({ id: "first", outputArtifacts: ["first-output"] }),
      stage({
        id: "second",
        dependsOn: ["first"],
        inputArtifacts: ["first-output"],
        approvalGate: { authority: "owner", factId: "go", purpose: "stage_execution" },
      }),
    ],
  });
  const { state } = initializedWorkflow({ plan, ready: ["first", "second"] });
  assert.deepEqual(readyStageIds({ plan, state }), ["first"]);
  state.stages.first.state = "adopted";
  state.approvalFacts.push({ authority: "owner", factId: "go", scopeHash: state.planHash });
  assert.deepEqual(readyStageIds({ plan, state }), ["second"]);
});

test("work cannot consume verification or recovery reserves", () => {
  const { plan, state } = initializedWorkflow({
    budget: { total: 4, reservedForVerification: 1, reservedForRecovery: 1 },
    ready: ["audit-core"],
  });
  state.budget.consumed.total = 2;
  const candidate = selectCandidateBatch({ plan, state });
  const result = scheduleWorkflow({
    plan, state, candidate, decisions: new Map([["audit-core", decision("audit-core", "typed_child")]]),
  });
  assert.equal(result.kind, "root_inline");
  assert.equal(result.reasonCode, "ROOT_WORK_ATTEMPT_RESERVE_PROTECTED");
});

test("writers and overlapping reader scopes fail closed to the earliest stage", () => {
  const writerPlan = workflowPlan({
    stages: [
      stage({ id: "writer-one", writeScope: ["lib/a.mjs"] }),
      stage({ id: "writer-two", writeScope: ["lib/b.mjs"] }),
    ],
  });
  const { state: writerState } = initializedWorkflow({ plan: writerPlan, ready: ["writer-one", "writer-two"] });
  assert.deepEqual(selectCandidateBatch({ plan: writerPlan, state: writerState }).stageIds, ["writer-one"]);

  const malformed = workflowPlan({
    stages: [
      stage({ id: "reader-one", writeScope: ["lib"] }),
      stage({ id: "reader-two", writeScope: ["lib/nested"] }),
    ],
  });
  const { state } = initializedWorkflow({ plan: malformed, ready: ["reader-one", "reader-two"] });
  assert.deepEqual(selectCandidateBatch({ plan: malformed, state }).stageIds, ["reader-one"]);
});

test("a reader never batches across a writer and stopped workflow blocks when no stage is safe", () => {
  const plan = workflowPlan({
    stages: [
      stage({ id: "reader", writeScope: [] }),
      stage({ id: "writer", writeScope: ["lib/change.mjs"] }),
      stage({ id: "later-reader", writeScope: [] }),
    ],
  });
  const { state } = initializedWorkflow({ plan, ready: ["reader", "writer", "later-reader"] });
  assert.deepEqual(selectCandidateBatch({ plan, state }).stageIds, ["reader"]);
  state.stages.reader.state = "blocked";
  state.stages.writer.state = "blocked";
  state.stages["later-reader"].state = "blocked";
  state.delegationStopped = true;
  state.stopReason = "WORKFLOW_CANARY_FAILED";
  assert.deepEqual(scheduleWorkflow({
    plan,
    state,
    candidate: selectCandidateBatch({ plan, state }),
    decisions: new Map(),
  }), { kind: "blocked", reasonCode: "WORKFLOW_CANARY_FAILED" });
});

test("verification exhaustion blocks, recovery exhaustion roots inline, and stopped delegation emits no delegated batch", () => {
  const verification = initializedWorkflow({ plan: workflowPlan({ stages: [stage({ id: "verify", attemptClass: "verification" })] }), ready: ["verify"] });
  verification.state.budget.consumed.total = 3;
  verification.state.budget.consumed.verification = 1;
  assert.deepEqual(scheduleWorkflow({
    ...verification,
    candidate: selectCandidateBatch(verification),
    decisions: new Map([["verify", decision("verify")]]),
  }), { kind: "blocked", reasonCode: "WORKFLOW_VERIFICATION_RESERVE_EXHAUSTED" });

  const recovery = initializedWorkflow({ plan: workflowPlan({ stages: [stage({ id: "recover", attemptClass: "recovery" })] }), ready: ["recover"] });
  recovery.state.budget.consumed.total = 3;
  recovery.state.budget.consumed.recovery = 1;
  assert.equal(scheduleWorkflow({
    ...recovery,
    candidate: selectCandidateBatch(recovery),
    decisions: new Map([["recover", decision("recover")]]),
  }).reasonCode, "ROOT_RECOVERY_RESERVE_EXHAUSTED");

  const stopped = initializedWorkflow({ ready: ["audit-core"] });
  stopped.state.delegationStopped = true;
  stopped.state.stopReason = "WORKFLOW_CANARY_FAILED";
  assert.equal(scheduleWorkflow({
    ...stopped,
    candidate: selectCandidateBatch(stopped),
    decisions: new Map([["audit-core", decision("audit-core")]]),
  }).kind, "root_inline");
});
