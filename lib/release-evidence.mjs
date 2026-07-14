import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateObservedUsageReport } from "./cost-evidence.mjs";

export const RELEASE_EVIDENCE_ARTIFACTS = Object.freeze([
  "docs/RELEASE_EVIDENCE.md",
  "docs/release-evidence.json",
]);

const ACCEPTANCE_EXAM_FIELDS = Object.freeze([
  "activeEligible",
  "executionShapes",
  "generatedAt",
  "pass",
  "passedQuestionCount",
  "questionCount",
  "runtimeBindingSha256",
]);
const ACCEPTANCE_EXECUTION_SHAPES = Object.freeze([
  "isolated_role_root",
  "root_inline",
  "typed_child",
]);
const ACTIVE_INSTALLATION_FIELDS = Object.freeze([
  "activeConfigSha256",
  "allowTypedBridge",
  "installId",
  "integrity",
  "mode",
  "policySha256",
  "preInstallConfigSha256",
  "root",
  "status",
]);
const ACTIVE_ROOT_FIELDS = Object.freeze(["effort", "model", "persisted"]);
const SHA256 = /^[a-f0-9]{64}$/;

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

export function createSourceManifest(files) {
  const entries = Object.entries(files ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => [path, sha256(content)]);
  return {
    algorithm: "sha256",
    fileCount: entries.length,
    sha256: sha256(stableJson(entries)),
  };
}

export function evidenceSourcePaths(paths) {
  const excluded = new Set(RELEASE_EVIDENCE_ARTIFACTS);
  return [...paths]
    .filter((path) => !excluded.has(path) && !path.startsWith("reports/"))
    .sort();
}

export function runtimeBindingComponentsMatch(left, right) {
  if (!left || !right) return false;
  return (
    left.codexVersion === right.codexVersion &&
    left.configSha256 === right.configSha256 &&
    stableJson(left.roleHashes) === stableJson(right.roleHashes) &&
    stableJson(left.runtimeHashes) === stableJson(right.runtimeHashes)
  );
}

export function validateActiveConfigBinding({
  preInstallConfigSha256,
  activeConfigSha256,
  acceptanceConfigSha256,
  currentConfigSha256,
}) {
  return (
    SHA256.test(preInstallConfigSha256 ?? "") &&
    SHA256.test(activeConfigSha256 ?? "") &&
    acceptanceConfigSha256 === preInstallConfigSha256 &&
    currentConfigSha256 === activeConfigSha256
  );
}

export function validateAcceptanceExamSummary(value) {
  const exactFields =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...ACCEPTANCE_EXAM_FIELDS].sort());
  const executionShapes = Array.isArray(value?.executionShapes)
    ? [...value.executionShapes].sort()
    : [];
  const checks = {
    exactFields,
    passed: value?.pass === true && value?.activeEligible === true,
    generatedAt: Number.isFinite(Date.parse(value?.generatedAt ?? "")),
    questions:
      value?.questionCount === 10 &&
      value?.passedQuestionCount === 10,
    executionShapes:
      JSON.stringify(executionShapes) === JSON.stringify(ACCEPTANCE_EXECUTION_SHAPES),
    runtimeBindingSha256: SHA256.test(value?.runtimeBindingSha256 ?? ""),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export function validateActiveInstallationSummary(value) {
  const exactFields =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...ACTIVE_INSTALLATION_FIELDS].sort());
  const root = value?.root;
  const exactRootFields =
    root !== null &&
    typeof root === "object" &&
    !Array.isArray(root) &&
    JSON.stringify(Object.keys(root).sort()) ===
      JSON.stringify([...ACTIVE_ROOT_FIELDS].sort());
  const checks = {
    exactFields,
    applied:
      value?.status === "pass" &&
      value?.mode === "active" &&
      value?.integrity === "pass" &&
      value?.allowTypedBridge === false,
    installId:
      typeof value?.installId === "string" &&
      /^[A-Za-z0-9._-]+$/.test(value.installId),
    hashes:
      SHA256.test(value?.policySha256 ?? "") &&
      SHA256.test(value?.preInstallConfigSha256 ?? "") &&
      SHA256.test(value?.activeConfigSha256 ?? ""),
    root:
      exactRootFields &&
      root?.persisted === true &&
      root?.model === "gpt-5.6-sol" &&
      ["max", "ultra"].includes(root?.effort),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}

export async function createRepositorySourceManifest(root, paths) {
  const files = {};
  for (const path of evidenceSourcePaths(paths)) {
    const absolute = join(root, path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`source manifest refuses non-regular file: ${path}`);
    }
    files[path] = await readFile(absolute);
  }
  return createSourceManifest(files);
}

