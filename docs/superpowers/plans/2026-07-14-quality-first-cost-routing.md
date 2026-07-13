# Quality-First Cost Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic quality-first routing, verified Terra/Luna isolated-root execution, privacy-safe evidence, a ten-question acceptance exam, and fail-closed active-mode installation to Sol Ultra Gearbox.

**Architecture:** The Sol root builds a bounded task packet and calls a pure planner before any supported delegation. Permission-matched work uses a native typed child; mismatched cheap read-only work runs as a directly configured Terra or Luna isolated root, not behind another Sol parent. Persisted runtime evidence and filesystem checks gate result acceptance, and managed apply writes `active` policy only after current role smoke plus the owner-witnessed acceptance exam pass.

**Tech Stack:** Node.js 20+ ESM, `node:test`, Codex CLI JSON execution, TOML role profiles, JSON runtime evidence, Bash launch wrappers, no production dependencies.

## Global Constraints

- Keep Sol Ultra as the interactive root and final verifier; the new routing layer must not replace or downgrade it.
- Quality is a hard gate. Cost is evaluated only after requirements, risk, permissions, scope, and verification pass.
- Native children use `agent_type`, `fork_turns="none"`, and no model, effort, or service-tier override.
- Parent and child permission modes must match for a native child.
- A permission-mismatched cheap read-only route launches Terra or Luna directly as an isolated root; it must not launch an extra Sol parent.
- Only `luna_clerk` and `terra_explorer` are eligible for automatic isolated-root execution in the first active release.
- `terra_worker` remains the normal bounded writer. `terra_max_worker` and `terra_ultra_specialist` remain explicit opt-in side lanes.
- `allowTypedBridge` is installed as `false`; no bridge execution path is enabled by this plan.
- At most two direct native children, depth one, no descendants, and at most one writer with an exclusive scope.
- Missing or mismatched runtime metadata, unexpected writes, descendants, cleanup failure, or unmanaged policy drift is a hard failure.
- All unit and dry-run integration tests use temporary directories and must not mutate the real `~/.codex`.
- Only `node scripts/gearbox.mjs apply --promote-v2`, matching rollback, and `node scripts/skill.mjs install|uninstall --apply` may write global state.
- Do not add a production dependency.
- Keep raw `reports/` local and ignored. Never commit complete config, auth state, tokens, prompts, private absolute paths, rollout contents, or raw session identifiers.
- Do not publish a percentage-savings estimator before ten complete root-inclusive A/B pairs exist.
- The enforcement boundary remains instruction-level plus managed runner; documentation must not claim a Codex core hook.

---

## File Structure

| Path | Responsibility |
|---|---|
| `lib/dispatch-planner.mjs` | Pure packet validation, quality/cost gates, role mapping, permission-aware shape selection, and reason codes. |
| `lib/dispatch-policy.mjs` | Canonical managed policy creation, integrity hash, load-as-off fallback, and unmanaged-target refusal. |
| `lib/dispatch-evidence.mjs` | Typed-child and isolated-root result-envelope validation. |
| `lib/dispatch-ledger.mjs` | Privacy-safe dispatch records and ignored JSONL append logic. |
| `lib/dispatch-runner.mjs` | Direct Terra/Luna isolated-root argument construction, process lifecycle, rollout verification, filesystem diff, and cleanup. |
| `lib/acceptance-exam.mjs` | Ten deterministic scenarios, result aggregation, and trusted exam validation. |
| `scripts/gearbox-dispatch.mjs` | Managed runtime CLI for `plan`, `run-isolated`, `validate`, and `status`. |
| `scripts/gearbox-dispatch` | Stable installed wrapper that finds the managed runtime beneath `CODEX_HOME`. |
| `scripts/gearbox.mjs` | Doctor integration, paid exam orchestration, trusted exam reuse, managed active apply, post-install readback, and rollback. |
| `lib/gearbox.mjs` | Runtime install inventory, managed AGENTS policy text, owned temp-path allowlist, and shared role source validation. |
| `lib/runtime-evidence.mjs` | Current-commit/TTL binding validation for the acceptance report. |
| `skills/sol-ultra-gearbox/` | User-facing active routing contract and adapter instructions. |
| `tests/dispatch-*.test.mjs` | Pure planner, policy, evidence, ledger, CLI, and runner regression tests. |
| `tests/acceptance-exam.test.mjs` | Fake-runtime coverage for all ten exam questions and activation gating. |
| `tests/helpers/fake-codex.mjs` | Disposable Codex CLI fixture that emits controlled JSON/runtime evidence without paid calls. |
| `README.md`, `docs/RELEASE_EVIDENCE.md`, `docs/release-evidence.json` | Public boundaries, commands, and generated redacted evidence. |

The design source is
`docs/superpowers/specs/2026-07-14-quality-first-cost-routing-design.md`.

---

### Task 1: Pure Task Packet and Dispatch Planner

**Files:**
- Create: `lib/dispatch-planner.mjs`
- Create: `tests/dispatch-planner.test.mjs`

**Interfaces:**
- Produces: `validateTaskPacket(packet) -> { pass, errors }`
- Produces: `hashTaskPacket(packet) -> sha256 string`
- Produces: `renderTaskMessage(packet) -> self-contained child message`
- Produces: `planDispatch({ policy, packet, capabilities, roleSpecs }) -> decision`
- Produces decision fields: `schemaVersion`, `taskHash`, `policyMode`, `selectedShape`, `effectiveShape`, `role`, `reasonCode`, `spawnArgs`, `requiresRuntimeEvidence`
- Consumes: role objects shaped as `{ name, model, effort, sandbox, legacy? }`

- [ ] **Step 1: Write failing planner decision-table tests**

Create `tests/dispatch-planner.test.mjs` with a complete valid packet helper and
table-driven assertions for trivial, high-risk, unknown-skill, schema-missing,
typed-child, isolated-root, writer-mismatch, bridge-disabled, shadow, and
opt-in specialist behavior:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { ROLE_SPECS } from "../lib/gearbox.mjs";
import {
  planDispatch,
  validateTaskPacket,
} from "../lib/dispatch-planner.mjs";

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
  runtimeMetadataAvailable: true,
  bridgeRuntimeVerified: false,
  permissionBypassActive: false,
};

test("valid packet selects an isolated Terra root for read-only permission mismatch", () => {
  assert.equal(validateTaskPacket(packet()).pass, true);
  const decision = planDispatch({
    policy: ACTIVE,
    packet: packet(),
    capabilities: CAPABILITIES,
    roleSpecs: ROLE_SPECS,
  });
  assert.equal(decision.selectedShape, "isolated_role_root");
  assert.equal(decision.effectiveShape, "isolated_role_root");
  assert.equal(decision.role, "terra_explorer");
  assert.equal(
    decision.reasonCode,
    "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH",
  );
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
    const decision = planDispatch({
      policy: ACTIVE,
      packet: value,
      capabilities: CAPABILITIES,
      roleSpecs: ROLE_SPECS,
    });
    assert.equal(decision.effectiveShape, "root_inline");
    assert.equal(decision.reasonCode, reasonCode);
  }
});

