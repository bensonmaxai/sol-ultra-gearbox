import { createHash } from "node:crypto";

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

const QUESTION_IDS = ACCEPTANCE_SCENARIOS.map(({ id }) => id);
const HASH = /^[a-f0-9]{64}$/;

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
  return topology?.parent?.model === "gpt-5.6-sol" &&
    topology?.parent?.effort === "ultra" &&
    topology?.parent?.runtimePersisted === true &&
    tokenUsage(topology.parent.tokenUsage) &&
    Array.isArray(children) && children.length === 2 &&
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
    topology?.writerCount === 0 && topology?.descendantCount === 0;
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
  return {
    id: scenario.id,
    selectedShape: scenario.selectedShape,
    reasonCode: scenario.reasonCode,
    pass,
    runtime: runtimePasses(result?.runtime),
    cleanup: { pass: result?.cleanup?.pass === true },
    rejected: scenario.negative ? result?.rejected === true : undefined,
    violationDetected: scenario.negative ? result?.violationDetected === true : undefined,
  };
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
  onQuestion = null,
} = {}) {
  const executors = { executeRoot, executeIsolated, executeTyped, executeParallel };
  const beforeConfig = await readGlobalConfig();
  const questions = [];
  let stopped = false;
  for (const scenario of ACCEPTANCE_SCENARIOS) {
    const execute = executorFor(scenario, executors);
    let result = null;
    if (typeof execute === "function") {
      try {
        result = await execute(scenario, { policy, roleSmoke });
      } catch {
        result = { id: scenario.id, cleanup: { pass: false }, hardFailure: "runtime" };
      }
    }
    const pass = !stopped && questionPasses(scenario, result, roleSmoke);
    const entry = publicQuestion(scenario, result, pass);
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
    question?.id === QUESTION_IDS[index] &&
    question?.selectedShape === ACCEPTANCE_SCENARIOS[index].selectedShape &&
    question?.reasonCode === ACCEPTANCE_SCENARIOS[index].reasonCode &&
    question?.pass === true && question?.runtime === true && question?.cleanup?.pass === true &&
    (!ACCEPTANCE_SCENARIOS[index].negative ||
      (question?.rejected === true && question?.violationDetected === true)),
  );
  const checks = {
    schema: report?.schemaVersion === 1 && report?.kind === "quality_first_acceptance_exam",
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