function shortCommit(value) {
  return typeof value === "string" ? value.slice(0, 12) : "unavailable";
}

function countLabel(value, singular, plural = `${singular}s`) {
  return `${value ?? 0} ${(value ?? 0) === 1 ? singular : plural}`;
}

function observedTokenTotal(role) {
  const tokens = role?.tokens ?? {};
  return (tokens.uncachedInput ?? 0) + (tokens.cachedInput ?? 0) + (tokens.output ?? 0);
}

export function renderReleaseEvidence(evidence) {
  const activation = evidence.runtime?.activation ?? {};
  const role = evidence.runtime?.roleSmoke ?? {};
  const sdd = evidence.runtime?.sddAdapter ?? {};
  const acceptance = evidence.runtime?.acceptanceExam ?? {};
  const cost = evidence.costEvidence ?? {};
  const observed = cost.observedRuntime ?? {};
  const tests = evidence.tests ?? {};
  const roleRows = (role.roles ?? [])
    .map(
      (item) =>
        `| \`${item.role}\` | \`${item.model}\` | ${item.effort} | ${item.sandbox} | ${item.parentTokens} | ${item.childTokens} | ${item.pass ? "PASS" : "FAIL"} |`,
    )
    .join("\n");
  const roleTable = roleRows
    ? `\n| Role | Actual model | Effort | Sandbox | Parent tokens | Child tokens | Status |\n|---|---|---|---|---:|---:|---|\n${roleRows}\n`
    : "";
  const observedRows = (observed.roles ?? [])
    .map(
      (item) =>
        `| \`${item.role}\` | \`${item.model}\` | ${item.effort} | ${item.sessions} | ${item.completedTurns} | ${observedTokenTotal(item)} | ${item.policyCompliantSessions}/${item.sessions} |`,
    )
    .join("\n");
  const observedTable = observedRows
    ? `\n| Role | Actual model | Effort | Sessions | Completed turns | Child tokens | Policy compliant |\n|---|---|---|---:|---:|---:|---:|\n${observedRows}\n`
    : "";
  return `# Release evidence

This file is generated from \`docs/release-evidence.json\`. Manual edits fail
\`npm run release:check\`.

## Deterministic checks

- Generated: ${evidence.generatedAt}
- Source manifest: \`${evidence.source?.sha256 ?? "unavailable"}\` (${evidence.source?.fileCount ?? 0} files)
- Tests: ${tests.status === "pass" ? "PASS" : "FAIL"} (${tests.passed ?? 0}/${tests.total ?? 0})

## Runtime evidence

- Active installation: ${activation.status === "pass" ? "PASS" : "NOT VERIFIED"}; integrity ${activation.integrity ?? "unavailable"}; bridge ${activation.allowTypedBridge === false ? "disabled" : "unverified"}; fresh root \`${activation.root?.model ?? "unavailable"}\` / ${activation.root?.effort ?? "unavailable"}
- Bound config state: \`${shortCommit(activation.preInstallConfigSha256)}\` -> \`${shortCommit(activation.activeConfigSha256)}\` (${activation.preInstallConfigSha256 === activation.activeConfigSha256 ? "unchanged" : "updated"}); policy \`${shortCommit(activation.policySha256)}\`
- Six-role smoke: ${role.status === "pass" ? "PASS" : "NOT VERIFIED"} (${role.passedRoleCount ?? 0}/${role.expectedRoleCount ?? 0}), root metadata ${role.rootVerified ? "verified" : "unverified"}, commit \`${shortCommit(role.commit)}\`
- SDD adapter probe: ${sdd.status === "pass" ? "PASS" : "NOT VERIFIED"} (${(sdd.phases ?? []).join(" -> ") || "no phases"}), commit \`${shortCommit(sdd.commit)}\`
- Ten-question acceptance exam: ${acceptance.pass === true ? "PASS" : "NOT VERIFIED"} (${acceptance.passedQuestionCount ?? 0}/${acceptance.questionCount ?? 0}), active eligible: ${acceptance.activeEligible === true ? "yes" : "no"}
- Acceptance execution shapes: ${(acceptance.executionShapes ?? []).map((shape) => `\`${shape}\``).join(", ") || "unavailable"}; runtime binding \`${shortCommit(acceptance.runtimeBindingSha256)}\`
${roleTable}

Runtime reports remain local and ignored. This public evidence contains only
sanitized pass/fail summaries and immutable source identifiers.

## Real-work cost evidence

- Observed typed child runtime: ${countLabel(observed.childSessionCount, "session")}, ${countLabel(observed.completedTurnCount, "completed turn")} across ${countLabel(observed.parentThreadCount, "parent thread")}
- Runtime metadata verified: ${observed.runtimeMetadataVerifiedSessionCount ?? 0}/${observed.childSessionCount ?? 0}; explicit \`fork_turns=none\`: ${observed.forkNoneSessionCount ?? 0}/${observed.childSessionCount ?? 0}; nested spawn sessions: ${observed.nestedSpawnSessionCount ?? 0}
- Policy-compliant sessions: ${observed.policyCompliantSessionCount ?? 0}/${observed.childSessionCount ?? 0}; rejected: ${observed.policyRejectedSessionCount ?? 0} (permission mismatch: ${observed.permissionMismatchSessionCount ?? 0}; spawn override mismatch: ${observed.spawnOverrideMismatchSessionCount ?? 0})
${observedTable}

- Complete comparable pairs: ${cost.completePairCount ?? 0}/${cost.requiredPairCount ?? 10}
- Eligible for a dated estimate: ${cost.eligibleForEstimate ? "yes" : "no"}
- Estimator published: ${cost.estimatorPublished ? "yes" : "no"}

Child-only runtime evidence is not a root-inclusive task cost or an A/B pair.
Smoke tokens are excluded. No price or savings claim is published before ten
accepted pairs of comparable real work exist.

## Explicit boundary

- Codex core runtime hook: out of scope for this repository.
- Gearbox remains an instruction-level pre-spawn gate plus persisted runtime verification.
`;
}

