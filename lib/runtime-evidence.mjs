import { createHash } from "node:crypto";
import { validateAcceptanceEvidence } from "./acceptance-exam.mjs";

export const SMOKE_REUSE_TTL_MS = 30 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;
const GIT_HEAD = /^[a-f0-9]{40,64}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeHashes(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, hash]) => [key, hash]),
  );
}

function bindingPayload({
  gitHead,
  gitClean,
  gitStatusSha256,
  codexVersion,
  configSha256,
  roleHashes,
  runtimeHashes,
}) {
  return {
    schemaVersion: 1,
    git: {
      head: gitHead,
      clean: gitClean,
      statusSha256: gitStatusSha256,
    },
    codexVersion,
    configSha256,
    roleHashes: normalizeHashes(roleHashes),
    runtimeHashes: normalizeHashes(runtimeHashes),
  };
}

export function createRuntimeBinding({
  gitHead,
  gitStatus,
  codexVersion,
  configSha256,
  roleHashes,
  runtimeHashes,
}) {
  const normalizedStatus = typeof gitStatus === "string" ? gitStatus : "[invalid]";
  const payload = bindingPayload({
    gitHead,
    gitClean: normalizedStatus.length === 0,
    gitStatusSha256: sha256(normalizedStatus),
    codexVersion,
    configSha256,
    roleHashes,
    runtimeHashes,
  });
  return { ...payload, sha256: sha256(stableJson(payload)) };
}

export function validateRuntimeBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expectedKeys = [
    "codexVersion",
    "configSha256",
    "git",
    "roleHashes",
    "runtimeHashes",
    "schemaVersion",
    "sha256",
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    return false;
  }
  if (
    value.schemaVersion !== 1 ||
    typeof value.codexVersion !== "string" ||
    value.codexVersion.trim().length === 0 ||
    !SHA256.test(value.configSha256 ?? "") ||
    !SHA256.test(value.sha256 ?? "") ||
    !value.git ||
    typeof value.git !== "object" ||
    Array.isArray(value.git) ||
    JSON.stringify(Object.keys(value.git).sort()) !==
      JSON.stringify(["clean", "head", "statusSha256"]) ||
    !GIT_HEAD.test(value.git.head ?? "") ||
    typeof value.git.clean !== "boolean" ||
    !SHA256.test(value.git.statusSha256 ?? "")
  ) {
    return false;
  }
  for (const hashes of [value.roleHashes, value.runtimeHashes]) {
    if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) return false;
    if (Object.keys(hashes).length === 0) return false;
    if (Object.values(hashes).some((hash) => !SHA256.test(hash ?? ""))) return false;
  }
  const payload = bindingPayload({
    gitHead: value.git.head,
    gitClean: value.git.clean,
    gitStatusSha256: value.git.statusSha256,
    codexVersion: value.codexVersion,
    configSha256: value.configSha256,
    roleHashes: value.roleHashes,
    runtimeHashes: value.runtimeHashes,
  });
  return sha256(stableJson(payload)) === value.sha256;
}

const REQUIRED_ROLE_CHECKS = Object.freeze([
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
]);