test("shadow records the recommendation but executes root-inline", () => {
  const decision = planDispatch({
    policy: { mode: "shadow", allowTypedBridge: false },
    packet: packet(),
    capabilities: CAPABILITIES,
    roleSpecs: ROLE_SPECS,
  });
  assert.equal(decision.selectedShape, "isolated_role_root");
  assert.equal(decision.effectiveShape, "root_inline");
});
```

- [ ] **Step 2: Run the planner test and confirm the missing-module failure**

Run: `node --test tests/dispatch-planner.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for
`lib/dispatch-planner.mjs`.

- [ ] **Step 3: Implement exact constants, packet validation, gates, and decisions**

Create `lib/dispatch-planner.mjs`. Use these exported constants and keep the
planner free of filesystem, process, clock, and environment access:

```js
import { createHash } from "node:crypto";

export const EXECUTION_SHAPES = Object.freeze([
  "typed_child",
  "isolated_role_root",
  "typed_child_bridge",
  "root_inline",
]);

export const KNOWN_ADAPTERS = Object.freeze([
  "direct",
  "superpowers:subagent-driven-development",
  "superpowers:dispatching-parallel-agents",
  "superpowers:requesting-code-review",
  "codex-security:security-scan",
  "codex-security:security-diff-scan",
]);

export const RESPONSIBILITY_ROLES = Object.freeze({
  mechanical: "luna_clerk",
  exploration: "terra_explorer",
  implementation: "terra_worker",
  review: "sol_reviewer",
});

const HASH = /^[a-f0-9]{64}$/;
const PERMISSIONS = new Set(["read-only", "workspace-write"]);
const READ_ONLY_ISOLATED = new Set(["luna_clerk", "terra_explorer"]);
const OPT_IN = new Set(["terra_max_worker", "terra_ultra_specialist"]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

export function hashTaskPacket(packet) {
  return createHash("sha256").update(JSON.stringify(stable(packet))).digest("hex");
}

function section(label, value) {
  const lines = Array.isArray(value) ? value : [value];
  return `${label}:\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

export function renderTaskMessage(packet) {
  return [
    section("Goal", packet.goal),
    section("Allowed read scope", packet.readScope),
    section("Allowed write scope", packet.writeScope.length > 0 ? packet.writeScope : ["none"]),
    section("Known facts", packet.knownFacts),
    section("Constraints", packet.constraints),
    section("Expected deliverable", packet.deliverable),
    section("Success criteria", packet.successCriteria),
    section("Required checks", packet.checks),
    section("Prohibited actions", packet.prohibitedActions),
  ].join("\n\n");
}

