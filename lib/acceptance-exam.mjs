import { createHash } from "node:crypto";
import { classifyDispatchFailure, validateDispatchResult } from "./dispatch-evidence.mjs";
import { planDispatch } from "./dispatch-planner.mjs";

export const ACCEPTANCE_SCENARIOS = Object.freeze([
  { id: "Q1_ROOT_TRIVIAL", selectedShape: "root_inline", reasonCode: "ROOT_TRIVIAL", executor: "root" },
  { id: "Q2_ISOLATED_LUNA", selectedShape: "isolated_role_root", reasonCode: "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH", executor: "isolated" },
  { id: "Q3_ISOLATED_TERRA", selectedShape: "isolated_role_root", reasonCode: "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH", executor: "isolated" },
  { id: "Q4_TYPED_WORKER", selectedShape: "typed_child", reasonCode: "DELEGATE_TYPED_PERMISSION_MATCH", executor: "typed" },
  { id: "Q5_ROOT_HIGH_RISK", selectedShape: "root_inline", reasonCode: "ROOT_HIGH_RISK", executor: "root" },
  { id: "Q6_UNKNOWN_SKILL", selectedShape: "root_inline", reasonCode: "ROOT_UNKNOWN_SKILL", executor: "root" },
  { id: "Q7_BRIDGE_DISABLED", selectedShape: "root_inline", reasonCode: "ROOT_BRIDGE_DISABLED", executor: "root" },
  { id: "Q8_RUNTIME_MISMATCH_REJECTED", selectedShape: "root_inline", reasonCode: "ROOT_RUNTIME_EVIDENCE_FAILED", executor: "root", negative: true },
  { id: "Q9_WRITE_VIOLATION_REJECTED", selectedShape: "root_inline", reasonCode: "ROOT_PERMISSION_VIOLATION", executor: "root", negative: true },
  { id: "Q10_TWO_TYPED_READERS", selectedShape: "typed_child", reasonCode: "DELEGATE_TYPED_PERMISSION_MATCH", executor: "parallel", parallel: true },
]);

export const ACCEPTANCE_PARALLEL_CHILDREN = Object.freeze([
  Object.freeze({
    role: "luna_clerk",
    model: "gpt-5.6-luna",
    effort: "low",
    taskName: "acceptance_luna",
    readScope: "reader-a.txt",
    marker: "Q10_LUNA_OK:alpha",
    message: "Goal: verify the acceptance fixture. Scope: read only reader-a.txt. Known fact: its exact content is alpha. Constraints: do not write, spawn, delegate, or inspect any other path. Deliverable: reply exactly Q10_LUNA_OK:alpha. Success check: confirm reader-a.txt equals alpha. Prohibited: all filesystem writes and all descendant agents.",
  }),
  Object.freeze({
    role: "terra_explorer",
    model: "gpt-5.6-terra",
    effort: "medium",
    taskName: "acceptance_terra",
    readScope: "reader-b.txt",
    marker: "Q10_TERRA_OK:beta",
    message: "Goal: verify the acceptance fixture. Scope: read only reader-b.txt. Known fact: its exact content is beta. Constraints: do not write, spawn, delegate, or inspect any other path. Deliverable: reply exactly Q10_TERRA_OK:beta. Success check: confirm reader-b.txt equals beta. Prohibited: all filesystem writes and all descendant agents.",
  }),
]);

const SCENARIO_PACKET_OVERRIDES = Object.freeze({
  Q1_ROOT_TRIVIAL: { responsibility: "mechanical", costSignals: { estimatedRootToolCalls: 1, oneLocation: true } },
  Q2_ISOLATED_LUNA: { responsibility: "mechanical" },
  Q3_ISOLATED_TERRA: { responsibility: "exploration" },
  Q4_TYPED_WORKER: { responsibility: "implementation", parentPermission: "workspace-write", requiredPermission: "workspace-write", writeScope: ["fixture.txt", "fixture.test.txt"], batch: { requestedChildren: 1, writerCount: 1, scopesDisjoint: true }, costSignals: { includesRegressionTest: true, boundedFileCount: 2 } },
  Q5_ROOT_HIGH_RISK: { responsibility: "implementation", riskSignals: { highRisk: true } },
  Q6_UNKNOWN_SKILL: { responsibility: "exploration", workflowAdapter: "unknown:fanout" },
  Q7_BRIDGE_DISABLED: { responsibility: "review", requiresNativeLineage: true },
  Q10_TWO_TYPED_READERS: { responsibility: "exploration", parentPermission: "read-only", requiredPermission: "read-only", batch: { requestedChildren: 2, writerCount: 0, scopesDisjoint: true } },
});