export function validateRoleSmokeEvidence(report, expectedRoles, expectedRoot) {
  const roles = Array.isArray(report?.roles) ? report.roles : [];
  const specs = Array.isArray(expectedRoles) ? expectedRoles : [];
  const exactRoles =
    specs.length > 0 &&
    roles.length === specs.length &&
    roles.every((role, index) => {
      const spec = specs[index];
      const actual = role?.actual ?? {};
      const expected = role?.expected ?? {};
      const roleChecks = role?.checks ?? {};
      const runtimeChecks = role?.runtimeChecks ?? {};
      return (
        role?.role === spec.name &&
        role?.pass === true &&
        expected.parentModel === report?.rootRuntime?.model &&
        expected.parentEffort === report?.rootRuntime?.effort &&
        expected.model === spec.model &&
        expected.effort === spec.effort &&
        expected.sandbox === spec.sandbox &&
        expected.depth === 1 &&
        expected.forkTurns === "none" &&
        actual.parentModel === report?.rootRuntime?.model &&
        actual.parentEffort === report?.rootRuntime?.effort &&
        actual.role === spec.name &&
        actual.model === spec.model &&
        actual.effort === spec.effort &&
        actual.sandbox === spec.sandbox &&
        actual.depth === 1 &&
        Number.isFinite(actual.parentTokenUsage?.total_tokens) &&
        Number.isFinite(actual.tokenUsage?.total_tokens) &&
        REQUIRED_ROLE_CHECKS.every((name) => roleChecks[name] === true) &&
        runtimeChecks.commandExitedZero === true &&
        runtimeChecks.commandDidNotTimeout === true &&
        runtimeChecks.noReservedSchemaMismatch === true &&
        runtimeChecks.filesystemScope === true &&
        runtimeChecks.temporaryArtifactsCleaned === true &&
        role?.command?.exitCode === 0 &&
        role?.command?.timedOut === false &&
        role?.command?.schemaMismatch === false &&
        role?.cleanup?.pass === true
      );
    });
  const checks = {
    reportSchema: report?.schemaVersion === 2,
    reportPassed: report?.pass === true,
    exactRoleCount:
      report?.expectedRoleCount === specs.length && roles.length === specs.length,
    exactRoles,
    rootVerified:
      typeof expectedRoot?.model === "string" &&
      typeof expectedRoot?.effort === "string" &&
      report?.rootRuntime?.model === expectedRoot.model &&
      report?.rootRuntime?.effort === expectedRoot.effort &&
      report?.rootRuntime?.verified === true,
    globalConfigUnchanged: report?.globalConfigUnchanged === true,
    bindingValid: validateRuntimeBinding(report?.runtimeBinding),
    configBound:
      report?.globalConfigBeforeSha256 === report?.runtimeBinding?.configSha256 &&
      report?.globalConfigAfterSha256 === report?.runtimeBinding?.configSha256,
    bindingStable:
      report?.runtimeBindingStable === true &&
      report?.runtimeBindingAfterSha256 === report?.runtimeBinding?.sha256,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export function validateTrustedSmoke({
  report,
  currentBinding,
  expectedRoles,
  expectedRoot,
  nowMs = Date.now(),
  ttlMs = SMOKE_REUSE_TTL_MS,
}) {
  const generatedAtMs = Date.parse(report?.generatedAt ?? "");
  const ageMs = Number.isFinite(generatedAtMs) ? nowMs - generatedAtMs : null;
  const roleEvidence = validateRoleSmokeEvidence(
    report,
    expectedRoles,
    expectedRoot,
  );
  const reportBindingValid = validateRuntimeBinding(report?.runtimeBinding);
  const currentBindingValid = validateRuntimeBinding(currentBinding);
  const checks = {
    roleEvidence: roleEvidence.pass,
    reportBindingValid,
    currentBindingValid,
    smokeBindingStable:
      report?.runtimeBindingStable === true &&
      report?.runtimeBindingAfterSha256 === report?.runtimeBinding?.sha256,
    currentTreeClean: currentBindingValid && currentBinding.git.clean === true,
    bindingMatchesCurrent:
      reportBindingValid &&
      currentBindingValid &&
      report.runtimeBinding.sha256 === currentBinding.sha256,
    timestampValid: Number.isFinite(generatedAtMs),
    notFromFuture: ageMs !== null && ageMs >= -MAX_FUTURE_SKEW_MS,
    withinTtl:
      Number.isFinite(ttlMs) &&
      ttlMs > 0 &&
      ageMs !== null &&
      ageMs <= ttlMs,
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    ageMs,
    ttlMs,
  };
}

export function validateTrustedAcceptance({
  report,
  currentBinding,
  nowMs = Date.now(),
  ttlMs = SMOKE_REUSE_TTL_MS,
  reportFile = null,
}) {
  const generatedAtMs = Date.parse(report?.generatedAt ?? "");
  const ageMs = Number.isFinite(generatedAtMs) ? nowMs - generatedAtMs : null;
  const evidence = validateAcceptanceEvidence(report);
  const reportBindingValid = validateRuntimeBinding(report?.runtimeBinding);
  const currentBindingValid = validateRuntimeBinding(currentBinding);
  const checks = {
    acceptanceEvidence: evidence.pass,
    reportBindingValid,
    currentBindingValid,
    currentTreeClean: currentBindingValid && currentBinding.git.clean === true,
    bindingMatchesCurrent:
      reportBindingValid && currentBindingValid &&
      report.runtimeBinding.sha256 === currentBinding.sha256,
    timestampValid: Number.isFinite(generatedAtMs),
    notFromFuture: ageMs !== null && ageMs >= -MAX_FUTURE_SKEW_MS,
    withinTtl: Number.isFinite(ttlMs) && ttlMs > 0 && ageMs !== null && ageMs <= ttlMs,
    reportPathConfined: reportFile?.pathConfined === true,
    reportRegular: reportFile?.regular === true && reportFile?.symlink === false,
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    ageMs,
    ttlMs,
  };
}

const SDD_PHASES = Object.freeze([
  {
    role: "terra_worker",
    model: "gpt-5.6-terra",
    effort: "high",
    sandbox: "workspace-write",
  },
  {
    role: "sol_reviewer",
    model: "gpt-5.6-sol",
    effort: "high",
    sandbox: "read-only",
  },
]);

function phaseMatches(phase, expected) {
  const checks = phase?.checks ?? {};
  const runtimeChecks = phase?.runtimeChecks ?? {};
  return (
    phase?.role === expected.role &&
    phase?.pass === true &&
    phase?.actual?.role === expected.role &&
    phase.actual.parentModel === "gpt-5.6-sol" &&
    phase.actual.parentEffort === "max" &&
    phase.actual.model === expected.model &&
    phase.actual.effort === expected.effort &&
    phase.actual.sandbox === expected.sandbox &&
    phase.actual.depth === 1 &&
    Number.isFinite(phase.actual.parentTokenUsage?.total_tokens) &&
    Number.isFinite(phase.actual.tokenUsage?.total_tokens) &&
    REQUIRED_ROLE_CHECKS.every((name) => checks[name] === true) &&
    runtimeChecks.commandExitedZero === true &&
    runtimeChecks.commandDidNotTimeout === true &&
    runtimeChecks.noReservedSchemaMismatch === true &&
    runtimeChecks.filesystemScope === true &&
    runtimeChecks.temporaryArtifactsCleaned === true &&
    phase?.command?.exitCode === 0 &&
    phase?.command?.timedOut === false &&
    phase?.command?.schemaMismatch === false &&
    phase?.cleanup?.pass === true
  );
}

export function validateSddAdapterEvidence(report) {
  const phases = Array.isArray(report?.phases) ? report.phases : [];
  const workerCompletedAt = Date.parse(phases[0]?.completedAt ?? "");
  const reviewerStartedAt = Date.parse(phases[1]?.startedAt ?? "");
  const sequence = report?.sequenceChecks ?? {};
  const checks = {
    schemaVersion: report?.schemaVersion === 1,
    contractKind: report?.kind === "sdd_adapter_contract",
    reportPassed: report?.pass === true,
    timestampValid: Number.isFinite(Date.parse(report?.generatedAt ?? "")),
    exactPhases:
      phases.length === SDD_PHASES.length &&
      phases.every((phase, index) => phaseMatches(phase, SDD_PHASES[index])),
    phasesSequential:
      Number.isFinite(workerCompletedAt) &&
      Number.isFinite(reviewerStartedAt) &&
      workerCompletedAt <= reviewerStartedAt,
    sequenceChecks:
      sequence.workerCompletedBeforeReview === true &&
      sequence.workerChangedOnlyTarget === true &&
      sequence.reviewerObservedFinalState === true &&
      sequence.reviewerChangedNoFiles === true,
    globalConfigUnchanged: report?.globalConfigUnchanged === true,
    bindingValid: validateRuntimeBinding(report?.runtimeBinding),
    configBound:
      report?.globalConfigBeforeSha256 === report?.runtimeBinding?.configSha256 &&
      report?.globalConfigAfterSha256 === report?.runtimeBinding?.configSha256,
    bindingStable:
      report?.runtimeBindingStable === true &&
      report?.runtimeBindingAfterSha256 === report?.runtimeBinding?.sha256,
    cleanup: report?.cleanup?.pass === true,
    boundary:
      report?.boundary?.workflow === "superpowers:subagent-driven-development" &&
      report?.boundary?.verification === "adapter_contract" &&
      report?.boundary?.codexCoreHookTested === false &&
      report?.boundary?.permissionStrategy === "sequential_isolated_roots",
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}