export function validateTaskPacket(packet) {
  const errors = [];
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
    return { pass: false, errors: ["packet must be an object"] };
  }
  if (packet.schemaVersion !== 1) errors.push("schemaVersion must equal 1");
  for (const key of ["workflowAdapter", "responsibility", "goal", "deliverable"]) {
    if (typeof packet[key] !== "string" || packet[key].trim().length === 0) {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  for (const key of [
    "readScope",
    "writeScope",
    "knownFacts",
    "constraints",
    "successCriteria",
    "checks",
    "prohibitedActions",
  ]) {
    if (!Array.isArray(packet[key]) || packet[key].some((item) => typeof item !== "string")) {
      errors.push(`${key} must be an array of strings`);
    }
  }
  if (!PERMISSIONS.has(packet.parentPermission)) errors.push("invalid parentPermission");
  if (!PERMISSIONS.has(packet.requiredPermission)) errors.push("invalid requiredPermission");
  if (!packet.riskSignals || typeof packet.riskSignals !== "object") {
    errors.push("riskSignals must be an object");
  }
  if (!packet.costSignals || typeof packet.costSignals !== "object") {
    errors.push("costSignals must be an object");
  }
  if (
    !packet.batch ||
    !Number.isInteger(packet.batch.requestedChildren) ||
    !Number.isInteger(packet.batch.writerCount) ||
    typeof packet.batch.scopesDisjoint !== "boolean"
  ) {
    errors.push("batch must contain integer counts and scopesDisjoint");
  }
  return { pass: errors.length === 0, errors };
}

function rootDecision(taskHash, policyMode, reasonCode, role = null) {
  return {
    schemaVersion: 1,
    taskHash,
    policyMode,
    selectedShape: "root_inline",
    effectiveShape: "root_inline",
    role,
    reasonCode,
    spawnArgs: null,
    requiresRuntimeEvidence: false,
  };
}

function costBenefitPasses(cost, responsibility) {
  if (cost.estimatedRootToolCalls <= 2 || cost.oneLocation || cost.packagingDominates) return false;
  if (!cost.directlyConsumable) return false;
  return (
    cost.repetitiveReads >= 3 ||
    cost.moduleCount >= 2 ||
    cost.fileCount >= 5 ||
    cost.bytes >= 102_400 ||
    cost.lines >= 500 ||
    cost.itemCount >= 20 ||
    (responsibility === "implementation" && cost.includesRegressionTest) ||
    (responsibility === "implementation" && cost.boundedFileCount >= 2)
  );
}

export function planDispatch({ policy, packet, capabilities, roleSpecs }) {
  if (!policy || !["shadow", "active"].includes(policy.mode)) {
    throw new TypeError("planner requires a validated shadow or active policy");
  }
  const packetValidation = validateTaskPacket(packet);
  if (!packetValidation.pass) {
    throw new TypeError(`invalid task packet: ${packetValidation.errors.join("; ")}`);
  }
  const taskHash = hashTaskPacket(packet);
  if (!HASH.test(taskHash)) throw new TypeError("invalid task hash");
  if (!KNOWN_ADAPTERS.includes(packet.workflowAdapter)) {
    return rootDecision(taskHash, policy.mode, "ROOT_UNKNOWN_SKILL");
  }
  if (!capabilities.agentTypeVisible) {
    return rootDecision(taskHash, policy.mode, "ROOT_SCHEMA_UNAVAILABLE");
  }
  if (!capabilities.runtimeMetadataAvailable) {
    return rootDecision(taskHash, policy.mode, "ROOT_RUNTIME_EVIDENCE_FAILED");
  }
  if (capabilities.permissionBypassActive) {
    return rootDecision(taskHash, policy.mode, "ROOT_HIGH_RISK");
  }
  if (
    packet.batch.requestedChildren > 2 ||
    packet.batch.writerCount > 1 ||
    !packet.batch.scopesDisjoint ||
    (packet.responsibility === "implementation" && packet.batch.writerCount !== 1) ||
    (packet.responsibility !== "implementation" && packet.batch.writerCount !== 0)
  ) {
    return rootDecision(taskHash, policy.mode, "ROOT_SCOPE_AMBIGUOUS");
  }
  const risk = packet.riskSignals;
  if (risk.ambiguous) return rootDecision(taskHash, policy.mode, "ROOT_SCOPE_AMBIGUOUS");
  if (risk.hiddenCoupling) return rootDecision(taskHash, policy.mode, "ROOT_HIDDEN_COUPLING");
  if (risk.highRisk) return rootDecision(taskHash, policy.mode, "ROOT_HIGH_RISK");
  if (risk.weakVerification) return rootDecision(taskHash, policy.mode, "ROOT_WEAK_VERIFICATION");
  if (packet.costSignals.estimatedRootToolCalls <= 2 || packet.costSignals.oneLocation) {
    return rootDecision(taskHash, policy.mode, "ROOT_TRIVIAL");
  }
  if (!costBenefitPasses(packet.costSignals, packet.responsibility)) {
    return rootDecision(taskHash, policy.mode, "ROOT_COST_GATE_FAILED");
  }

  let role = packet.requestedRole ?? RESPONSIBILITY_ROLES[packet.responsibility];
  if (!role || !roleSpecs.some((spec) => spec.name === role)) {
    return rootDecision(taskHash, policy.mode, "ROOT_SCOPE_AMBIGUOUS");
  }
  if (OPT_IN.has(role) && !(packet.ownerOptIn || packet.legacyAdapter)) {
    return rootDecision(taskHash, policy.mode, "ROOT_SCOPE_AMBIGUOUS", role);
  }
  const spec = roleSpecs.find((candidate) => candidate.name === role);
  if (spec.sandbox !== packet.requiredPermission) {
    return rootDecision(taskHash, policy.mode, "ROOT_SCOPE_AMBIGUOUS", role);
  }

  let selectedShape;
  let reasonCode;
  if (packet.parentPermission === spec.sandbox) {
    selectedShape = "typed_child";
    reasonCode = "DELEGATE_TYPED_PERMISSION_MATCH";
  } else if (spec.sandbox === "workspace-write") {
    return rootDecision(taskHash, policy.mode, "ROOT_WRITER_PERMISSION_MISMATCH", role);
  } else if (packet.requiresNativeLineage || role === "sol_reviewer") {
    if (!(policy.allowTypedBridge && capabilities.bridgeRuntimeVerified)) {
      return rootDecision(taskHash, policy.mode, "ROOT_BRIDGE_DISABLED", role);
    }
    selectedShape = "typed_child_bridge";
    reasonCode = "DELEGATE_BRIDGE_LINEAGE_REQUIRED";
  } else if (READ_ONLY_ISOLATED.has(role)) {
    selectedShape = "isolated_role_root";
    reasonCode = "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH";
  } else {
    return rootDecision(taskHash, policy.mode, "ROOT_BRIDGE_DISABLED", role);
  }

  return {
    schemaVersion: 1,
    taskHash,
    policyMode: policy.mode,
    selectedShape,
    effectiveShape: policy.mode === "active" ? selectedShape : "root_inline",
    role,
    reasonCode,
    spawnArgs:
      selectedShape === "typed_child"
        ? {
            agent_type: role,
            fork_turns: "none",
            message: renderTaskMessage(packet),
          }
        : null,
    requiresRuntimeEvidence: true,
  };
}
```

- [ ] **Step 4: Add boundary cases for packet shape, direct-consumption, and exact specialist opt-in**

Add tests proving malformed packets throw, `directlyConsumable=false` produces
`ROOT_COST_GATE_FAILED`, `terra_max_worker` is rejected without opt-in, and
`terra_ultra_specialist` never becomes an automatic route. Assert the packet
validator rejects every missing or unrecognized top-level field and that a
typed-child message contains all nine task sections without parent history.
Add cases proving three requested children, two writers, overlapping scopes,
and active permission bypass all remain `root_inline`.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test tests/dispatch-planner.test.mjs`

Expected: all planner tests PASS.

Run: `npm test`

Expected: all repository tests PASS.

- [ ] **Step 6: Commit the planner**

```bash
git add lib/dispatch-planner.mjs tests/dispatch-planner.test.mjs
git commit -m "feat: add deterministic dispatch planner"
```

---

### Task 2: Managed Dispatch Policy Integrity

**Files:**
- Create: `lib/dispatch-policy.mjs`
- Create: `tests/dispatch-policy.test.mjs`

**Interfaces:**
- Produces: `createDispatchPolicy({ mode, allowTypedBridge, activation }) -> signed policy`
- Produces: `serializeDispatchPolicy(policy) -> canonical JSON with newline`
- Produces: `validateDispatchPolicy(policy) -> { pass, errors }`
- Produces: `loadDispatchPolicy(path) -> { state, policy, error }`
- Produces: `assertManagedPolicyTarget(source) -> parsed policy or throw`
- Produces: `DISPATCH_POLICY_RELATIVE_PATH = "gearbox/dispatch-policy.json"`

- [ ] **Step 1: Write failing integrity and fail-off tests**

```js
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertManagedPolicyTarget,
  createDispatchPolicy,
  loadDispatchPolicy,
  validateDispatchPolicy,
} from "../lib/dispatch-policy.mjs";

test("active policy is canonical, signed, and bridge-disabled", () => {
  const policy = createDispatchPolicy({
    mode: "active",
    allowTypedBridge: false,
    activation: {
      installId: "20260714-example",
      manifestPath: "/tmp/example/reports/install-manifest.json",
    },
  });
  assert.equal(validateDispatchPolicy(policy).pass, true);
  assert.equal(policy.managedBy, "sol-ultra-gearbox-v2");
  assert.equal(policy.mode, "active");
  assert.equal(policy.allowTypedBridge, false);
});

test("missing or tampered policy resolves off", async () => {
  const root = await mkdtemp(join(tmpdir(), "gearbox-policy-test-"));
  assert.equal((await loadDispatchPolicy(join(root, "missing.json"))).state, "off");
  const path = join(root, "dispatch-policy.json");
  const policy = createDispatchPolicy({
    mode: "active",
    allowTypedBridge: false,
    activation: {
      installId: "20260714-example",
      manifestPath: "/tmp/example/reports/install-manifest.json",
    },
  });
  await writeFile(path, `${JSON.stringify({ ...policy, mode: "shadow" })}\n`);
  const loaded = await loadDispatchPolicy(path);
  assert.equal(loaded.state, "off");
  assert.match(loaded.error, /integrity/);
});

test("apply refuses an unmanaged target", () => {
  assert.throws(
    () => assertManagedPolicyTarget('{"mode":"active"}\n'),
    /unmanaged dispatch policy/,
  );
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `node --test tests/dispatch-policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement canonical signing and load-as-off behavior**

Use a stable sorted JSON payload with exactly these signed fields:

```js
{
  schemaVersion: 1,
  managedBy: "sol-ultra-gearbox-v2",
  mode: "active" | "shadow",
  allowTypedBridge: false,
  activation: null | { installId: string, manifestPath: absolutePath },
  sha256: "64 lowercase hex characters"
}
```

`loadDispatchPolicy` must catch `ENOENT`, JSON parse failures, unknown fields,
unknown modes, `allowTypedBridge=true` without a supported schema, an active
policy without an activation reference, a shadow policy with one, and hash
mismatch and return `{ state: "off", policy: null, error }`. It must never
coerce an invalid file to active. The activation path is local-only, must not
appear in status output or the dispatch ledger, and points to the exact
manifest used by managed rollback after a hard active-mode failure.

Implement `assertManagedPolicyTarget` so an absent target is allowed by the
caller, a valid Gearbox policy may be updated, and every invalid or foreign
existing file throws.

- [ ] **Step 4: Verify policy tests and full suite**

Run: `node --test tests/dispatch-policy.test.mjs`

Expected: all policy tests PASS.

Run: `npm test`

Expected: all repository tests PASS.

- [ ] **Step 5: Commit policy integrity**

```bash
git add lib/dispatch-policy.mjs tests/dispatch-policy.test.mjs
git commit -m "feat: add managed dispatch policy integrity"
```

---

### Task 3: Runtime Result Envelope and Acceptance Gate

**Files:**
- Create: `lib/dispatch-evidence.mjs`
- Create: `tests/dispatch-evidence.test.mjs`
- Modify: `lib/gearbox.mjs` in `summarizeRollout` and rollout helper exports

**Interfaces:**
- Produces: `validateDispatchResult({ result, decision, roleSpec }) -> { pass, checks }`
- Produces: `verifyIsolatedRoot({ summary, decision, roleSpec, roleHash, before, after, cleanup }) -> result`
- Produces: `verifyTypedChildResult({ parent, child, decision, roleSpec, roleHash, before, after, cleanup }) -> result`
- Produces: `classifyDispatchFailure(result) -> { retryAllowed, fallbackReason }`
- Consumes: rollout summaries from `summarizeRollout`

- [ ] **Step 1: Write failing exact-envelope tests**

Create a valid result fixture that contains only:

```js
{
  schemaVersion: 1,
  kind: "dispatch_result",
  pass: true,
  taskHash,
  executionShape,
  role,
  reasonCode,
  expected: { model, effort, sandbox, depth, roleHash },
  actual: {
    model,
    effort,
    sandbox,
    depth,
    parentTokens,
    childTokens,
    nativeAgentRole
  },
  checks: {
    runtimePersisted,
    modelMatches,
    effortMatches,
    sandboxMatches,
    taskHashMatches,
    roleHashMatches,
    depthMatches,
    noDescendants,
    filesystemScope,
    commandExitedZero,
    commandDidNotTimeout,
    cleanupPassed,
    deliverableValid
  },
  changedFiles,
  retryCount,
  rollbackRequired,
  synthetic
}
```

Test exact success plus individual rejection for missing metadata, model drift,
effort drift, sandbox drift, role-hash drift, task-hash drift, descendant
spawn, read-only write, timeout, cleanup failure, and extra unrecognized fields.
For `isolated_role_root`, require `nativeAgentRole === null`, root depth zero,
the exact planned model/effort/sandbox, zero spawn calls, and no writes.

- [ ] **Step 2: Confirm tests fail before the module exists**

Run: `node --test tests/dispatch-evidence.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Extend rollout summaries without persisting private content**

In `lib/gearbox.mjs`, add these facts to the existing summary result:

```js
return {
  path,
  sessionMeta,
  turnContext,
  functionCalls,
  finalTexts,
  tokenUsage,
  threadSource: sessionMeta?.thread_source ?? null,
  sessionId: sessionMeta?.id ?? sessionMeta?.session_id ?? null,
};
```

The returned in-memory `sessionId` may be used to correlate one run, but
`writeJson` redaction and dispatch reports must never persist it.

- [ ] **Step 4: Implement strict shape-specific verification**

Implement one shared check set and make shape-specific facts explicit:

```js
const REQUIRED_CHECKS = Object.freeze([
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

export function validateDispatchResult({ result, decision, roleSpec }) {
  const checks = {
    exactShape: result?.executionShape === decision?.selectedShape,
    exactRole: result?.role === decision?.role,
    exactReason: result?.reasonCode === decision?.reasonCode,
    exactTask: result?.taskHash === decision?.taskHash,
    expectedModel: result?.expected?.model === roleSpec?.model,
    expectedEffort: result?.expected?.effort === roleSpec?.effort,
    expectedSandbox: result?.expected?.sandbox === roleSpec?.sandbox,
    allRuntimeChecks: REQUIRED_CHECKS.every((name) => result?.checks?.[name] === true),
    passed: result?.pass === true,
    retryBudget: Number.isInteger(result?.retryCount) && result.retryCount >= 0 && result.retryCount <= 1,
  };
  return { pass: Object.values(checks).every(Boolean), checks };
}
```

`verifyIsolatedRoot` must derive `actual.model`, `actual.effort`, and
`actual.sandbox` from `turnContext`; reject any `spawn_agent` function call;
require `threadSource !== "subagent"`; require total token metadata; and set
`actual.nativeAgentRole = null`.

`verifyTypedChildResult` must reuse `validateTypedSpawnArgs`, require one
parent spawn, exact `agent_type`, depth one, no child spawn, and both parent and
child token metadata.

Add this failure classifier and test every branch:

```js
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
      checks.deliverableValid === true
        ? null
        : "ROOT_RETRY_BUDGET_EXHAUSTED",
    rollbackRequired: false,
  };
}
```

- [ ] **Step 5: Run focused and regression tests**

Run: `node --test tests/dispatch-evidence.test.mjs tests/gearbox.test.mjs`

Expected: all tests PASS.

Run: `npm test`

Expected: all repository tests PASS.

- [ ] **Step 6: Commit runtime acceptance**

```bash
git add lib/dispatch-evidence.mjs lib/gearbox.mjs tests/dispatch-evidence.test.mjs tests/gearbox.test.mjs
git commit -m "feat: validate dispatch runtime results"
```

---

### Task 4: Privacy-Safe Dispatch Ledger

**Files:**
- Create: `lib/dispatch-ledger.mjs`
- Create: `tests/dispatch-ledger.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `createDispatchRecord({ decision, result, workflowAdapter, parentPermission, rootVerification })`
- Produces: `validateDispatchRecord(record) -> { pass, errors }`
- Produces: `appendDispatchRecord(path, record) -> void`
- Default local path: `reports/dispatch-ledger.jsonl`

- [ ] **Step 1: Write failing record and privacy tests**

Test a valid accepted record, a root-inline record, a rejected result, one
retry, and synthetic exam exclusion. Explicitly reject fields named `prompt`,
`message`, `goal`, `sessionId`, `path`, `cwd`, `auth`, `secret`, `token`,
`stdout`, or `stderr`, and reject values containing private absolute home
paths.

- [ ] **Step 2: Confirm the missing-module failure**

Run: `node --test tests/dispatch-ledger.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement exact-field validation and atomic JSONL append**

Use this public record shape:

```js
{
  schemaVersion: 1,
  kind: "dispatch_decision",
  generatedAt,
  taskHash,
  workflowAdapter,
  responsibility,
  executionShape,
  role,
  parentPermission,
  reasonCode,
  accepted,
  retryCount,
  escalatedToRoot,
  actualModel,
  actualEffort,
  tokens: { parent, child, isolatedRoot },
  rootVerificationPassed,
  synthetic
}
```

`appendDispatchRecord` must validate before writing, create the parent with
mode `0700`, create the file with mode `0600`, and append one canonical JSON
object plus newline. Synthetic records remain available for audit but are
never passed into `lib/cost-evidence.mjs`.

- [ ] **Step 4: Keep the ledger ignored**

Add this explicit entry after `reports/` in `.gitignore`:

```gitignore
reports/dispatch-ledger.jsonl
```

- [ ] **Step 5: Run tests and commit**

Run: `node --test tests/dispatch-ledger.test.mjs`

Expected: all ledger tests PASS.

Run: `npm test`

Expected: all repository tests PASS.

```bash
git add .gitignore lib/dispatch-ledger.mjs tests/dispatch-ledger.test.mjs
git commit -m "feat: add privacy-safe dispatch ledger"
```

---

### Task 5: Direct Terra/Luna Isolated-Root Runner

**Files:**
- Create: `lib/dispatch-runner.mjs`
- Create: `tests/dispatch-runner.test.mjs`
- Create: `tests/helpers/fake-codex.mjs`
- Modify: `lib/gearbox.mjs` owned probe-directory allowlist

**Interfaces:**
- Produces: `parseRoleInstructions(source) -> string`
- Produces: `renderIsolatedPrompt({ instructions, task, marker, taskHash, roleHash }) -> string`
- Produces: `buildIsolatedRootArgs({ roleSpec, instructions, cwd, task, marker }) -> string[]`
- Produces: `runIsolatedRole({ codexBin, codexHome, roleSpec, roleSource, cwd, task, taskHash, runCommand }) -> dispatch result`
- Consumes: `verifyIsolatedRoot` from `lib/dispatch-evidence.mjs`

- [ ] **Step 1: Write failing direct-root argument tests**

Assert the generated command:

- selects `roleSpec.model` and `roleSpec.effort` as root configuration;
- uses the exact role sandbox and `-a never`;
- disables Superpowers;
- uses `exec --json --skip-git-repo-check --ignore-user-config`;
- contains no `spawn_agent`, `agent_type`, parent Sol model, model inheritance,
  or full-history fork;
- rejects every workspace-write role and `sol_reviewer`;
- accepts only `luna_clerk` and `terra_explorer`.

The expected argument core is:

```js
[
  "--strict-config",
  "-c", `model=${JSON.stringify(roleSpec.model)}`,
  "-c", `model_reasoning_effort=${JSON.stringify(roleSpec.effort)}`,
  "-c", 'plugins."superpowers@openai-curated".enabled=false',
  "-s", roleSpec.sandbox,
  "-a", "never",
  "-C", cwd,
  "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
  prompt,
]
```

- [ ] **Step 2: Write fake-runtime lifecycle tests**

`tests/helpers/fake-codex.mjs` must accept the same arguments, write a fixture
rollout beneath the supplied isolated `CODEX_HOME`, and support environment
switches for exact success, model mismatch, timeout, spawn attempt, and
read-only write. `tests/dispatch-runner.test.mjs` must prove every failure is
rejected and all owned temporary homes are removed.

- [ ] **Step 3: Run tests and confirm missing runner failure**

Run: `node --test tests/dispatch-runner.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement strict role parsing and direct cheap-root execution**

`parseRoleInstructions` must accept exactly one multiline
`developer_instructions` TOML block and throw for missing, duplicate, or
unterminated delimiters. Validate the complete role source with
`validateRoleText` before execution.

Build the isolated prompt without parent history:

```js
export function renderIsolatedPrompt({
  instructions,
  task,
  marker,
  taskHash,
  roleHash,
}) {
  return [
    instructions.trim(),
    `Task packet hash: ${taskHash}`,
    `Role source hash: ${roleHash}`,
    task.trim(),
    `Return ${marker} only after completing the required checks.`,
    "Do not spawn, delegate, edit files, or broaden scope.",
  ].join("\n\n");
}
```

`runIsolatedRole` must:

1. Refuse any role outside `luna_clerk` and `terra_explorer`.
2. Create owned fixture/home directories with prefixes
   `sol-ultra-gearbox-v2-dispatch-<role>-` and
   `sol-ultra-gearbox-v2-dispatch-home-<role>-`.
3. Symlink only `auth.json` into the isolated home and unlink it in `finally`.
4. Snapshot the task workspace before launch.
5. Launch the selected Terra or Luna model directly as root with the parsed
   role instructions plus self-contained task and unique marker.
6. Poll only the isolated home for the one matching root rollout.
7. Verify root source, exact model/effort/sandbox, no spawn calls, token
   evidence, marker, no filesystem changes, and cleanup.
8. Return only the redacted dispatch result envelope.

- [ ] **Step 5: Expand the owned cleanup allowlist narrowly**

Update `OWNED_PROBE_DIRECTORY` in `lib/gearbox.mjs` to accept only the two new
dispatch prefixes and existing smoke/SDD prefixes. Add regression tests that an
unrelated similarly named directory is refused.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/dispatch-runner.test.mjs tests/dispatch-evidence.test.mjs tests/gearbox.test.mjs`

Expected: all focused tests PASS.

Run: `npm test`

Expected: all repository tests PASS.

- [ ] **Step 7: Commit the isolated runner**

```bash
git add lib/dispatch-runner.mjs lib/gearbox.mjs tests/dispatch-runner.test.mjs tests/helpers/fake-codex.mjs tests/gearbox.test.mjs
git commit -m "feat: run cheap read roles as isolated roots"
```

---

### Task 6: Managed Dispatch CLI and Runtime Installation

**Files:**
- Create: `scripts/gearbox-dispatch.mjs`
- Create: `scripts/gearbox-dispatch`
- Create: `tests/dispatch-cli.test.mjs`
- Modify: `lib/gearbox.mjs`
- Modify: `scripts/gearbox.mjs`
- Modify: `tests/gearbox.test.mjs`
- Modify: `package.json`

**Interfaces:**
- CLI: `gearbox-dispatch status`
- CLI: `gearbox-dispatch plan --packet <owned-temp-json> --consume`
- CLI: `gearbox-dispatch run-isolated --packet <owned-temp-json> --consume`
- Initial apply option in this task: `--dispatch-mode shadow`
- Installed policy: `$CODEX_HOME/gearbox/dispatch-policy.json`
- Installed runtime: `$CODEX_HOME/gearbox/runtime/{lib,scripts}`

- [ ] **Step 1: Write failing CLI tests against a temporary CODEX_HOME**

Spawn the CLI with a signed shadow policy and valid packet. Assert `status`
returns shadow, `plan` returns the exact planner recommendation with
`effectiveShape=root_inline`, `--consume` removes
only a packet beneath an owned temp directory, and an arbitrary path is
refused. Assert invalid or missing policy returns `GEARBOX_DISPATCH_OFF` and
does not launch a model.

- [ ] **Step 2: Implement the ESM CLI and stable Bash wrapper**

The Bash wrapper must contain only:

```bash
#!/usr/bin/env bash
set -euo pipefail
CODEX_HOME_DIR="${CODEX_HOME:-${HOME}/.codex}"
exec node "$CODEX_HOME_DIR/gearbox/runtime/scripts/gearbox-dispatch.mjs" "$@"
```

The ESM CLI must load policy before reading a packet, never accept inline JSON
or raw prompt command arguments, and emit only redacted JSON. `run-isolated`
must require the planner's effective shape to equal `isolated_role_root`.

- [ ] **Step 3: Define the exact managed runtime source inventory**

Export from `lib/gearbox.mjs`:

```js
export const DISPATCH_RUNTIME_FILES = Object.freeze([
  "lib/gearbox.mjs",
  "lib/dispatch-planner.mjs",
  "lib/dispatch-policy.mjs",
  "lib/dispatch-evidence.mjs",
  "lib/dispatch-ledger.mjs",
  "lib/dispatch-runner.mjs",
  "scripts/gearbox-dispatch.mjs",
]);
```

Add all entries plus `scripts/gearbox-dispatch` to `RUNTIME_BINDING_PATHS` in
`scripts/gearbox.mjs` so trusted smoke and exam evidence become stale after any
runtime change.

- [ ] **Step 4: Extend managed apply and rollback with policy/runtime files**

`installAfterSmoke` must accept `{ dispatchMode }`. When
`dispatchMode` is supplied, it must:

1. Accept `shadow` and explicitly refuse `active` with
   `active dispatch requires trusted acceptance evidence`.
2. Refuse an existing invalid or unmanaged policy target.
3. Back up the policy, wrapper, and every runtime file.
4. Write a signed shadow policy with `allowTypedBridge=false` and
   `activation=null`.
5. Copy the runtime tree with file mode `0644` and wrappers with `0755`.
6. Record source/target hashes and policy mode in the install manifest.
7. Include all new files in normal manifest-bound rollback.

Dry run must report policy/runtime hashes without writing them. Existing apply
without `--dispatch-mode` must preserve current behavior and must not create a
policy silently. Task 7 adds active only after trusted acceptance validation
exists.

- [ ] **Step 5: Add package commands**

Add:

```json
"dispatch:status": "node scripts/gearbox-dispatch.mjs status",
"acceptance": "node scripts/gearbox.mjs acceptance --all"
```

- [ ] **Step 6: Run CLI, dry-run, and rollback tests**

Run: `node --test tests/dispatch-cli.test.mjs tests/gearbox.test.mjs`

Expected: all focused tests PASS and temporary `CODEX_HOME` returns to its
exact pre-test state after rollback.

Run: `npm test`

Expected: all repository tests PASS.

- [ ] **Step 7: Commit the managed runtime**

```bash
git add package.json lib/gearbox.mjs scripts/gearbox.mjs scripts/gearbox-dispatch scripts/gearbox-dispatch.mjs tests/dispatch-cli.test.mjs tests/gearbox.test.mjs
git commit -m "feat: install managed dispatch runtime"
```

---

### Task 7: Ten-Question Acceptance Exam and Trusted Reuse

**Files:**
- Create: `lib/acceptance-exam.mjs`
- Create: `tests/acceptance-exam.test.mjs`
- Modify: `lib/runtime-evidence.mjs`
- Modify: `tests/runtime-evidence.test.mjs`
- Modify: `scripts/gearbox.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `ACCEPTANCE_SCENARIOS` with exactly ten ordered cases
- Produces: `runAcceptanceExam({ policy, roleSmoke, executeIsolated, executeParallel })`
- Produces: `validateAcceptanceEvidence(report) -> { pass, checks }`
- Produces: `validateTrustedAcceptance({ report, currentBinding, nowMs })`
- CLI: `node scripts/gearbox.mjs acceptance --all`
- Apply reuse option: `--reuse-acceptance reports/<run>/acceptance.json`

- [ ] **Step 1: Write failing exam contract tests**

Assert exactly these ordered IDs and outcomes:

```js
[
  ["Q1_ROOT_TRIVIAL", "root_inline", "ROOT_TRIVIAL"],
  ["Q2_ISOLATED_LUNA", "isolated_role_root", "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH"],
  ["Q3_ISOLATED_TERRA", "isolated_role_root", "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH"],
  ["Q4_TYPED_WORKER", "typed_child", "DELEGATE_TYPED_PERMISSION_MATCH"],
  ["Q5_ROOT_HIGH_RISK", "root_inline", "ROOT_HIGH_RISK"],
  ["Q6_UNKNOWN_SKILL", "root_inline", "ROOT_UNKNOWN_SKILL"],
  ["Q7_BRIDGE_DISABLED", "root_inline", "ROOT_BRIDGE_DISABLED"],
  ["Q8_RUNTIME_MISMATCH_REJECTED", "root_inline", "ROOT_RUNTIME_EVIDENCE_FAILED"],
  ["Q9_WRITE_VIOLATION_REJECTED", "root_inline", "ROOT_PERMISSION_VIOLATION"],
  ["Q10_TWO_TYPED_READERS", "typed_child", "DELEGATE_TYPED_PERMISSION_MATCH"],
]
```

Use injected fake executors to prove a negative case passes only when the
violation is detected, rejected, and cleaned. A skipped case, missing runtime
metadata, stale binding, one failed cleanup, or nine-of-ten result must fail the
whole report.

- [ ] **Step 2: Implement scenario orchestration with no hidden retries**

The report shape is:

```js
{
  schemaVersion: 1,
  kind: "quality_first_acceptance_exam",
  generatedAt,
  pass,
  expectedQuestionCount: 10,
  runtimeBinding,
  runtimeBindingAfterSha256,
  runtimeBindingStable,
  globalConfigBeforeSha256,
  globalConfigAfterSha256,
  globalConfigUnchanged,
  questions,
  cleanup: { pass },
  activationEligible
}
```

Questions 2 and 3 run fresh direct Luna and Terra isolated roots. Question 4
uses the current `terra_worker` role-smoke evidence. Question 10 launches two
independent permission-matched read-only typed children from one disposable
`gpt-5.6-sol` / `ultra` parent, verifies that parent runtime plus exactly two
direct children, disjoint read scopes, no writers, no descendants, and both
token records. Questions 8 and 9 inject
controlled invalid evidence and pass only when the validator rejects it.

No cost-bearing question is retried automatically.

- [ ] **Step 3: Add trusted acceptance binding and TTL validation**

Use the same 30-minute TTL, reports-directory path confinement, regular-file
requirement, clean-tree requirement, config/Codex/role/runtime hash binding,
and future-clock-skew limits as trusted role smoke. Add exam source hashes to
the runtime binding. Require `activationEligible === true` and all ten exact
scenario IDs.

- [ ] **Step 4: Add the paid acceptance command**

`node scripts/gearbox.mjs acceptance --all` must:

1. Require preflight doctor PASS and a clean tree.
2. Confirm the current model catalog exposes `gpt-5.6-sol` effort `ultra`, then
   run or accept only current trusted six-role smoke.
3. Print `QUESTION <id> PASS|FAIL` after each completed scenario.
4. Stop immediately after a hard runtime, permission, filesystem, or cleanup
   failure.
5. Write ignored `acceptance.json` and concise `acceptance.md` beneath one
   timestamped `reports/<run>-acceptance/` directory.
6. Print `GEARBOX_ACCEPTANCE_PASS` only for ten-of-ten current evidence.

- [ ] **Step 5: Gate active apply on the exam**

Extend `installAfterSmoke` from Task 6 to accept
`{ dispatchMode, acceptance }`. `dispatchMode="active"` is valid only when
`validateTrustedAcceptance` passes against the current binding; the installed
policy must still set `allowTypedBridge=false`. Before writing, create the
ignored apply-manifest path and install ID, place both in the signed policy's
activation reference, and record the repository root plus policy hash in the
manifest. This avoids a policy/manifest hash cycle while giving the active
dispatcher one exact rollback target.

Extend post-install fresh-root evidence to record the observed root model and
effort from persisted runtime metadata. For this owner activation, require
`gpt-5.6-sol` / `ultra`; do not modify global root model settings to manufacture
the match.

For `--dispatch-mode active`, `apply --promote-v2` must either run the exam in
the same command after role smoke or validate `--reuse-acceptance`. If the exam
fails, global policy, runtime, config, roles, and AGENTS must remain unchanged.
After a pass, apply proceeds without another owner prompt because the owner has
already authorized direct activation in this task.

When an active runtime result sets `rollbackRequired=true`, the managed skill
must stop all further delegation in the current task and invoke the existing
manifest-bound `node scripts/gearbox.mjs rollback --manifest <path>` using the
activation reference. `gearbox-dispatch` itself must not edit global policy.

- [ ] **Step 6: Run fake exam and regression tests**

Run: `node --test tests/acceptance-exam.test.mjs tests/runtime-evidence.test.mjs`

Expected: all fake and trusted-reuse cases PASS without model calls.

Run: `npm test`

Expected: all repository tests PASS.

- [ ] **Step 7: Commit the acceptance gate**

```bash
git add package.json lib/acceptance-exam.mjs lib/runtime-evidence.mjs scripts/gearbox.mjs tests/acceptance-exam.test.mjs tests/runtime-evidence.test.mjs
git commit -m "feat: gate active mode on acceptance exam"
```

---

### Task 8: Skill Policy, Public Documentation, and Release Evidence

**Files:**
- Modify: `lib/gearbox.mjs` `WORKFLOW_POLICY`
- Modify: `skills/sol-ultra-gearbox/SKILL.md`
- Modify: `skills/sol-ultra-gearbox/references/risk-gates.md`
- Modify: `skills/sol-ultra-gearbox/references/routing-matrix.md`
- Modify: `skills/sol-ultra-gearbox/references/subagent-skill-compatibility.md`
- Create: `skills/sol-ultra-gearbox/references/quality-first-dispatch.md`
- Modify: `lib/skill-install.mjs`
- Modify: `tests/skill-install.test.mjs`
- Modify: `tests/release-check.test.mjs`
- Modify: `README.md`
- Modify: `lib/release-evidence.mjs`
- Modify: `scripts/release-evidence.mjs`
- Modify: `tests/release-evidence.test.mjs`
- Regenerate after live evidence: `docs/release-evidence.json`
- Regenerate after live evidence: `docs/RELEASE_EVIDENCE.md`

**Interfaces:**
- Installed skill must require the managed planner before supported actual delegation.
- Public evidence must summarize acceptance status without raw report fields.

- [ ] **Step 1: Write failing bundled-skill and release tests**

Require the skill and managed AGENTS policy to contain:

- the four execution-shape names;
- quality gate before cost gate;
- `gearbox-dispatch plan` before supported actual delegation;
- direct Terra/Luna isolated-root wording and the explicit statement that it is
  not a child;
- exact active/shadow/off semantics;
- `allowTypedBridge=false` for first activation;
- unknown-skill and direct-core-call boundaries;
- one correction maximum;
- ten-question acceptance gate;
- no savings percentage claim.

Require the skill installer fixture to include
`references/quality-first-dispatch.md` and fail when it is absent.

- [ ] **Step 2: Add the exact root workflow**

Document this sequence in the skill and managed `WORKFLOW_POLICY`:

```text
1. Build one self-contained packet only when actual delegation is intended.
2. Load the managed policy; missing or invalid means off.
3. Run gearbox-dispatch plan with the packet and current schema/permission facts.
4. root_inline: Sol completes the task.
5. typed_child: Sol calls spawn_agent with exact typed args, waits, closes the child, and validates runtime evidence.
6. isolated_role_root: run gearbox-dispatch run-isolated; never call it a child.
7. Reject missing or mismatched evidence before integration.
8. On a hard active-mode failure, stop delegation and use the signed policy's activation manifest with the managed rollback command.
9. Sol integrates, runs final relevant tests, records the privacy-safe outcome, and cleans the packet.
```

State plainly that unsupported direct `spawn_agent` calls outside the skill or
runner are not intercepted by the repository.

Document that dispatch status and public evidence redact the local activation
manifest path. Only the managed rollback command may consume it to change
global state.

- [ ] **Step 3: Update public commands and safety explanations**

README must show:

```bash
npm test
npm run doctor -- --json
node scripts/gearbox.mjs apply --promote-v2 --dispatch-mode active --dry-run
npm run acceptance
node scripts/gearbox.mjs apply --promote-v2 --dispatch-mode active
npm run dispatch:status
```

Explain that the final apply runs fresh paid evidence unless both trusted reuse
paths validate, and that all global changes are manifest-bound and reversible.

- [ ] **Step 4: Extend redacted release evidence**

Add `runtime.acceptanceExam` with only:

```js
{
  pass,
  generatedAt,
  questionCount,
  passedQuestionCount,
  executionShapes,
  activeEligible,
  runtimeBindingSha256
}
```

`release-evidence.mjs generate` must require `--acceptance <path>` for the new
release, reject stale or incomplete exam evidence, and never copy prompts,
fixture paths, session IDs, or raw runtime output.

- [ ] **Step 5: Run documentation, installer, and release tests**

Run: `node --test tests/skill-install.test.mjs tests/release-check.test.mjs tests/release-evidence.test.mjs tests/gearbox.test.mjs`

Expected: all focused tests PASS.

Run: `npm test`

Expected: all repository tests PASS.

- [ ] **Step 6: Commit source documentation before generated evidence**

```bash
git add README.md lib/gearbox.mjs lib/skill-install.mjs lib/release-evidence.mjs scripts/release-evidence.mjs skills/sol-ultra-gearbox tests/gearbox.test.mjs tests/skill-install.test.mjs tests/release-check.test.mjs tests/release-evidence.test.mjs
git commit -m "docs: publish quality-first dispatch contract"
```

Generated evidence remains unchanged until current paid reports exist.

---

### Task 9: Static Verification and Implementation Review

**Files:**
- Modify only files required by concrete failures from this task's checks.

**Interfaces:**
- Produces a clean, committed activation candidate.

- [ ] **Step 1: Run the complete deterministic suite**

Run: `npm test`

Expected: every test PASS, including all ten fake exam scenarios.

- [ ] **Step 2: Run current doctor and managed dry run without global writes**

Run: `npm run doctor -- --json`

Expected: `pass: true` for role files, model catalog, patchability, strict
config, multi-agent feature visibility, and Codex doctor.

Run:
`node scripts/gearbox.mjs apply --promote-v2 --dispatch-mode active --dry-run`

Expected: PASS with policy/runtime/config/AGENTS hashes and `changed` facts;
no global file changes.

- [ ] **Step 3: Run diff, public-path, and secret hygiene**

Run: `git diff --check`

Expected: no output and exit zero.

Run: `gitleaks dir . --redact`

Expected: no verified leaks.

Run the official skill validator against
`skills/sol-ultra-gearbox/SKILL.md` using the currently installed validator.

Expected: PASS.

- [ ] **Step 4: Perform requirements and security-boundary review**

Review only the approved design, current diff, and test evidence. Reject:

- any Sol parent inside `isolated_role_root`;
- any automatic Max or Ultra role selection;
- any bridge execution while the flag is false;
- any direct global write outside managed commands;
- any untrusted runtime prose treated as metadata;
- any raw report or private path in tracked files;
- any negative exam that passes without detecting and rejecting its violation.

- [ ] **Step 5: Fix only confirmed findings and rerun affected checks**

Use at most three focused repair rounds. Each repair begins with a regression
test, runs the narrow failing check, then runs `npm test` before commit.

- [ ] **Step 6: Confirm the reviewed activation candidate is clean**

Every confirmed repair from Step 5 must already have its own focused commit
with explicit file paths. Do not use `git add -A`.

Run: `git status --short`

Expected: no output. Any unexpected path stops the activation review until its
owner and purpose are known.

---

### Task 10: Owner-Witnessed Paid Exam, Direct Active Apply, and Public Evidence

**Files:**
- Global managed targets written only by approved installers.
- Local ignored reports beneath `reports/`.
- Regenerate and commit: `docs/release-evidence.json`
- Regenerate and commit: `docs/RELEASE_EVIDENCE.md`

**Interfaces:**
- Produces: fresh role smoke, acceptance report, active install manifest, rollback path, fresh-root readback, and redacted public evidence.

- [ ] **Step 1: Confirm the activation commit is clean and current**

Run: `git status --short`

Expected: no output.

Run: `git rev-parse HEAD`

Record the exact commit in the witnessed run notes.

- [ ] **Step 2: Preview and install the managed global skill while routing remains off**

Run: `npm run skill:status`

Expected: managed target or a safe install/update plan; unmanaged or locally
modified targets stop the activation.

Run: `npm run skill:install -- --apply`

Expected: installed, updated, or already current. A missing/invalid dispatch
policy still resolves off, so this step cannot silently activate routing.

- [ ] **Step 3: Run a fresh paid SDD adapter probe for release binding**

Run: `npm run smoke:sdd`

Expected: `GEARBOX_SDD_PASS`, exact sequential `terra_worker` then
`sol_reviewer` phases, no core-hook claim, unchanged global config, and a
current ignored report path. Stop on failure and do not retry automatically.

- [ ] **Step 4: Run the owner-witnessed paid apply command**

Run:

```bash
node scripts/gearbox.mjs apply --promote-v2 --dispatch-mode active
```

Expected live sequence:

```text
GEARBOX_DOCTOR_PASS
six role smoke results, stopping on first failure
QUESTION Q1_ROOT_TRIVIAL PASS
QUESTION Q2_ISOLATED_LUNA PASS
QUESTION Q3_ISOLATED_TERRA PASS
QUESTION Q4_TYPED_WORKER PASS
QUESTION Q5_ROOT_HIGH_RISK PASS
QUESTION Q6_UNKNOWN_SKILL PASS
QUESTION Q7_BRIDGE_DISABLED PASS
QUESTION Q8_RUNTIME_MISMATCH_REJECTED PASS
QUESTION Q9_WRITE_VIOLATION_REJECTED PASS
QUESTION Q10_TWO_TYPED_READERS PASS
Q10 parent gpt-5.6-sol / ultra VERIFIED
GEARBOX_ACCEPTANCE_PASS
GEARBOX_APPLY_PASS
MANIFEST reports/<timestamp>-apply/install-manifest.json
```

Any missing question, stale evidence, role mismatch, model mismatch, effort
mismatch, sandbox mismatch, unexpected write, descendant spawn, timeout, or
cleanup failure must stop before active policy is written. A post-write failure
must trigger automatic manifest rollback.

- [ ] **Step 5: Verify the installed active state in a fresh Sol Ultra root**

Run: `npm run dispatch:status`

Expected: policy `active`, integrity PASS, `allowTypedBridge=false`, and current
runtime source hashes.

Open a fresh Sol Ultra task and perform one harmless readback that does not
delegate. Confirm the task sees the updated Gearbox skill and managed AGENTS
policy. Do not count the current pre-install task as fresh-root evidence.

- [ ] **Step 6: Verify rollback readiness**

Read the emitted manifest and confirm it contains current hashes and backups
for config, AGENTS, roles, launchers, policy, and runtime files. Do not execute
rollback after a successful activation; validate its dry contract and preserve
the exact command:

```bash
node scripts/gearbox.mjs rollback --manifest reports/<timestamp>-apply/install-manifest.json
```

- [ ] **Step 7: Generate redacted public evidence from current reports**

Run:

```bash
npm run release:evidence -- \
  --smoke reports/<timestamp>-smoke/smoke.json \
  --sdd reports/<current-sdd>/sdd.json \
  --acceptance reports/<timestamp>-acceptance/acceptance.json \
  --usage reports/20260713-history-audit/real-work-usage.json
```

Expected: generated JSON and Markdown contain aggregate runtime and acceptance
facts only, with the estimator still unpublished.

- [ ] **Step 8: Run final publication checks**

Run: `npm test`

Expected: all tests PASS.

Run: `npm run release:check`

Expected: `RELEASE_PASS`.

Run: `gitleaks dir . --redact`

Expected: no verified leaks.

- [ ] **Step 9: Commit generated evidence and activation documentation**

```bash
git add docs/release-evidence.json docs/RELEASE_EVIDENCE.md
git commit -m "docs: publish active routing evidence"
```

- [ ] **Step 10: Record final verified execution facts**

The final handoff must list the Sol root runtime if available, each live role's
actual model/effort/sandbox/tokens, `fork_turns`, read/write scope, retry and
escalation count, ten exam outcomes, active policy hash, manifest path, fresh
root result, and rollback command. Any missing root metadata is labeled
`unverified`; no savings percentage is inferred.

- [ ] **Step 11: Publish through a reviewed GitHub pull request**

Push `codex/quality-first-cost-routing`, open a ready-for-review pull request
against `main`, include the static checks, paid report summaries, active apply
manifest status, rollback command, and explicit instruction-level enforcement
boundary. Wait for required GitHub checks to pass before merge. Do not publish a
new release tag or package unless the owner separately chooses a release
version.