export function createAcceptancePacket(scenario) {
  const override = SCENARIO_PACKET_OVERRIDES[scenario?.id];
  if (!override) throw new TypeError("acceptance scenario has no planner packet");
  const base = {
    schemaVersion: 1, workflowAdapter: "direct", responsibility: "exploration", goal: `Acceptance ${scenario.id}`,
    readScope: ["fixtures/a", "fixtures/b"], writeScope: [], knownFacts: ["disposable fixture"], constraints: ["no descendants"], deliverable: "structured evidence", successCriteria: ["exact result"], checks: ["verify persisted runtime"], prohibitedActions: ["no unrelated writes"],
    parentPermission: "workspace-write", requiredPermission: "read-only", requiresNativeLineage: false, requestedRole: null, ownerOptIn: false, legacyAdapter: false,
    batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true }, riskSignals: { ambiguous: false, hiddenCoupling: false, highRisk: false, weakVerification: false },
    costSignals: { estimatedRootToolCalls: 5, oneLocation: false, packagingDominates: false, directlyConsumable: true, repetitiveReads: 3, moduleCount: 2, fileCount: 5, bytes: 0, lines: 0, itemCount: 25, includesRegressionTest: false, boundedFileCount: 0 },
  };
  return {
    ...base, ...override,
    batch: { ...base.batch, ...(override.batch ?? {}) },
    riskSignals: { ...base.riskSignals, ...(override.riskSignals ?? {}) },
    costSignals: { ...base.costSignals, ...(override.costSignals ?? {}) },
  };
}

export function planAcceptanceScenario({ scenario, policy, capabilities, roleSpecs, plan = planDispatch }) {
  const decision = plan({ policy, packet: createAcceptancePacket(scenario), capabilities, roleSpecs });
  if (decision.selectedShape !== scenario.selectedShape || decision.reasonCode !== scenario.reasonCode) {
    throw new Error(`acceptance scenario decision drift: ${scenario.id}`);
  }
  return decision;
}

const QUESTION_IDS = ACCEPTANCE_SCENARIOS.map(({ id }) => id);
const HASH = /^[a-f0-9]{64}$/;
const REPORT_KEYS = Object.freeze(["activationEligible", "cleanup", "expectedQuestionCount", "generatedAt", "globalConfigAfterSha256", "globalConfigBeforeSha256", "globalConfigUnchanged", "kind", "pass", "questions", "runtimeBinding", "runtimeBindingAfterSha256", "runtimeBindingStable", "schemaVersion"]);
const QUESTION_KEYS = Object.freeze(["cleanup", "id", "pass", "reasonCode", "runtime", "selectedShape"]);
const NEGATIVE_QUESTION_KEYS = Object.freeze([...QUESTION_KEYS, "rejected", "violationDetected"]);

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

export function validateAcceptanceDeliverable(id, source) {
  let value;
  try { value = JSON.parse(source); } catch { return false; }
  if (id === "Q2_ISOLATED_LUNA") {
    return exactKeys(value, ["count"]) && value.count === 25;
  }
  if (id === "Q3_ISOLATED_TERRA") {
    return exactKeys(value, ["filenames"]) &&
      JSON.stringify(value.filenames) === JSON.stringify([
        "trace-0.txt", "trace-1.txt", "trace-2.txt", "trace-3.txt", "trace-4.txt",
      ]);
  }
  return false;
}

export function evaluateAcceptanceViolation({ result, decision, roleSpec, violation }) {
  const runtime = {
    persisted: result?.checks?.runtimePersisted === true,
    model: result?.actual?.model ?? null,
    effort: result?.actual?.effort ?? null,
    tokenUsage: { total_tokens: result?.actual?.parentTokens ?? null },
  };
  const cleanup = { pass: result?.checks?.cleanupPassed === true };
  const baseline = validateDispatchResult({ result, decision, roleSpec });
  if (!baseline.pass) {
    return { pass: false, selectedShape: null, reasonCode: null, rejected: false, violationDetected: false, runtime, cleanup };
  }
  const injected = JSON.parse(JSON.stringify(result));
  if (violation === "runtime_mismatch") {
    injected.actual.model = "gpt-5.6-invalid";
    injected.checks.modelMatches = false;
  } else if (violation === "filesystem_write") {
    injected.changedFiles = ["forbidden-write.txt"];
    injected.checks.filesystemScope = false;
  } else {
    throw new TypeError("unsupported acceptance violation");
  }
  injected.pass = false;
  injected.rollbackRequired = true;
  const validation = validateDispatchResult({ result: injected, decision, roleSpec });
  const classification = classifyDispatchFailure(injected);
  const expectedReason = violation === "runtime_mismatch"
    ? "ROOT_RUNTIME_EVIDENCE_FAILED"
    : "ROOT_PERMISSION_VIOLATION";
  const violationDetected = validation.pass === false;
  const rejected = violationDetected &&
    classification.retryAllowed === false &&
    classification.rollbackRequired === true &&
    classification.fallbackReason === expectedReason;
  return {
    pass: rejected,
    selectedShape: "root_inline",
    reasonCode: classification.fallbackReason,
    rejected,
    violationDetected,
    runtime,
    cleanup,
  };
}

