import assert from "node:assert/strict";
import test from "node:test";
import { executeWorkflowContractScenario, SCENARIOS } from "../lib/workflow-contract-evidence.mjs";

test("each workflow contract scenario exercises the real workflow state machine", () => {
  for (const scenario of SCENARIOS) {
    const result = executeWorkflowContractScenario(scenario);
    assert.equal(result.pass, true, scenario.id);
    assert.equal(result.realWorkflowModules, true, scenario.id);
    assert.deepEqual(Object.values(result.contract), Array(10).fill(true), scenario.id);
  }
});
