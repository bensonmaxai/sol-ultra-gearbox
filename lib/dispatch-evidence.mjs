import { validateTypedSpawnArgs } from "./gearbox.mjs";

const RESULT_KEYS = Object.freeze([
  "schemaVersion",
  "kind",
  "pass",
  "taskHash",
  "executionShape",
  "role",
  "reasonCode",
  "expected",
  "actual",
  "checks",
  "changedFiles",
  "retryCount",
  "rollbackRequired",
  "synthetic",
]);
const EXPECTED_KEYS = Object.freeze(["model", "effort", "sandbox", "depth", "roleHash"]);
const ACTUAL_KEYS = Object.freeze([
  "model",
  "effort",
  "sandbox",
  "depth",
  "parentTokens",
  "childTokens",
  "nativeAgentRole",
]);
export const REQUIRED_CHECKS = Object.freeze([
  "runtimePersisted",
  "modelMatches",
  "effortMatches",
  "sandboxMatches",
  "taskHashMatches",
  "roleHashMatches",
  "depthMatches",
  "noDescendants",
  "filesystemScope",
  "commandExitedZero",
  "commandDidNotTimeout",
  "cleanupPassed",
  "deliverableValid",
]);
const HASH = /^[a-f0-9]{64}$/;

function hasExactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function tokenTotal(summary) {
  const total = summary?.tokenUsage?.total_tokens;
  return Number.isFinite(total) ? total : null;
}

function spawnCalls(summary) {
  return (summary?.functionCalls ?? []).filter((call) =>
    call?.name?.endsWith("spawn_agent"),
  );
}

function childRole(summary) {
  return (
    summary?.sessionMeta?.agent_role ??
    summary?.sessionMeta?.source?.subagent?.thread_spawn?.agent_role ??
    null
  );
}

function childDepth(summary) {
  return summary?.sessionMeta?.source?.subagent?.thread_spawn?.depth ?? null;
}

function runtimeFacts(summary, { depth, nativeAgentRole, childTokens = null } = {}) {
  return {
    model: summary?.turnContext?.model ?? null,
    effort: summary?.turnContext?.effort ?? null,
    sandbox: summary?.turnContext?.sandbox_policy?.type ?? null,
    depth,
    parentTokens: tokenTotal(summary),
    childTokens,
    nativeAgentRole,
  };
}

function changedFiles(snapshot) {
  return Array.isArray(snapshot?.changedFiles) ? snapshot.changedFiles : null;
}

function cleanupFacts(cleanup) {
  return {
    commandExitedZero: cleanup?.commandExitedZero === true,
    commandDidNotTimeout: cleanup?.timedOut === false,
    cleanupPassed: cleanup?.passed === true,
  };
}

function resultEnvelope({ decision, roleSpec, roleHash, actual, checks, changedFiles: files, retryCount = 0, synthetic = false }) {
  const pass = REQUIRED_CHECKS.every((name) => checks[name] === true);
  return {
    schemaVersion: 1,
    kind: "dispatch_result",
    pass,
    taskHash: decision?.taskHash ?? null,
    executionShape: decision?.selectedShape ?? null,
    role: decision?.role ?? null,
    reasonCode: decision?.reasonCode ?? null,
    expected: {
      model: roleSpec?.model ?? null,
      effort: roleSpec?.effort ?? null,
      sandbox: roleSpec?.sandbox ?? null,
      depth: actual.depth,
      roleHash,
    },
    actual,
    checks,
    changedFiles: files ?? [],
    retryCount,
    rollbackRequired: !pass,
    synthetic,
  };
}