function sha256(value) {
  return createHash("sha256").update(value ?? "").digest("hex");
}

function tokenUsage(value) {
  return Number.isFinite(value?.total_tokens) && value.total_tokens >= 0;
}

function runtimePasses(runtime) {
  return runtime?.persisted === true &&
    typeof runtime.model === "string" && runtime.model.length > 0 &&
    typeof runtime.effort === "string" && runtime.effort.length > 0 &&
    tokenUsage(runtime.tokenUsage);
}

function parallelPasses(topology) {
  const children = topology?.children;
  const exactChildren = Array.isArray(children) && children.length === ACCEPTANCE_PARALLEL_CHILDREN.length &&
    ACCEPTANCE_PARALLEL_CHILDREN.every((expected) => children.some((child) =>
      child?.role === expected.role &&
      child?.model === expected.model &&
      child?.effort === expected.effort &&
      child?.readScope === expected.readScope &&
      child?.markerReturned === true,
    ));
  return topology?.parent?.model === "gpt-5.6-sol" &&
    topology?.parent?.effort === "ultra" &&
    topology?.parent?.runtimePersisted === true &&
    tokenUsage(topology.parent.tokenUsage) &&
    exactChildren &&
    children.every((child) =>
      child?.runtimePersisted === true &&
      child?.depth === 1 &&
      child?.sandbox === "read-only" &&
      child?.writer === false &&
      child?.descendants === 0 &&
      typeof child.role === "string" && child.role.length > 0 &&
      typeof child.readScope === "string" && child.readScope.length > 0 &&
      tokenUsage(child.tokenUsage),
    ) &&
    children[0].role !== children[1].role &&
    children[0].readScope !== children[1].readScope &&
    topology?.writerCount === 0 && topology?.descendantCount === 0 &&
    topology?.spawnsExact === true && topology?.lineageExact === true &&
    topology?.filesystemUnchanged === true && topology?.parentMarkerReturned === true;
}

function questionPasses(scenario, result, roleSmoke) {
  const exact = result?.id === scenario.id &&
    result?.selectedShape === scenario.selectedShape &&
    result?.reasonCode === scenario.reasonCode &&
    result?.pass === true &&
    runtimePasses(result?.runtime) &&
    result?.cleanup?.pass === true;
  if (!exact) return false;
  if (scenario.negative) return result.violationDetected === true && result.rejected === true;
  if (scenario.id === "Q4_TYPED_WORKER") {
    return roleSmoke?.pass === true && roleSmoke?.roles?.some((role) => role?.role === "terra_worker" && role?.pass === true) === true;
  }
  if (scenario.parallel) return parallelPasses(result.topology);
  return true;
}

function publicQuestion(scenario, result, pass) {
  const question = {
    id: scenario.id,
    selectedShape: scenario.selectedShape,
    reasonCode: scenario.reasonCode,
    pass,
    runtime: runtimePasses(result?.runtime),
    cleanup: { pass: result?.cleanup?.pass === true },
  };
  if (scenario.negative) {
    question.rejected = result?.rejected === true;
    question.violationDetected = result?.violationDetected === true;
  }
  return question;
}

function hardFailure(result) {
  return result?.hardFailure === "runtime" || result?.hardFailure === "permission" ||
    result?.hardFailure === "filesystem" || result?.hardFailure === "cleanup" ||
    result?.cleanup?.pass === false || result?.runtime === null;
}

function executorFor(scenario, executors) {
  return executors[
    scenario.executor === "root" ? "executeRoot" :
      scenario.executor === "isolated" ? "executeIsolated" :
        scenario.executor === "typed" ? "executeTyped" : "executeParallel"
  ];
}