export function finalizeReleaseEvidence(draft) {
  const { renderedMarkdownSha256: _ignored, ...base } = draft;
  const markdown = renderReleaseEvidence(base);
  return { ...base, renderedMarkdownSha256: sha256(markdown) };
}

export function validateReleaseEvidence({ evidence, markdown, currentSource }) {
  const cost = evidence?.costEvidence ?? {};
  const observedRuntime = validateObservedUsageReport(cost.observedRuntime);
  const acceptanceExam = validateAcceptanceExamSummary(evidence?.runtime?.acceptanceExam);
  const activeInstallation = validateActiveInstallationSummary(
    evidence?.runtime?.activation,
  );
  const completePairCount = cost.completePairCount;
  const requiredPairCount = cost.requiredPairCount;
  const expectedEligibility =
    Number.isInteger(completePairCount) &&
    Number.isInteger(requiredPairCount) &&
    requiredPairCount === 10 &&
    completePairCount >= requiredPairCount;
  const checks = {
    schemaVersion: evidence?.schemaVersion === 1,
    timestampValid: Number.isFinite(Date.parse(evidence?.generatedAt ?? "")),
    sourceMatches:
      evidence?.source?.algorithm === "sha256" &&
      evidence?.source?.sha256 === currentSource?.sha256 &&
      evidence?.source?.fileCount === currentSource?.fileCount,
    testsPassed:
      evidence?.tests?.status === "pass" &&
      Number.isInteger(evidence?.tests?.total) &&
      evidence.tests.total > 0 &&
      evidence.tests.passed === evidence.tests.total &&
      evidence.tests.failed === 0,
    roleSmokePassed:
      evidence?.runtime?.roleSmoke?.status === "pass" &&
      evidence.runtime.roleSmoke.expectedRoleCount ===
        evidence.runtime.roleSmoke.passedRoleCount &&
      evidence.runtime.roleSmoke.rootVerified === true,
    sddAdapterPassed:
      evidence?.runtime?.sddAdapter?.status === "pass" &&
      JSON.stringify(evidence.runtime.sddAdapter.phases) ===
        JSON.stringify(["terra_worker", "sol_reviewer"]),
    acceptanceExam: acceptanceExam.pass,
    activeInstallation: activeInstallation.pass,
    costBoundary:
      cost.kind === "real_work" &&
      Number.isInteger(completePairCount) &&
      completePairCount >= 0 &&
      requiredPairCount === 10 &&
      cost.eligibleForEstimate === expectedEligibility &&
      cost.estimatorPublished === false,
    observedRuntimeBoundary: observedRuntime.valid,
    hardHookBoundary:
      evidence?.limitations?.coreRuntimeHook === "out_of_scope",
    markdownMatches:
      typeof markdown === "string" &&
      evidence?.renderedMarkdownSha256 === sha256(markdown) &&
      markdown === renderReleaseEvidence(evidence),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}
