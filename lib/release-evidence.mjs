import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export const RELEASE_EVIDENCE_ARTIFACTS = Object.freeze([
  "docs/RELEASE_EVIDENCE.md",
  "docs/release-evidence.json",
]);

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

export function renderReleaseEvidence(evidence) {
  const role = evidence.runtime?.roleSmoke ?? {};
  const sdd = evidence.runtime?.sddAdapter ?? {};
  const cost = evidence.costEvidence ?? {};
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
  return `# Release evidence

This file is generated from \`docs/release-evidence.json\`. Manual edits fail
\`npm run release:check\`.

## Deterministic checks

- Generated: ${evidence.generatedAt}
- Source manifest: \`${evidence.source?.sha256 ?? "unavailable"}\` (${evidence.source?.fileCount ?? 0} files)
- Tests: ${tests.status === "pass" ? "PASS" : "FAIL"} (${tests.passed ?? 0}/${tests.total ?? 0})

## Runtime evidence

- Six-role smoke: ${role.status === "pass" ? "PASS" : "NOT VERIFIED"} (${role.passedRoleCount ?? 0}/${role.expectedRoleCount ?? 0}), root metadata ${role.rootVerified ? "verified" : "unverified"}, commit \`${shortCommit(role.commit)}\`
- SDD adapter probe: ${sdd.status === "pass" ? "PASS" : "NOT VERIFIED"} (${(sdd.phases ?? []).join(" -> ") || "no phases"}), commit \`${shortCommit(sdd.commit)}\`
${roleTable}

Runtime reports remain local and ignored. This public evidence contains only
sanitized pass/fail summaries and immutable source identifiers.

## Real-work cost evidence

- Complete comparable pairs: ${cost.completePairCount ?? 0}/${cost.requiredPairCount ?? 10}
- Eligible for a dated estimate: ${cost.eligibleForEstimate ? "yes" : "no"}
- Estimator published: ${cost.estimatorPublished ? "yes" : "no"}

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
    costBoundary:
      cost.kind === "real_work" &&
      Number.isInteger(completePairCount) &&
      completePairCount >= 0 &&
      requiredPairCount === 10 &&
      cost.eligibleForEstimate === expectedEligibility &&
      cost.estimatorPublished === false,
    hardHookBoundary:
      evidence?.limitations?.coreRuntimeHook === "out_of_scope",
    markdownMatches:
      typeof markdown === "string" &&
      evidence?.renderedMarkdownSha256 === sha256(markdown) &&
      markdown === renderReleaseEvidence(evidence),
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}