export async function runAcceptanceExam({
  policy,
  roleSmoke,
  runtimeBinding,
  collectRuntimeBinding = async () => runtimeBinding,
  readGlobalConfig = async () => null,
  executeRoot,
  executeIsolated,
  executeTyped,
  executeParallel,
  planScenario = null,
  onQuestion = null,
} = {}) {
  const executors = { executeRoot, executeIsolated, executeTyped, executeParallel };
  const beforeConfig = await readGlobalConfig();
  const questions = [];
  const priorResults = new Map();
  let stopped = false;
  for (const scenario of ACCEPTANCE_SCENARIOS) {
    const execute = executorFor(scenario, executors);
    let result = null;
    let decision = null;
    if (!scenario.negative && typeof planScenario === "function") {
      try { decision = planScenario(scenario); } catch { result = { id: scenario.id, cleanup: { pass: false }, hardFailure: "runtime" }; }
    }
    if (result === null && typeof execute === "function") {
      try {
        result = await execute(scenario, {
          policy,
          roleSmoke,
          decision,
          priorResults: new Map(priorResults),
        });
      } catch {
        result = { id: scenario.id, cleanup: { pass: false }, hardFailure: "runtime" };
      }
    }
    const decisionMatches = decision === null ||
      (decision.selectedShape === scenario.selectedShape && decision.reasonCode === scenario.reasonCode && result?.selectedShape === decision.selectedShape && result?.reasonCode === decision.reasonCode);
    const pass = !stopped && decisionMatches && questionPasses(scenario, result, roleSmoke);
    const entry = publicQuestion(scenario, result, pass);
    priorResults.set(scenario.id, result);
    questions.push(entry);
    if (typeof onQuestion === "function") onQuestion(entry);
    if (!pass && hardFailure(result)) {
      stopped = true;
      break;
    }
  }
  const afterConfig = await readGlobalConfig();
  let bindingAfter = null;
  try { bindingAfter = await collectRuntimeBinding(); } catch { bindingAfter = null; }
  const runtimeBindingStable =
    typeof runtimeBinding?.sha256 === "string" && runtimeBinding.sha256 === bindingAfter?.sha256;
  const globalConfigBeforeSha256 = beforeConfig === null ? null : sha256(beforeConfig);
  const globalConfigAfterSha256 = afterConfig === null ? null : sha256(afterConfig);
  const globalConfigUnchanged = globalConfigBeforeSha256 !== null &&
    globalConfigBeforeSha256 === globalConfigAfterSha256;
  const cleanup = { pass: questions.length === 10 && questions.every((question) => question.cleanup.pass) };
  const pass = questions.length === 10 && questions.every((question) => question.pass) &&
    cleanup.pass && runtimeBindingStable && globalConfigUnchanged && policy?.allowTypedBridge === false;
  return {
    schemaVersion: 1,
    kind: "quality_first_acceptance_exam",
    generatedAt: new Date().toISOString(),
    pass,
    expectedQuestionCount: 10,
    runtimeBinding,
    runtimeBindingAfterSha256: bindingAfter?.sha256 ?? null,
    runtimeBindingStable,
    globalConfigBeforeSha256,
    globalConfigAfterSha256,
    globalConfigUnchanged,
    questions,
    cleanup,
    activationEligible: pass,
  };
}

export function validateAcceptanceEvidence(report) {
  const questions = Array.isArray(report?.questions) ? report.questions : [];
  const exactQuestions = questions.length === QUESTION_IDS.length && questions.every((question, index) =>
    exactKeys(question, ACCEPTANCE_SCENARIOS[index].negative ? NEGATIVE_QUESTION_KEYS : QUESTION_KEYS) &&
    exactKeys(question?.cleanup, ["pass"]) &&
    question?.id === QUESTION_IDS[index] &&
    question?.selectedShape === ACCEPTANCE_SCENARIOS[index].selectedShape &&
    question?.reasonCode === ACCEPTANCE_SCENARIOS[index].reasonCode &&
    question?.pass === true && question?.runtime === true && question?.cleanup?.pass === true &&
    (!ACCEPTANCE_SCENARIOS[index].negative ||
      (question?.rejected === true && question?.violationDetected === true)),
  );
  const checks = {
    schema: report?.schemaVersion === 1 && report?.kind === "quality_first_acceptance_exam" && JSON.stringify(Object.keys(report ?? {}).sort()) === JSON.stringify([...REPORT_KEYS].sort()),
    timestamp: Number.isFinite(Date.parse(report?.generatedAt ?? "")),
    exactQuestionCount: report?.expectedQuestionCount === 10 && exactQuestions,
    runtimeBinding: typeof report?.runtimeBinding?.sha256 === "string" && HASH.test(report.runtimeBinding.sha256),
    runtimeStable: report?.runtimeBindingStable === true && report?.runtimeBindingAfterSha256 === report?.runtimeBinding?.sha256,
    globalConfig: HASH.test(report?.globalConfigBeforeSha256 ?? "") &&
      report?.globalConfigBeforeSha256 === report?.globalConfigAfterSha256 && report?.globalConfigUnchanged === true,
    cleanup: report?.cleanup?.pass === true,
    activation: report?.pass === true && report?.activationEligible === true,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export function attachAcceptanceMetadata(report, { reportDirectory, reuse = null }) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw new TypeError("acceptance report must be an object");
  }
  Object.defineProperty(report, "reportDirectory", {
    value: reportDirectory,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  if (reuse !== null) {
    Object.defineProperty(report, "reuse", {
      value: reuse,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return report;
}