export function validateDispatchResult({ result, decision, roleSpec }) {
  const checks = {
    exactEnvelope:
      hasExactKeys(result, RESULT_KEYS) &&
      hasExactKeys(result?.expected, EXPECTED_KEYS) &&
      hasExactKeys(result?.actual, ACTUAL_KEYS) &&
      hasExactKeys(result?.checks, REQUIRED_CHECKS),
    schemaVersion: result?.schemaVersion === 1,
    kind: result?.kind === "dispatch_result",
    exactShape: result?.executionShape === decision?.selectedShape,
    exactRole: result?.role === decision?.role,
    exactReason: result?.reasonCode === decision?.reasonCode,
    exactTask: result?.taskHash === decision?.taskHash,
    expectedModel: result?.expected?.model === roleSpec?.model,
    expectedEffort: result?.expected?.effort === roleSpec?.effort,
    expectedSandbox: result?.expected?.sandbox === roleSpec?.sandbox,
    expectedRoleHash:
      HASH.test(result?.expected?.roleHash ?? "") &&
      (decision?.roleHash === undefined || result?.expected?.roleHash === decision.roleHash),
    actualModel: result?.actual?.model === roleSpec?.model,
    actualEffort: result?.actual?.effort === roleSpec?.effort,
    actualSandbox: result?.actual?.sandbox === roleSpec?.sandbox,
    depthMatchesExpected: result?.actual?.depth === result?.expected?.depth,
    executionShapeDepth:
      (decision?.selectedShape === "isolated_role_root" && result?.actual?.depth === 0) ||
      (decision?.selectedShape === "typed_child" && result?.actual?.depth === 1),
    nativeRoleShape:
      (decision?.selectedShape === "isolated_role_root" && result?.actual?.nativeAgentRole === null) ||
      (decision?.selectedShape === "typed_child" && result?.actual?.nativeAgentRole === roleSpec?.name),
    allRuntimeChecks: REQUIRED_CHECKS.every((name) => result?.checks?.[name] === true),
    changedFiles: Array.isArray(result?.changedFiles) && result.changedFiles.every((path) => typeof path === "string"),
    passed: result?.pass === true,
    rollbackState: result?.rollbackRequired === false,
    retryBudget: Number.isInteger(result?.retryCount) && result.retryCount >= 0 && result.retryCount <= 1,
    synthetic: typeof result?.synthetic === "boolean",
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export function verifyIsolatedRoot({ summary, decision, roleSpec, roleHash, before, after, cleanup }) {
  const actual = runtimeFacts(summary, { depth: 0, nativeAgentRole: null });
  const files = changedFiles(after);
  const cleanupChecks = cleanupFacts(cleanup);
  const checks = {
    runtimePersisted: Boolean(
      summary?.sessionMeta &&
        summary?.turnContext &&
        actual.parentTokens !== null &&
        summary?.threadSource !== "subagent" &&
        childRole(summary) === null,
    ),
    modelMatches: actual.model === roleSpec?.model,
    effortMatches: actual.effort === roleSpec?.effort,
    sandboxMatches: actual.sandbox === roleSpec?.sandbox,
    taskHashMatches: HASH.test(decision?.taskHash ?? ""),
    roleHashMatches: HASH.test(roleHash ?? "") && (decision?.roleHash === undefined || decision.roleHash === roleHash),
    depthMatches: actual.depth === 0,
    noDescendants: spawnCalls(summary).length === 0,
    filesystemScope: Array.isArray(changedFiles(before)) && Array.isArray(files) && files.length === 0,
    ...cleanupChecks,
    deliverableValid:
      decision?.selectedShape === "isolated_role_root" &&
      decision?.role === roleSpec?.name,
  };
  return resultEnvelope({ decision, roleSpec, roleHash, actual, checks, changedFiles: files });
}

export function verifyTypedChildResult({ parent, child, decision, roleSpec, roleHash, before, after, cleanup }) {
  const parentSpawns = spawnCalls(parent);
  const spawnArgs = parentSpawns[0]?.args ?? {};
  const spawnValidation = validateTypedSpawnArgs(spawnArgs);
  const actual = runtimeFacts(child, {
    depth: childDepth(child),
    nativeAgentRole: childRole(child),
    childTokens: tokenTotal(child),
  });
  actual.parentTokens = tokenTotal(parent);
  const files = changedFiles(after);
  const cleanupChecks = cleanupFacts(cleanup);
  const checks = {
    runtimePersisted: Boolean(
      parent?.sessionMeta &&
        child?.sessionMeta &&
        child?.turnContext &&
        actual.parentTokens !== null &&
        actual.childTokens !== null,
    ),
    modelMatches: actual.model === roleSpec?.model,
    effortMatches: actual.effort === roleSpec?.effort,
    sandboxMatches: actual.sandbox === roleSpec?.sandbox,
    taskHashMatches: HASH.test(decision?.taskHash ?? ""),
    roleHashMatches: HASH.test(roleHash ?? "") && (decision?.roleHash === undefined || decision.roleHash === roleHash),
    depthMatches: actual.depth === 1,
    noDescendants: spawnCalls(child).length === 0,
    filesystemScope: Array.isArray(changedFiles(before)) && Array.isArray(files),
    ...cleanupChecks,
    deliverableValid:
      decision?.selectedShape === "typed_child" &&
      decision?.role === roleSpec?.name &&
      parentSpawns.length === 1 &&
      spawnValidation.pass &&
      spawnArgs.agent_type === roleSpec?.name &&
      actual.nativeAgentRole === roleSpec?.name,
  };
  return resultEnvelope({ decision, roleSpec, roleHash, actual, checks, changedFiles: files });
}

export function classifyDispatchFailure(result) {
  const checks = result?.checks ?? {};
  if (checks.filesystemScope !== true) {
    return {
      retryAllowed: false,
      fallbackReason: "ROOT_PERMISSION_VIOLATION",
      rollbackRequired: true,
    };
  }
  const hardFailure = [
    "runtimePersisted",
    "modelMatches",
    "effortMatches",
    "sandboxMatches",
    "taskHashMatches",
    "roleHashMatches",
    "depthMatches",
    "noDescendants",
    "commandExitedZero",
    "commandDidNotTimeout",
    "cleanupPassed",
  ].some((name) => checks[name] !== true);
  if (hardFailure) {
    return {
      retryAllowed: false,
      fallbackReason: "ROOT_RUNTIME_EVIDENCE_FAILED",
      rollbackRequired: true,
    };
  }
  if (checks.deliverableValid !== true && result?.retryCount === 0) {
    return {
      retryAllowed: true,
      fallbackReason: "ROOT_CHILD_RESULT_REJECTED",
      rollbackRequired: false,
    };
  }
  return {
    retryAllowed: false,
    fallbackReason:
      checks.deliverableValid === true ? null : "ROOT_RETRY_BUDGET_EXHAUSTED",
    rollbackRequired: false,
  };
}
