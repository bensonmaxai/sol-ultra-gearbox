# Verified Workflow Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic, resumable workflow orchestrator that preserves stage dependencies and future verification capacity while retaining Gearbox's typed identity, permission, runtime-evidence, adoption, and rollback guarantees.

**Architecture:** A pure workflow layer validates a versioned DAG, compiles dependency-ready stages into schema-version-2 task packets, schedules legal batches, and reduces lifecycle events into hash-bound state. The existing quality-first planner remains authoritative for each stage; native typed children remain root-driven because Gearbox is not a Codex core hook, while the managed runner validates ephemeral materialization receipts, persisted runtime evidence, adoption, recovery, and privacy-safe outcomes.

**Tech Stack:** Node.js 20+ ESM, `node:test`, canonical JSON and SHA-256, private JSONL ledgers, existing Codex CLI/runtime adapters, no production dependencies.

## Global Constraints

- Implement only design Phases 1-3 from `docs/superpowers/specs/2026-07-15-verified-workflow-orchestrator-design.md`.
- Keep `root_inline`, `typed_child`, and `isolated_role_root` as the only active shapes. Keep `typed_child_bridge` known but unschedulable while `allowTypedBridge=false`.
- Do not add `app_thread_root`, App-thread tools, a production dependency, a model override, or a new global-write command.
- Gearbox remains an instruction-and-runner control. Native `spawn_agent` execution stays on the Sol root and is not described as a Codex core hook.
- Quality gates run before cost or parallelism. Unknown adapters, generic roles, ambiguous scope, hidden coupling, weak verification, permission mismatch, and missing trusted runtime evidence fail closed.
- Native children use only `agent_type`, `fork_turns="none"`, and `message`; role TOML owns model, effort, sandbox, and service tier.
- At most two direct children may be active, depth remains one, descendants are forbidden, and at most one writer owns an exclusive relative write scope.
- Read-only fan-out and writer execution occur in separate batches. A second batch member cannot materialize before the first real execution has a validated running or completed receipt.
- One delegated correction is allowed only for a local output defect and only while the recovery reserve remains. Identity, permission, scope, cleanup, policy, state-integrity, or ambiguity failures receive no retry.
- Task-packet schema version 1 remains byte-for-byte compatible at its public interface. Workflow stages use schema version 2 with one exact `workflowContext` object.
- Raw plans and event envelopes remain ephemeral private packets. Persist only safe identifiers, hashes, bounded enums, aggregate tokens, and reason codes; never persist prompts, goals, private paths, execution IDs, session IDs, thread IDs, auth state, rollout text, stdout, or stderr.
- Unit, integration, recovery, and comparative tests use fixtures and temporary directories. They must not mutate the real `~/.codex`.
- Do not run paid smoke, acceptance, global skill installation, global apply, rollback, public release, or performance-claim generation without a new explicit owner approval.
- Existing user-owned untracked `.superpowers/`, `media/`, and `outputs/` paths are out of scope and must not be staged, deleted, moved, or rewritten.
- Keep raw `reports/` ignored. Do not publish a savings, speed, or quality percentage before ten comparable accepted root-inclusive pairs exist.
- Run every shell command through the repository-required `rtk` prefix.

---

## File Structure

| Path | Responsibility |
|---|---|
| `lib/workflow-plan.mjs` | Exact workflow schema, canonical plan hash, graph/artifact/scope validation, and approval-gate structure. |
| `lib/workflow-compiler.mjs` | Compile one validated stage into a self-contained task-packet v2. |
| `lib/workflow-state.mjs` | Pure lifecycle, attempt, adoption, correction, provider-close, and budget state reducer. |
| `lib/workflow-scheduler.mjs` | Dependency readiness, reserve accounting, one-writer batching, and stable stage selection. |
| `lib/workflow-orchestrator.mjs` | Per-stage dispatch planning, canary/deferred action protocol, and materialization-receipt validation. |
| `lib/private-jsonl.mjs` | Shared private-directory, regular-file, complete-line, append, fsync, and replay primitives. |
| `lib/workflow-ledger.mjs` | Hash-chained transition records, upstream-versus-managed store selection, and replay. |
| `lib/workflow-recovery.mjs` | Resume binding and adopted-artifact validation with exact blocked reason codes. |
| `lib/workflow-outcome.mjs` | Privacy-safe per-stage workflow outcome records and validation. |
| `lib/workflow-contract-evidence.mjs` | Deterministic five-scenario comparison and source-manifest-bound evidence. |
| `lib/owned-packet.mjs` | Existing private temporary packet resolution, no-follow read, and consume behavior extracted from the CLI. |
| `lib/workflow-cli.mjs` | `workflow-next` envelope validation, state-source handling, transition application, and redacted action output. |
| `lib/dispatch-planner.mjs` | Preserve packet v1 and add exact packet-v2 validation/rendering. |
| `lib/dispatch-ledger.mjs` | Reuse `private-jsonl` without changing dispatch-record schema v1. |
| `lib/gearbox.mjs` | Runtime inventory and managed AGENTS workflow contract. |
| `scripts/gearbox-dispatch.mjs` | Route existing commands plus `workflow-next` into the new workflow CLI. |
| `scripts/workflow-contract-evidence.mjs` | Generate deterministic workflow evidence to one explicit repository-relative target. |
| `lib/acceptance-exam.mjs`, `scripts/gearbox.mjs` | Preserve ten questions while requiring persisted Q10 canary ordering. |
| `tests/helpers/workflow-fixtures.mjs` | Canonical valid workflow, stage, state, decision, receipt, and outcome fixtures. |
| `tests/workflow-*.test.mjs` | Focused contract, state, scheduling, ledger, recovery, CLI, and comparative tests. |
| `skills/sol-ultra-gearbox/references/verified-workflows.md` | Installed operator contract for plan, canary, evidence, adoption, recovery, and closure. |
| `skills/sol-ultra-gearbox/SKILL.md` | Route multi-stage managed work through the verified workflow contract. |
| `skills/sol-ultra-gearbox/references/quality-first-dispatch.md` | Integrate the workflow lifecycle with the existing per-stage dispatch order. |
| `skills/sol-ultra-gearbox/references/subagent-skill-compatibility.md` | Preserve workflow-skill semantics while using stage packets and source-of-truth state. |
| `README.md` | Public architecture, limits, deterministic verification, and evidence boundary. |
| `AGENTS.md` | Keep the repository's managed workflow block aligned with the generated global policy. |
| `lib/skill-install.mjs`, `lib/release-check.mjs` | Require the installed/public verified-workflow reference and deterministic artifact. |
| `lib/release-evidence.mjs`, `scripts/release-evidence.mjs` | Validate and publish only redacted workflow contract facts. |
| `docs/workflow-contract-evidence.json` | Committed deterministic 5/5 contract evidence, generated after source completion. |

---

### Task 1: Exact Workflow Plan and DAG Validation

**Files:**
- Create: `lib/workflow-plan.mjs`
- Create: `tests/helpers/workflow-fixtures.mjs`
- Create: `tests/workflow-plan.test.mjs`

**Interfaces:**
- Produces: `validateWorkflowPlan(plan, { knownAdapters, roleNames }) -> { pass, errors }`
- Produces: `hashWorkflowPlan(plan) -> 64-character lowercase SHA-256`
- Produces: `workflowIndexes(plan) -> { stagesById, producerByArtifact, ancestorsByStage }`
- Produces: `WORKFLOW_SCHEMA_VERSION = 1`
- Produces: `ATTEMPT_CLASSES = ["work", "verification", "recovery"]`

- [ ] **Step 1: Add a canonical valid workflow fixture and failing happy-path test**

Create this public fixture shape in `tests/helpers/workflow-fixtures.mjs`:

```js
export function workflowPlan(overrides = {}) {
  return {
    schemaVersion: 1,
    workflowId: "verified-audit",
    goal: "Audit two modules, verify the evidence, then adopt the report",
    workflowAdapter: "superpowers:executing-plans",
    inputArtifacts: ["repository-snapshot"],
    attemptBudget: {
      total: 4,
      reservedForVerification: 1,
      reservedForRecovery: 1,
    },
    stages: [
      stage({
        id: "audit-core",
        outputArtifacts: ["core-evidence"],
        readScope: ["lib"],
      }),
      stage({
        id: "audit-cli",
        outputArtifacts: ["cli-evidence"],
        readScope: ["scripts"],
      }),
      stage({
        id: "verify-evidence",
        responsibility: "review",
        dependsOn: ["audit-core", "audit-cli"],
        attemptClass: "verification",
        inputArtifacts: ["core-evidence", "cli-evidence"],
        outputArtifacts: ["verified-report"],
        readScope: ["lib", "scripts", "tests"],
        requestedRole: "sol_reviewer",
      }),
    ],
    ...overrides,
  };
}

export function stage(overrides = {}) {
  return {
    id: "audit-stage",
    responsibility: "exploration",
    dependsOn: [],
    attemptClass: "work",
    inputArtifacts: ["repository-snapshot"],
    outputArtifacts: ["stage-evidence"],
    approvalGate: null,
    readScope: ["lib"],
    writeScope: [],
    interfaces: ["Return path, symbol, and evidence records"],
    knownFacts: ["The workspace is a fixture"],
    constraints: ["Read only"],
    deliverable: "Structured evidence",
    successCriteria: ["Every claim names a file and symbol"],
    checks: ["Confirm all declared inputs were inspected"],
    prohibitedActions: ["Do not spawn descendants"],
    parentPermission: "workspace-write",
    requiredPermission: "read-only",
    requestedRole: null,
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
```

Add the first test:

```js
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
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `rtk node --test tests/workflow-plan.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/workflow-plan.mjs`.

- [ ] **Step 3: Implement exact schemas, canonical hashing, and graph indexes**

Use exact top-level, budget, stage, approval, risk, and cost field sets. Define approval gates as either `null` or this exact object:

```js
{
  authority: "owner",
  factId: "approve-specialist-stage",
  purpose: "stage_execution" | "role_opt_in"
}
```

Start `lib/workflow-plan.mjs` with these public constants and canonical hash:

```js
import { createHash } from "node:crypto";
import { KNOWN_ADAPTERS, RESPONSIBILITY_ROLES } from "./dispatch-planner.mjs";

export const WORKFLOW_SCHEMA_VERSION = 1;
export const ATTEMPT_CLASSES = Object.freeze([
  "work",
  "verification",
  "recovery",
]);

const TOP_LEVEL_FIELDS = Object.freeze([
  "schemaVersion",
  "workflowId",
  "goal",
  "workflowAdapter",
  "inputArtifacts",
  "attemptBudget",
  "stages",
]);
const BUDGET_FIELDS = Object.freeze([
  "total",
  "reservedForVerification",
  "reservedForRecovery",
]);
const APPROVAL_FIELDS = Object.freeze(["authority", "factId", "purpose"]);
const APPROVAL_PURPOSES = new Set(["stage_execution", "role_opt_in"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stable(value[key])]),
    );
  }
  return value;
}

export function hashWorkflowPlan(plan) {
  return createHash("sha256")
    .update(JSON.stringify(stable(plan)))
    .digest("hex");
}
```

`workflowIndexes` must build all stage IDs before resolving edges, reject no data itself, and compute transitive ancestors with a depth-first walk whose active stack detects cycles. `validateWorkflowPlan` must return errors rather than throw and must apply every rule in Step 4.

- [ ] **Step 4: Add exact negative contract tests**

Create table-driven mutations and assert a distinct validation error for each:

```js
const invalidPlans = [
  ["duplicate stage", (plan) => plan.stages.push(structuredClone(plan.stages[0]))],
  ["unknown dependency", (plan) => plan.stages[2].dependsOn.push("missing-stage")],
  ["cycle", (plan) => plan.stages[0].dependsOn.push("verify-evidence")],
  ["self dependency", (plan) => plan.stages[0].dependsOn.push("audit-core")],
  ["multiple artifact producers", (plan) => plan.stages[1].outputArtifacts = ["core-evidence"]],
  ["missing artifact producer", (plan) => plan.stages[2].inputArtifacts.push("missing-evidence")],
  ["non-ancestor artifact", (plan) => plan.stages[0].inputArtifacts.push("cli-evidence")],
  ["verification without work ancestor", (plan) => plan.stages[2].dependsOn = []],
  ["malformed approval gate", (plan) => plan.stages[0].approvalGate = { authority: "owner" }],
  ["unknown adapter", (plan) => plan.workflowAdapter = "unknown:workflow"],
  ["overlapping potential writers", (plan) => {
    for (const item of plan.stages.slice(0, 2)) {
      item.responsibility = "implementation";
      item.requiredPermission = "workspace-write";
      item.writeScope = ["lib/shared.mjs"];
    }
  }],
  ["insufficient verification reserve", (plan) => plan.attemptBudget.reservedForVerification = 0],
  ["recovery reserve above one", (plan) => plan.attemptBudget.reservedForRecovery = 2],
];
```

Also prove every missing or extra field at every schema level is rejected; identifiers are safe and bounded; scopes are non-empty relative paths without `.` or `..`; strings in list fields are non-empty; output artifact IDs are globally unique; verification reserve covers every declared verification stage; recovery reserve covers declared recovery stages and is at most one; and two overlapping writers are allowed only when one is a transitive dependency of the other.

- [ ] **Step 5: Run focused and full tests**

Run: `rtk node --test tests/workflow-plan.test.mjs`

Expected: all workflow-plan tests PASS.

Run: `rtk npm test`

Expected: all repository tests PASS.

- [ ] **Step 6: Commit the workflow plan contract**

```bash
rtk git add lib/workflow-plan.mjs tests/helpers/workflow-fixtures.mjs tests/workflow-plan.test.mjs
rtk git commit -m "feat: validate workflow plans"
```

---

### Task 2: Stage Compiler and Task-Packet Version 2

**Files:**
- Create: `lib/workflow-compiler.mjs`
- Create: `tests/workflow-compiler.test.mjs`
- Modify: `lib/dispatch-planner.mjs`
- Modify: `tests/dispatch-planner.test.mjs`

**Interfaces:**
- Produces: `compileStagePacket({ plan, planHash, stageId, approvalFacts, batch }) -> packet v2`
- Produces: `validateWorkflowContext(context) -> { pass, errors }`
- Preserves: `validateTaskPacket(packet v1)`, `hashTaskPacket(packet v1)`, and existing v1 routing decisions
- Extends: `renderTaskMessage(packet v2)` with exact stage/dependency/artifact/interface context

- [ ] **Step 1: Write failing compiler and v1-compatibility tests**

Add these assertions:

```js
test("compiler emits one exact stage-aware packet without parent history", () => {
  const plan = workflowPlan();
  const planHash = hashWorkflowPlan(plan);
  const packet = compileStagePacket({
    plan,
    planHash,
    stageId: "verify-evidence",
    approvalFacts: [],
    batch: { requestedChildren: 1, writerCount: 0, scopesDisjoint: true },
  });
  assert.equal(packet.schemaVersion, 2);
  assert.deepEqual(packet.workflowContext, {
    workflowId: "verified-audit",
    planHash,
    stageId: "verify-evidence",
    dependsOn: ["audit-core", "audit-cli"],
    inputArtifacts: ["core-evidence", "cli-evidence"],
    outputArtifacts: ["verified-report"],
    interfaces: ["Return path, symbol, and evidence records"],
    attemptClass: "verification",
    missingInformationPolicy: "block_and_report",
  });
  assert.equal(validateTaskPacket(packet).pass, true);
  assert.doesNotMatch(renderTaskMessage(packet), /parent history/i);
});

test("packet v1 public behavior remains unchanged", () => {
  const value = packetV1();
  assert.equal(validateTaskPacket(value).pass, true);
  assert.equal(
    hashTaskPacket(value),
    "1e4bbcfa436914ccde5a3fea8faaf50625d47f87de07430579e01dd7e15bcdb4",
  );
  assert.equal(planDispatch(INPUT).reasonCode, "DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH");
});
```

The literal hash above is the current packet-v1 fixture hash at base commit
`4795b665d98304cf5049f18b1c63efe1f422ef09`.

- [ ] **Step 2: Run focused tests and confirm packet v2 is rejected before implementation**

Run: `rtk node --test tests/workflow-compiler.test.mjs tests/dispatch-planner.test.mjs`

Expected: the compiler import fails or packet v2 fails with `schemaVersion must equal 1`; all pre-existing packet-v1 tests still PASS.

- [ ] **Step 3: Implement exact compilation and safe derivation of existing packet flags**

Use this compilation mapping:

```js
export function compileStagePacket({
  plan,
  planHash,
  stageId,
  approvalFacts,
  batch,
}) {
  const validation = validateWorkflowPlan(plan);
  if (!validation.pass || hashWorkflowPlan(plan) !== planHash) {
    throw new TypeError("workflow plan must be valid and hash-bound");
  }
  const stage = plan.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new TypeError("workflow stage is unknown");
  const approvalSatisfied = stage.approvalGate === null || approvalFacts.some(
    (fact) =>
      fact.authority === stage.approvalGate.authority &&
      fact.factId === stage.approvalGate.factId &&
      fact.scopeHash === planHash,
  );
  return {
    schemaVersion: 2,
    workflowAdapter: plan.workflowAdapter,
    responsibility: stage.responsibility,
    goal: stage.deliverable,
    readScope: stage.readScope,
    writeScope: stage.writeScope,
    knownFacts: stage.knownFacts,
    constraints: stage.constraints,
    deliverable: stage.deliverable,
    successCriteria: stage.successCriteria,
    checks: stage.checks,
    prohibitedActions: [
      ...stage.prohibitedActions,
      "Block and report missing information instead of guessing",
    ],
    parentPermission: stage.parentPermission,
    requiredPermission: stage.requiredPermission,
    requiresNativeLineage: false,
    requestedRole: stage.requestedRole,
    ownerOptIn: approvalSatisfied && stage.approvalGate?.authority === "owner",
    legacyAdapter: false,
    batch,
    riskSignals: stage.riskSignals,
    costSignals: stage.costSignals,
    workflowContext: {
      workflowId: plan.workflowId,
      planHash,
      stageId: stage.id,
      dependsOn: stage.dependsOn,
      inputArtifacts: stage.inputArtifacts,
      outputArtifacts: stage.outputArtifacts,
      interfaces: stage.interfaces,
      attemptClass: stage.attemptClass,
      missingInformationPolicy: "block_and_report",
    },
  };
}
```

If a gate is present and unsatisfied, `compileStagePacket` must throw `workflow stage approval is not satisfied`; it must not silently set `ownerOptIn=false` and continue. `legacyAdapter` remains false because legacy behavior stays packet-v1-only. The existing planner already requires native lineage for `sol_reviewer`; workflow v1 does not invent a broader lineage flag.

- [ ] **Step 4: Extend packet validation and rendering without weakening v1**

Replace the single packet-key set with exact versioned sets:

```js
const PACKET_V1_KEYS = new Set(BASE_PACKET_KEYS);
const PACKET_V2_KEYS = new Set([...BASE_PACKET_KEYS, "workflowContext"]);
const WORKFLOW_CONTEXT_KEYS = Object.freeze([
  "workflowId",
  "planHash",
  "stageId",
  "dependsOn",
  "inputArtifacts",
  "outputArtifacts",
  "interfaces",
  "attemptClass",
  "missingInformationPolicy",
]);
```

`validateTaskPacket` must select only schema 1 or 2, require no workflow context for v1, require the exact object for v2, reject unknown versions, and reject extra fields. `renderTaskMessage` must prepend these v2-only sections:

```text
Workflow stage
Dependencies
Available input artifacts
Required output artifacts
Stage interfaces
Attempt class
Missing information policy
```

Keep the original nine packet sections unchanged and in their existing order after the workflow sections.

- [ ] **Step 5: Add malformed-context, approval, and planner regression cases**

Prove packet v2 rejects a changed plan hash, unknown stage, missing context field, extra context field, unknown artifact, unknown attempt class, any missing-information policy other than `block_and_report`, and an unsatisfied approval gate. Prove a valid packet v2 produces the same role and execution-shape decision as an equivalent packet v1.

- [ ] **Step 6: Run focused and full tests**

Run: `rtk node --test tests/workflow-compiler.test.mjs tests/dispatch-planner.test.mjs`

Expected: all compiler and planner tests PASS, including the literal packet-v1 hash regression.

Run: `rtk npm test`

Expected: all repository tests PASS.

- [ ] **Step 7: Commit packet-v2 compilation**

```bash
rtk git add lib/workflow-compiler.mjs lib/dispatch-planner.mjs tests/workflow-compiler.test.mjs tests/dispatch-planner.test.mjs
rtk git commit -m "feat: compile workflow stage packets"
```

---

### Task 3: Lifecycle, Attempts, Adoption, and Closure

**Files:**
- Create: `lib/workflow-state.mjs`
- Create: `tests/workflow-state.test.mjs`
- Modify: `tests/helpers/workflow-fixtures.mjs`

**Interfaces:**
- Produces: `createWorkflowState({ plan, planHash, policyMode, policyHash, permissionHash, workspaceHash, at }) -> state`
- Produces: `validateWorkflowEvent(event) -> { pass, errors }`
- Produces: `reduceWorkflowEvent({ plan, state, event }) -> newState`
- Produces: `sanitizeWorkflowEventForLedger(event) -> privacy-safe replay event`
- Produces: `workflowStateSummary(state) -> privacy-safe summary`
- Produces: `STAGE_STATES` and `WORKFLOW_EVENT_TYPES`

- [ ] **Step 1: Write failing normal-lifecycle and adoption tests**

Use exact injected timestamps and prove mechanical verification is not adoption:

```js
test("stage requires verification, root adoption, and provider close", () => {
  const { plan, planHash, state } = initializedWorkflow();
  const events = [
    event("stage_ready", { stageId: "audit-core" }),
    event("stage_ready", { stageId: "audit-cli" }),
    event("batch_planned", {
      batchId: "batch-1",
      stageIds: ["audit-core", "audit-cli"],
      canaryStageId: "audit-core",
    }),
    event("materialization_started", {
      stageId: "audit-core",
      batchId: "batch-1",
      executionShape: "typed_child",
      role: "terra_explorer",
      taskHash: "a".repeat(64),
      attemptClass: "work",
    }),
    event("materialized", {
      stageId: "audit-core",
      batchId: "batch-1",
      executionId: "agent-actual-1",
      canonicalTaskName: "/root/audit_core",
      status: "running",
    }),
    event("evidence_ready", {
      stageId: "audit-core",
      resultHash: "b".repeat(64),
      artifacts: [{ id: "core-evidence", sha256: "c".repeat(64) }],
      actualModel: "gpt-5.6-terra",
      actualEffort: "medium",
      tokens: 120,
      reasonCode: "DELEGATE_TYPED_PERMISSION_MATCH",
    }),
    event("verified", { stageId: "audit-core", checkHash: "d".repeat(64) }),
  ];
  const verified = events.reduce(
    (current, item) => reduceWorkflowEvent({ plan, state: current, event: item }),
    state,
  );
  assert.equal(verified.stages["audit-core"].state, "verified");
  assert.equal(verified.stages["audit-core"].attempts[0].adopted, false);

  const adopted = reduceWorkflowEvent({
    plan,
    state: verified,
    event: event("adopted", {
      stageId: "audit-core",
      rootVerification: { pass: true, checkHash: "e".repeat(64) },
    }),
  });
  assert.equal(adopted.stages["audit-core"].state, "adopted");
  assert.equal(adopted.stages["audit-core"].attempts[0].providerClosed, false);

  const closed = reduceWorkflowEvent({
    plan,
    state: adopted,
    event: event("provider_closed", {
      stageId: "audit-core",
      disposition: "adopted",
      cleanupPassed: true,
    }),
  });
  assert.equal(closed.stages["audit-core"].state, "closed");
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `rtk node --test tests/workflow-state.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/workflow-state.mjs`.

- [ ] **Step 3: Implement the exact state and immutable event reducer**

Create state with this exact data shape:

```js
{
  schemaVersion: 1,
  workflowId: plan.workflowId,
  planHash,
  policyMode,
  policyHash,
  permissionHash,
  workspaceHash,
  approvalFacts: [],
  budget: {
    ...plan.attemptBudget,
    consumed: { total: 0, work: 0, verification: 0, recovery: 0 },
  },
  delegationStopped: false,
  stopReason: null,
  stages: Object.fromEntries(plan.stages.map((stage) => [stage.id, {
    state: "planned",
    attemptNumber: 0,
    correctionUsed: false,
    finalRejection: false,
    attempts: [],
  }])),
  activeBatch: null,
  updatedAt: at,
}
```

Every event has exact base fields `{ schemaVersion: 1, type, at }` plus the fields named for its event type. Reject missing and extra fields. Export this state set:

```js
export const STAGE_STATES = Object.freeze([
  "planned",
  "ready",
  "materializing",
  "running",
  "evidence_ready",
  "verified",
  "adopted",
  "rejected",
  "blocked",
  "closed",
]);
```

Implement these exact event effects:

| Event | Required transition or effect |
|---|---|
| `approval_recorded` | Add one unique `{ authority, factId, scopeHash, recordedAt }`; require `scopeHash === planHash`. |
| `stage_ready` | `planned -> ready`, or `blocked -> ready` only with a non-empty `resolvedFact`; require every dependency adopted or closed-after-adoption and the approval fact satisfied. |
| `batch_planned` | Require one or two ready stages, no current batch, exact stage order, one canary, and no writer mixed with another stage. |
| `materialization_started` | `ready -> materializing`; require active-batch membership and canary order; increment stage attempt number; consume one delegated budget unit unless shape is `root_inline`. |
| `materialized` | `materializing -> running`; require shape-specific validated receipt data, persist one `materializationHash`, accept only `running` or `completed`, and mark the canary ready. |
| `evidence_ready` | `running -> evidence_ready`; persist only result/artifact hashes, safe model/effort, aggregate tokens, reason code, and `synthetic` boolean. |
| `verified` | `evidence_ready -> verified`; require a SHA-256 mechanical-check hash. |
| `adopted` | `verified -> adopted`; require `rootVerification.pass === true` and a SHA-256 root-check hash. |
| `rejected` | `evidence_ready -> rejected`; persist `final`, `hardFailure`, and a safe reason code; never unlock dependents; a hard failure sets `delegationStopped`. |
| `provider_closed` | Require `cleanupPassed === true`; mark the current attempt closed; transition adopted or final-rejected stages to `closed`. |
| `correction_authorized` | `rejected -> ready`; require non-final rejection, a closed provider attempt, unused correction, unchanged scope hash, and either delegated recovery reserve or `executionShape: "root_inline"`. |
| `stage_blocked` | `planned`, `ready`, `materializing`, or `running` -> `blocked`; retain consumed attempts and a safe reason code. |
| `stage_cancelled` | Require a matching owner approval fact; close an unmaterialized planned, ready, or blocked stage as final owner cancellation without adoption. |

At `materialization_started`, copy the verification and recovery reserve counts
into the attempt as `reservedAttemptsBefore` and `reservedAttemptsAfter`; the
after value reflects only the current attempt's exact consumption. These are
the only source for later outcome records.

If a canary becomes blocked before a deferred member materializes, atomically
mark every unstarted deferred member blocked with
`WORKFLOW_CANARY_FAILED`, preserve their attempts, set `delegationStopped`, and
clear `activeBatch`. They may return to ready only after an explicit Sol
resolved fact. A hard failure or canary failure prevents all further delegated
actions; remaining safe work may be returned root-inline only.

Use `structuredClone(state)` before every mutation and return the clone. An invalid transition throws `TypeError` without changing the input state. When every stage in an active batch is adopted, finally rejected, blocked, cancelled, or closed, clear `activeBatch`.

For typed children, `materialized` requires the raw execution ID and canonical
task name in the ephemeral event and hashes both into `materializationHash`.
For isolated roots, hash the already validated completed dispatch-result
envelope. For root-inline, derive the hash from plan hash, stage ID, task hash,
and attempt number; no fake process ID is accepted.

`sanitizeWorkflowEventForLedger` must replace raw receipt inputs with the
single `materializationHash`, retain only safe identifiers, enums, hashes,
artifact hashes, aggregate tokens, booleans, and reason codes, and return an
event variant that `reduceWorkflowEvent` can replay without access to the raw
values.

- [ ] **Step 4: Add canary, budget, correction, and invalid-transition tests**

Prove all of these fail closed:

```js
const rejectedTransitions = [
  "planned -> materialized",
  "running -> adopted",
  "verified -> closed without provider cleanup",
  "rejected -> ready without correction authorization",
  "adopted -> ready",
  "closed -> ready",
];
```

Add tests proving the second batch member cannot enter `materializing` before the canary receipt; a failed canary consumes only its own attempt, blocks every deferred member, and stops delegation; `root_inline` consumes zero delegated attempts; reserve before/after snapshots are exact; a delegated correction consumes the one recovery reserve; a second correction is rejected; a hard-failure rejection marked final cannot be corrected; owner cancellation requires a matching fact; a rejected or cancelled result never unlocks its dependent; raw execution ID and canonical task name are absent from state and `workflowStateSummary`; and the input state remains deeply equal to its pre-call clone after every rejected event.

- [ ] **Step 5: Run focused and full tests**

Run: `rtk node --test tests/workflow-state.test.mjs`

Expected: all workflow-state tests PASS.

Run: `rtk npm test`

Expected: all repository tests PASS.

- [ ] **Step 6: Commit lifecycle state**

```bash
rtk git add lib/workflow-state.mjs tests/helpers/workflow-fixtures.mjs tests/workflow-state.test.mjs
rtk git commit -m "feat: add workflow lifecycle state"
```

---

### Task 4: Scheduler, Reserved Capacity, and Materialization Canary

**Files:**
- Create: `lib/workflow-scheduler.mjs`
- Create: `lib/workflow-orchestrator.mjs`
- Create: `tests/workflow-scheduler.test.mjs`
- Create: `tests/workflow-orchestrator.test.mjs`
- Modify: `tests/helpers/workflow-fixtures.mjs`

**Interfaces:**
- Produces: `readyStageIds({ plan, state }) -> stageId[]`
- Produces: `selectCandidateBatch({ plan, state }) -> candidate batch`
- Produces: `scheduleWorkflow({ plan, state, candidate, decisions }) -> schedule result`
- Produces: `planNextWorkflowAction({ plan, planHash, state, policy, capabilities, roleSpecs }) -> { readinessEvents, batchEvent, action }`
- Produces: `validateMaterializationReceipt({ action, receipt }) -> { pass, sanitized, errors }`
- Produces: `providerForDecision(decision) -> { capabilities, materialize, readiness, collectEvidence, close }`

- [ ] **Step 1: Write failing dependency, batching, and reserve tests**

Use planner decisions keyed by stage ID and assert stable plan order:

```js
test("two independent readers form one canary-gated batch", () => {
  const { plan, state } = initializedWorkflow({ ready: ["audit-core", "audit-cli"] });
  const candidate = selectCandidateBatch({ plan, state });
  const result = scheduleWorkflow({
    plan,
    state,
    candidate,
    decisions: new Map([
      ["audit-core", isolatedDecision("audit-core")],
      ["audit-cli", isolatedDecision("audit-cli")],
    ]),
  });
  assert.deepEqual(result, {
    kind: "batch",
    stageIds: ["audit-core", "audit-cli"],
    canaryStageId: "audit-core",
    deferredStageIds: ["audit-cli"],
  });
});

test("work cannot consume verification or recovery reserves", () => {
  const { plan, state } = initializedWorkflow({
    budget: { total: 4, work: 2, verification: 0, recovery: 0 },
    ready: ["audit-core"],
  });
  const candidate = selectCandidateBatch({ plan, state });
  const result = scheduleWorkflow({
    plan,
    state,
    candidate,
    decisions: new Map([["audit-core", typedDecision("audit-core")]]),
  });
  assert.equal(result.kind, "root_inline");
  assert.equal(result.reasonCode, "ROOT_WORK_ATTEMPT_RESERVE_PROTECTED");
});
```

- [ ] **Step 2: Run focused tests and confirm missing modules fail**

Run: `rtk node --test tests/workflow-scheduler.test.mjs tests/workflow-orchestrator.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for the scheduler or orchestrator.

- [ ] **Step 3: Implement dependency readiness and exact reserve accounting**

Calculate delegated capacity with these exact equations:

```js
const remainingTotal = budget.total - budget.consumed.total;
const verificationHeld = Math.max(
  0,
  budget.reservedForVerification - budget.consumed.verification,
);
const recoveryHeld = Math.max(
  0,
  budget.reservedForRecovery - budget.consumed.recovery,
);
const unreservedWork = remainingTotal - verificationHeld - recoveryHeld;
```

Apply these scheduling rules in order:

1. Include only `ready` stages whose dependencies are adopted or closed-after-adoption and whose approval gate is satisfied.
2. Return `{ kind: "complete", disposition }` only when every stage is closed after adoption or an owner-recorded final cancellation.
3. If the first ready stage's effective decision is `root_inline`, return exactly one root-inline action without consuming delegated capacity.
4. A work delegation requires `unreservedWork >= 1` for each selected stage; otherwise return root-inline with `ROOT_WORK_ATTEMPT_RESERVE_PROTECTED`.
5. A verification delegation consumes verification reserve; exhausted mandatory verification returns blocked with `WORKFLOW_VERIFICATION_RESERVE_EXHAUSTED`.
6. A recovery delegation consumes the one recovery reserve; exhaustion returns root-inline with `ROOT_RECOVERY_RESERVE_EXHAUSTED`.
7. Never mix a writer with another stage. Select at most two read-only stages and require pairwise disjoint declared write scopes.
8. Preserve plan stage order. Never reorder by role price or model family.
9. When `state.delegationStopped === true`, emit no delegated action; return
   one safe ready stage root-inline or return blocked with `state.stopReason`.

- [ ] **Step 4: Implement per-stage planning and the root-driven action protocol**

`planNextWorkflowAction` must:

1. Produce deterministic `stage_ready` events for newly ready stages.
2. Apply those events to a projected immutable state, then call
   `selectCandidateBatch` using only DAG, approval, scope, writer, reserve, and
   plan-order facts.
3. Compile each candidate stage with the candidate's exact
   `requestedChildren`, `writerCount`, and `scopesDisjoint` batch object.
4. Call `planDispatch` independently for each compiled packet.
5. Pass the candidate and decisions to `scheduleWorkflow` for finalization. If
   any candidate becomes root-inline, do not mix it with a delegated action;
   return the earliest root-inline stage and replan remaining work afterward.
6. Derive `batchId = sha256(planHash + "\n" + stageIds.join("\n") + "\n" + attemptNumbers.join("\n"))`.
7. Return a one-stage `batch_planned` event for root-inline work, or a bounded
   batch event plus only the delegated canary materialization action.
8. Return a deferred member only after state records a valid canary receipt.
9. When an active batch exists, never plan a second batch; return only its
   legal deferred action or a wait/blocked result.

Use this action shape:

```js
{
  kind: "materialize",
  workflowId: plan.workflowId,
  planHash,
  batchId,
  stageId,
  canary: stageId === canaryStageId,
  deferredStageIds,
  packet,
  decision,
}
```

For `typed_child`, `decision.spawnArgs` is the only allowed native spawn request. For `isolated_role_root`, the root feeds `packet` to the existing managed `run-isolated` path. For `root_inline`, return `{ kind: "root_inline", stageId, packet, decision }`. The module emits actions and validates receipts; it never imports or calls `spawn_agent`.

`providerForDecision` must expose the design's five-method provider interface.
For `typed_child`, `materialize` and `close` return explicit root-tool actions,
while `readiness` and `collectEvidence` validate root-submitted ephemeral
receipts and dispatch evidence. For `isolated_role_root`, `materialize` returns
the managed `run-isolated` action and completed dispatch evidence satisfies
readiness. For `root_inline`, the provider returns root-owned work and evidence
actions. Providers never choose stages, roles, budgets, retries, or success.
Every method rejects an execution-shape or task-hash mismatch.

- [ ] **Step 5: Validate raw receipts and persist only sanitized facts**

Accept this typed-child receipt only in an ephemeral event envelope:

```js
{
  schemaVersion: 1,
  executionShape: "typed_child",
  taskHash: action.decision.taskHash,
  executionId: "actual-agent-id",
  canonicalTaskName: "/root/task_name",
  status: "running" | "completed"
}
```

Accept an isolated-root receipt only when it contains the exact validated dispatch result and `status: "completed"`. Root-inline materialization is created internally from the root action and does not accept a caller-supplied process identity. Return a sanitized receipt containing `materializationHash`, task hash, shape, and status, never the raw execution ID or task name. Reject a shape mismatch, task-hash mismatch, missing typed identifier, unknown status, failed dispatch result, or extra field.

- [ ] **Step 6: Add writer, ordering, and failure-path tests**

Prove two readers may batch; two writers never batch; one reader and one writer never batch; overlapping read-only write scopes fail closed even when a malformed upstream plan bypasses the normal validator fixture; the second action is absent before canary readiness and present afterward; canary timeout blocks the batch without consuming the deferred attempt; planner `root_inline` decisions remain root-inline; shadow mode never emits a delegated effective action; and no returned state or summary contains raw execution identity.

- [ ] **Step 7: Run focused and full tests**

Run: `rtk node --test tests/workflow-scheduler.test.mjs tests/workflow-orchestrator.test.mjs`

Expected: all scheduler and orchestrator tests PASS.

Run: `rtk npm test`

Expected: all repository tests PASS.

- [ ] **Step 8: Commit scheduling and orchestration**

```bash
rtk git add lib/workflow-scheduler.mjs lib/workflow-orchestrator.mjs tests/helpers/workflow-fixtures.mjs tests/workflow-scheduler.test.mjs tests/workflow-orchestrator.test.mjs
rtk git commit -m "feat: schedule verified workflow stages"
```

---

### Task 5: Private JSONL and Hash-Chained Workflow Ledger

**Files:**
- Create: `lib/private-jsonl.mjs`
- Create: `lib/workflow-ledger.mjs`
- Create: `tests/private-jsonl.test.mjs`
- Create: `tests/workflow-ledger.test.mjs`
- Modify: `lib/dispatch-ledger.mjs`
- Modify: `tests/dispatch-ledger.test.mjs`

**Interfaces:**
- Produces: `appendPrivateJsonl(path, value, { defaultPath, validate }) -> void`
- Produces: `readPrivateJsonl(path, { defaultPath, validate }) -> value[]`
- Produces: `createWorkflowRecord({ previousRecordHash, state, event }) -> record`
- Produces: `validateWorkflowRecord(record) -> { pass, errors }`
- Produces: `appendWorkflowRecord(store, record) -> void`
- Produces: `replayWorkflowRecords({ plan, records }) -> state`
- Produces: `selectWorkflowStore({ upstream, managedPath }) -> store selection`
- Default local path: `reports/workflow-ledger.jsonl`

- [ ] **Step 1: Write failing private-file and dispatch-regression tests**

Prove the shared primitive preserves current dispatch behavior:

```js
test("private JSONL creates 0700 parent and 0600 complete records", async (t) => {
  const root = await fixtureDirectory(t);
  const path = join(root, "owned", "ledger.jsonl");
  appendPrivateJsonl(path, { sequence: 1 }, {
    defaultPath: path,
    validate: () => ({ pass: true, errors: [] }),
  });
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
});

test("dispatch ledger schema and serialized record remain unchanged", () => {
  const value = dispatchRecordFixture();
  appendDispatchRecord(path, value);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), value);
  assert.equal(validateDispatchRecord(value).pass, true);
});
```

- [ ] **Step 2: Run focused tests and verify the shared module is missing**

Run: `rtk node --test tests/private-jsonl.test.mjs tests/dispatch-ledger.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `lib/private-jsonl.mjs`; existing dispatch-ledger tests otherwise remain green.

- [ ] **Step 3: Extract the existing durability contract without weakening it**

Move the directory/file checks from `lib/dispatch-ledger.mjs` into `lib/private-jsonl.mjs`. The shared primitive must:

- reject symlinked parents and files;
- require current-user ownership when `process.getuid` exists;
- create or narrowly repair only the declared default parent to mode `0700`;
- require caller-provided non-default parents already be owned `0700` directories;
- require a regular `0600` file opened with no-follow semantics;
- reject a pre-existing file whose final byte is not newline;
- canonicalize object keys, append exactly one JSON object plus newline in one write, verify the byte count, and `fsync` before close;
- parse every non-empty line and run the supplied validator during replay;
- reject malformed or incomplete lines without returning partial state.

Refactor `appendDispatchRecord` to call `appendPrivateJsonl` and preserve `DEFAULT_DISPATCH_LEDGER_PATH`, record fields, validation messages, file modes, and public tests.

- [ ] **Step 4: Define exact hash-chained workflow records**

Use this exact record shape:

```js
{
  schemaVersion: 1,
  kind: "workflow_transition",
  updatedAt,
  workflowId,
  planHash,
  stageId,
  eventType,
  eventData,
  state,
  stateHash,
  attempt,
  attemptClass,
  executionShape,
  role,
  taskHash,
  resultHash,
  disposition,
  adopted,
  policyMode,
  policyHash,
  permissionHash,
  workspaceHash,
  previousRecordHash,
  recordHash,
}
```

`eventData` is the exact output of `sanitizeWorkflowEventForLedger`; it may
contain only the event-specific safe fields accepted by the state reducer.
`stateHash` is the canonical SHA-256 of `workflowStateSummary(state)`. Nullable
stage/attempt fields are allowed only for workflow initialization and approval
records. Compute `recordHash` over every field except `recordHash`; require the
first `previousRecordHash` to be `null`, every later value to equal the prior
`recordHash`, and all hashes to be lowercase SHA-256. Validate safe IDs/enums
and run the same recursive privacy scan as the dispatch ledger.

- [ ] **Step 5: Implement store selection with no duplicate source of truth**

Use this selection contract:

```js
export function selectWorkflowStore({
  upstream = null,
  managedPath = DEFAULT_WORKFLOW_LEDGER_PATH,
}) {
  if (upstream !== null) {
    const required = Object.freeze([
      "workflowId", "planHash", "stageId", "state", "attempt",
      "executionShape", "role", "taskHash", "resultHash", "adopted", "updatedAt",
    ]);
    if (upstream.supports(required) !== true) {
      return { kind: "blocked", reasonCode: "WORKFLOW_UPSTREAM_STORE_INCOMPATIBLE" };
    }
    return { kind: "upstream", load: upstream.load, append: upstream.append };
  }
  return { kind: "managed", path: managedPath };
}
```

When an upstream adapter is supplied but incompatible, do not create or write the managed ledger. When no upstream adapter exists, use only the managed ledger. Replay every sanitized transition through `reduceWorkflowEvent`; reject a duplicate initialization, broken hash chain, reordered record, event/state mismatch, or replay result whose summary hash differs from `stateHash`.

- [ ] **Step 6: Add concurrent append, privacy, and source-of-truth tests**

Launch eight fixture Node processes that each append one generic sub-4-KiB
record with `O_APPEND`; require eight complete unique records. Separately append
workflow records in deterministic order and require a valid chain after every
record. Also reject forbidden fields named `prompt`, `message`, `goal`,
`sessionId`, `threadId`, `executionId`, `path`, `cwd`, `auth`, `secret`,
`token`, `stdout`, or `stderr`, plus private absolute home paths. Prove a
compatible upstream fake receives records while no
`reports/workflow-ledger.jsonl` is created, and an incompatible upstream
returns blocked with no fallback file.

- [ ] **Step 7: Run focused and full tests**

Run: `rtk node --test tests/private-jsonl.test.mjs tests/workflow-ledger.test.mjs tests/dispatch-ledger.test.mjs`

Expected: all private-ledger, workflow-ledger, and unchanged dispatch-ledger tests PASS.

Run: `rtk npm test`

Expected: all repository tests PASS.

- [ ] **Step 8: Commit durable workflow state**

```bash
rtk git add lib/private-jsonl.mjs lib/workflow-ledger.mjs lib/dispatch-ledger.mjs tests/private-jsonl.test.mjs tests/workflow-ledger.test.mjs tests/dispatch-ledger.test.mjs
rtk git commit -m "feat: persist hash-bound workflow state"
```

---

### Task 6: Resume Validation and Privacy-Safe Workflow Outcomes

**Files:**
- Create: `lib/workflow-recovery.mjs`
- Create: `lib/workflow-outcome.mjs`
- Create: `tests/workflow-recovery.test.mjs`
- Create: `tests/workflow-outcome.test.mjs`
- Modify: `lib/workflow-ledger.mjs`
- Modify: `tests/workflow-ledger.test.mjs`

**Interfaces:**
- Produces: `createWorkflowBinding({ plan, policy, capabilities, cwd }) -> binding`
- Produces: `resumeWorkflow({ plan, records, binding, currentArtifactHashes }) -> resume result`
- Produces: `createWorkflowOutcomeRecord({ plan, state, stageId, generatedAt }) -> record`
- Produces: `validateWorkflowOutcomeRecord(record) -> { pass, errors }`
- Produces: `appendWorkflowOutcome(path, record) -> void`
- Default outcome path: `reports/workflow-outcomes.jsonl`

- [ ] **Step 1: Write failing adopted-stage resume and drift tests**

Use a ledger fixture with `audit-core` adopted and provider-closed while
`audit-cli` remains ready:

```js
test("resume preserves adopted work and returns only remaining stages", () => {
  const fixture = adoptedWorkflowLedger();
  const resumed = resumeWorkflow({
    plan: fixture.plan,
    records: fixture.records,
    binding: fixture.binding,
    currentArtifactHashes: { "core-evidence": "c".repeat(64) },
  });
  assert.equal(resumed.pass, true);
  assert.equal(resumed.state.stages["audit-core"].state, "closed");
  assert.deepEqual(resumed.remainingStageIds, ["audit-cli", "verify-evidence"]);
  assert.deepEqual(resumed.rerunStageIds, []);
});

test("resume blocks every binding and artifact drift independently", () => {
  const fixture = adoptedWorkflowLedger();
  for (const [key, reasonCode] of [
    ["planHash", "WORKFLOW_PLAN_HASH_MISMATCH"],
    ["policyHash", "WORKFLOW_POLICY_DRIFT"],
    ["permissionHash", "WORKFLOW_PERMISSION_DRIFT"],
    ["workspaceHash", "WORKFLOW_WORKSPACE_DRIFT"],
  ]) {
    const binding = { ...fixture.binding, [key]: "f".repeat(64) };
    assert.equal(
      resumeWorkflow({
        plan: fixture.plan,
        records: fixture.records,
        binding,
        currentArtifactHashes: { "core-evidence": "c".repeat(64) },
      }).reasonCode,
      reasonCode,
    );
  }
  assert.equal(
    resumeWorkflow({
      plan: fixture.plan,
      records: fixture.records,
      binding: fixture.binding,
      currentArtifactHashes: { "core-evidence": "0".repeat(64) },
    }).reasonCode,
    "WORKFLOW_ARTIFACT_DRIFT",
  );
});
```

- [ ] **Step 2: Run focused tests and verify the recovery module is missing**

Run: `rtk node --test tests/workflow-recovery.test.mjs tests/workflow-outcome.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for the recovery or outcome module.

- [ ] **Step 3: Implement exact resume bindings and interruption handling**

`createWorkflowBinding` must produce this exact binding object:

```js
{
  planHash: hashWorkflowPlan(plan),
  policyMode: "shadow" | "active",
  policyHash: "64 lowercase hex characters",
  permissionHash: "64 lowercase hex characters",
  workspaceHash: "64 lowercase hex characters"
}
```

Compute `planHash` from the canonical plan and take `policyMode` and
`policyHash` from the already validated managed policy. Compute
`permissionHash` over the exact capability booleans plus every stage's ID,
parent permission, required permission, responsibility, and requested role.
Compute `workspaceHash` from a canonical read-only snapshot of every distinct
declared read/write scope: relative path, entry type, mode, and file-content
hash. Represent a not-yet-created write target as `missing`; reject absolute
paths, escapes, symlinks, special files, and path replacement during the
snapshot. Return only the aggregate hashes, never the snapshot paths or file
contents.

`resumeWorkflow` must validate and replay the complete hash chain before
returning state. Apply these reason codes in order:

1. `WORKFLOW_LEDGER_INVALID` for parse, schema, chain, replay, state-hash, duplicate-initialization, or incomplete-record failure.
2. `WORKFLOW_PLAN_HASH_MISMATCH` when the supplied canonical plan hash differs.
3. `WORKFLOW_POLICY_DRIFT` for policy mode or policy hash drift.
4. `WORKFLOW_PERMISSION_DRIFT` for permission-fact hash drift.
5. `WORKFLOW_WORKSPACE_DRIFT` for workspace-fact hash drift.
6. `WORKFLOW_ARTIFACT_DRIFT` when an adopted output artifact is missing or its current SHA-256 differs.
7. `WORKFLOW_INCOMPLETE_EXECUTION` when any stage was interrupted in `materializing`, `running`, `evidence_ready`, or `verified`.

An incomplete execution remains blocked for Sol adjudication because raw
execution IDs are intentionally not persisted. Never silently rerun it. A
`planned`, `ready`, or explicitly resolved `blocked` stage may resume. An
adopted or closed-after-adoption stage is never returned in `rerunStageIds`.

- [ ] **Step 4: Implement exact privacy-safe outcome records**

Use this record and no additional fields:

```js
{
  schemaVersion: 1,
  kind: "workflow_outcome",
  generatedAt,
  workflowHash,
  stageIdHash,
  attemptClass,
  attemptNumber,
  materialized,
  verified,
  adopted,
  closed,
  rootReworkRequired,
  reservedAttemptsBefore: { verification, recovery },
  reservedAttemptsAfter: { verification, recovery },
  retryCount,
  escalatedToRoot,
  actualModel,
  actualEffort,
  tokens,
  reasonCode,
  synthetic,
}
```

Set `workflowHash = sha256(plan.workflowId)` and
`stageIdHash = sha256(stageId)`. Derive all booleans and counts from immutable
state; do not accept caller overrides. `retryCount` is zero or one.
`rootReworkRequired` is true only when a correction or inline Sol remediation
was recorded. `tokens` is a nonnegative aggregate for the stage attempt. Use
the existing private JSONL primitive for the separate ignored outcome path.
This evidence file is never replayed as workflow state and is not a competing
source of truth. When an upstream workflow exposes an explicit outcome sink,
send the same validated record there and do not create the managed outcome
file.

- [ ] **Step 5: Add privacy, incomplete-state, and outcome-derivation tests**

Reject resume from a malformed final line, a broken chain, a changed recorded
state hash, an unknown event, missing adopted artifact, and every incomplete
execution state. Prove `planned` and `ready` stages resume without duplicate
records. Prove the outcome contains none of `workflowId`, `stageId`, `goal`,
`prompt`, `path`, `executionId`, `sessionId`, `threadId`, or raw artifact
content; reject extra fields, negative tokens, retry count above one, an unsafe
reason code, or a private absolute path nested anywhere in the record.

- [ ] **Step 6: Run focused and full tests**

Run: `rtk node --test tests/workflow-ledger.test.mjs tests/workflow-recovery.test.mjs tests/workflow-outcome.test.mjs`

Expected: all workflow persistence, resume, and outcome tests PASS.

Run: `rtk npm test`

Expected: all repository tests PASS.

- [ ] **Step 7: Commit resume and outcome evidence**

```bash
rtk git add lib/workflow-ledger.mjs lib/workflow-recovery.mjs lib/workflow-outcome.mjs tests/workflow-ledger.test.mjs tests/workflow-recovery.test.mjs tests/workflow-outcome.test.mjs
rtk git commit -m "feat: resume adopted workflow state"
```

---

### Task 7: Managed `workflow-next` CLI and Current Execution Shapes

**Files:**
- Create: `lib/owned-packet.mjs`
- Create: `lib/workflow-cli.mjs`
- Create: `tests/owned-packet.test.mjs`
- Create: `tests/workflow-cli.test.mjs`
- Modify: `scripts/gearbox-dispatch.mjs`
- Modify: `tests/dispatch-cli.test.mjs`
- Modify: `lib/dispatch-runner.mjs`
- Modify: `tests/dispatch-runner.test.mjs`

**Interfaces:**
- Produces: `readOwnedPacket(path, { consume }) -> parsed object`
- Produces: `validateWorkflowEnvelope(envelope) -> { pass, errors }`
- Produces: `runWorkflowNext({ envelope, policy, capabilities, roleSpecs, cwd }) -> redacted result`
- Adds CLI: `gearbox-dispatch workflow-next --packet <owned-temp-json> [--consume] <capability flags>`
- Preserves CLI: `status`, `plan`, and `run-isolated`

- [ ] **Step 1: Extract private packet behavior under regression tests**

Move `resolveOwnedPacket`, `readOwnedPacket`, ownership checks, no-follow open,
same-file verification, and consume-after-read behavior from
`scripts/gearbox-dispatch.mjs` into `lib/owned-packet.mjs`. Add focused tests
for a valid owned `0600` packet, unowned mode, symlinked file, symlinked parent,
path outside the owned temp prefix, file replacement between stat and open,
invalid JSON, and consume. Keep the existing CLI packet tests unchanged.

Run: `rtk node --test tests/owned-packet.test.mjs tests/dispatch-cli.test.mjs`

Expected before extraction: FAIL with `ERR_MODULE_NOT_FOUND`; after extraction,
all focused and existing packet tests PASS.

- [ ] **Step 2: Write a failing initial `workflow-next` CLI test**

Use this exact private envelope:

```js
{
  schemaVersion: 1,
  plan: workflowPlan(),
  binding: {
    currentArtifactHashes: {},
  },
  stateSource: { kind: "managed" },
  event: null,
}
```

Call the CLI with the same four exact capability flags used by `plan`. Assert:

```js
assert.equal(output.status, "GEARBOX_WORKFLOW_ACTION");
assert.equal(output.mode, "shadow");
assert.equal(output.action.kind, "root_inline");
assert.equal(output.action.stageId, "audit-core");
assert.equal(output.stateSource, "managed");
assert.doesNotMatch(result.stdout, /Audit two modules|actual-agent-id|\/Users\//);
```

- [ ] **Step 3: Implement the exact envelope and state-source contract**

`validateWorkflowEnvelope` must accept exactly:

```js
{
  schemaVersion: 1,
  plan,
  binding: {
    currentArtifactHashes,
  },
  stateSource:
    { kind: "managed" } |
    {
      kind: "upstream",
      schemaFields: [
        "workflowId", "planHash", "stageId", "state", "attempt",
        "executionShape", "role", "taskHash", "resultHash", "adopted", "updatedAt",
      ],
      records: [],
    },
  event: null | workflowEvent,
}
```

For managed state, use only `reports/workflow-ledger.jsonl` beneath the current
workspace. For upstream state, validate and replay the supplied records, write
no local ledger or outcome file, and return `recordsToAppend` plus
`outcomesToAppend` so the upstream owner can append them. An incompatible or malformed upstream source returns
`GEARBOX_WORKFLOW_BLOCKED` with `WORKFLOW_UPSTREAM_STORE_INCOMPATIBLE`; it never
falls back to managed state.

On every call, compute the current plan, policy, permission, and workspace
binding with `createWorkflowBinding`; never accept those hashes from the
envelope. On the first call, initialize state and record newly ready stages plus the
planned batch. On later calls, apply the supplied event, append sanitized
transition records, derive outcomes only after closure, and return exactly one
next action, blocked result, or complete result. Resume compares the computed
binding with the ledger's initialization binding.

- [ ] **Step 4: Route current shapes without inventing a core hook**

For a typed action, return only the existing `decision.spawnArgs`; the Sol root
performs the actual `spawn_agent` call and submits the real receipt in the next
consumed envelope. The action protocol must not import an agent tool or claim
interception.

For an isolated action, return the compiled packet accepted by existing
`run-isolated`. After that synchronous managed run passes, the root submits an
isolated `materialized` receipt with status `completed`, then evidence,
verification, adoption, and provider-close events. Extend
`runIsolatedRole` only enough to accept task-packet v2 serialization and retain
its current exact model, effort, sandbox, no-spawn, scope, token, marker, and
cleanup checks.

For root-inline, record zero delegated attempt consumption while still
requiring evidence, verification, adoption, and closure before dependents
unlock.

On a hard active-mode failure, atomically stop later workflow delegation and
return `rollbackRequired: true` plus the safe reason code. Do not expose the
manifest path and do not run rollback inside `workflow-next`; the Sol root may
invoke only the existing managed manifest-bound rollback command. In shadow
mode, report the same rejected plan/result evidence without claiming an active
rollback is required.

- [ ] **Step 5: Add canary, upstream, resume, and redaction CLI tests**

Prove all of these through temporary homes and workspaces:

- active typed workflow returns only the first spawn action;
- submitting a valid running receipt returns the deferred second spawn action;
- missing, malformed, mismatched, completed-without-identity, or failed-canary
  receipts never release the deferred action;
- shadow mode calculates decisions but returns root-inline effective actions;
- `off` and active-manifest drift fail before reading or consuming the plan;
- isolated packet v2 runs through the fake Codex runtime and failed evidence is
  never exposed as an adopted deliverable;
- managed state creates only the ignored workflow ledger with private modes;
- upstream state writes no managed ledger and returns exact records to append;
- a second process resumes adopted work without rerunning it;
- a hard active failure returns `rollbackRequired: true`, releases no later
  delegated action, and exposes no manifest path; shadow returns false;
- raw plan goal, execution ID, canonical task name, private path, and upstream
  record contents are absent from stdout and stderr; the intentional current-
  stage `spawnArgs.message` remains self-contained and contains no parent
  history or unrelated stages;
- existing `status`, `plan`, and `run-isolated` behavior remains unchanged.

- [ ] **Step 6: Run focused and full tests**

Run: `rtk node --test tests/owned-packet.test.mjs tests/workflow-cli.test.mjs tests/dispatch-cli.test.mjs tests/dispatch-runner.test.mjs`

Expected: all owned-packet, workflow CLI, dispatch CLI, and runner tests PASS.

Run: `rtk npm test`

Expected: all repository tests PASS.

- [ ] **Step 7: Commit the managed workflow CLI**

```bash
rtk git add lib/owned-packet.mjs lib/workflow-cli.mjs lib/dispatch-runner.mjs scripts/gearbox-dispatch.mjs tests/owned-packet.test.mjs tests/workflow-cli.test.mjs tests/dispatch-cli.test.mjs tests/dispatch-runner.test.mjs
rtk git commit -m "feat: add managed workflow actions"
```

---

### Task 8: Comparative Contract Gate and Q10 Canary Evidence

**Files:**
- Create: `lib/workflow-contract-evidence.mjs`
- Create: `scripts/workflow-contract-evidence.mjs`
- Create: `docs/workflow-contract-evidence.json`
- Create: `tests/workflow-acceptance.test.mjs`
- Create: `tests/workflow-contract-evidence.test.mjs`
- Modify: `package.json`
- Modify: `lib/gearbox.mjs`
- Modify: `lib/acceptance-exam.mjs`
- Modify: `scripts/gearbox.mjs`
- Modify: `tests/acceptance-exam.test.mjs`
- Modify: `tests/gearbox.test.mjs`

**Interfaces:**
- Preserves: the exact ordered ten-question acceptance exam and activation threshold
- Extends Q10: public `workflowCanary: true` only after persisted canary ordering passes
- Produces deterministic comparative coverage for five bounded workflow scenarios
- Produces: `createWorkflowContractEvidence({ sourceManifest, scenarios, generatedAt })`
- Adds script: `npm run workflow:evidence -- --output <path>` and `--check <path>`

- [ ] **Step 1: Write five failing comparative contract scenarios**

Build each scenario in `lib/workflow-contract-evidence.mjs` from the same
workflow modules and fake decisions; do not import, execute, or vendor the
external repository. Use this exact scenario table:

```js
const SCENARIOS = Object.freeze([
  {
    id: "parallel_research_then_verify",
    requires: ["dag", "selfContainedPackets", "canary", "reservedVerification", "adoption"],
  },
  {
    id: "two_audits_then_writer",
    requires: ["dag", "readerBatch", "separateWriterRound", "oneWriter", "adoption"],
  },
  {
    id: "resume_after_adopted_stage",
    requires: ["hashBoundResume", "noDuplicateAdoptedWork", "artifactReadback"],
  },
  {
    id: "first_execution_fails_to_materialize",
    requires: ["canary", "deferredAttemptPreserved", "blocked"],
  },
  {
    id: "invalid_or_out_of_scope_artifact",
    requires: ["runtimeEvidence", "scopeRejection", "noAdoption", "noRetry"],
  },
]);
```

For every scenario, assert both the useful external workflow contract and the
additional Gearbox assertions:

```js
assert.deepEqual(result.contract, {
  stageOrderPreserved: true,
  selfContainedHandoff: true,
  firstRealExecutionCanary: true,
  futureCapacityReserved: true,
  resultAdoptionExplicit: true,
  typedIdentityRequired: true,
  permissionsRequired: true,
  runtimeEvidenceRequired: true,
  resumableWithoutDuplicateWork: true,
  privacySafeOutcome: true,
});
```

- [ ] **Step 2: Run the comparative test and confirm missing scenario behavior**

Run: `rtk node --test tests/workflow-acceptance.test.mjs`

Expected: FAIL because the first real canary, deferred release, or adopted
resume assertions are not all wired through the integration harness yet.

- [ ] **Step 3: Keep ten questions and strengthen Q10's topology contract**

Do not add or remove an acceptance question. Change only Q10's parallel result
requirements. In the live parent prompt, require this exact tool order:

1. `spawn_agent` for `luna_clerk` with the existing exact arguments.
2. `list_agents` after the first spawn returns.
3. Confirm the Luna child is running or completed.
4. `spawn_agent` for `terra_explorer` with the existing exact arguments.
5. Wait for both markers, then return the parent marker.

Continue to forbid model, effort, service-tier, write, and descendant changes.
Extend `summarizeRollout` with a privacy-safe `toolTimeline` that correlates
function-call IDs to function outputs in event order and retains only tool name,
call index, output-present boolean, output SHA-256, and a parsed
`runningOrCompleted` boolean. It must never retain the list output, agent ID, or
canonical task name. The persisted parent timeline must contain the ordered
pattern `spawn_agent(luna_clerk)`, `list_agents` with a correlated output that
shows the first canonical task running or completed, then
`spawn_agent(terra_explorer)`. The persisted child set must contain the matching
Luna child. Treat that combination as the Q10 materialization receipt; a prose
claim or uncorrelated list call is insufficient.

Add this private topology object:

```js
workflowCanary: {
  firstRole: "luna_clerk",
  firstChildPersisted: true,
  listObservedBetweenSpawns: true,
  listReceiptRunningOrCompleted: true,
  secondRole: "terra_explorer",
  secondSpawnAfterCanary: true,
}
```

`parallelPasses` must require all six values plus the existing exact model,
effort, sandbox, lineage, token, no-writer, no-descendant, distinct-message,
marker, and unchanged-filesystem checks.

- [ ] **Step 4: Publish only the boolean Q10 canary verdict**

Add `PARALLEL_QUESTION_KEYS = [...QUESTION_KEYS, "workflowCanary"]`. For Q10,
`publicQuestion` emits `workflowCanary: parallelPasses(result.topology)`. Other
positive questions retain the existing exact keys; negative questions retain
their current exact keys. `validateAcceptanceEvidence` must require Q10's
boolean to be true without persisting topology, prompts, call arguments,
execution IDs, or session IDs.

- [ ] **Step 5: Add Q10 negative mutations and complete comparative assertions**

Reject Q10 independently when the first role is wrong, `list_agents` is
missing, its output is absent or does not show running/completed, list occurs after both spawns, the first child has no persisted
rollout, the second spawn occurs before the canary point, either message is
empty, model/effort/sandbox drifts, lineage is weak, a writer appears, a
descendant appears, or cleanup fails. Complete the five deterministic scenarios
and require no model calls, no global writes, and no raw workflow content in
their results.

- [ ] **Step 6: Run focused and full tests**

Add a generator test that requires exactly five passing scenarios, a canonical
source manifest containing only the pure workflow modules and deterministic
workflow acceptance tests, no extra
fields, and no raw goals, private paths, prompts, IDs, or tool output. Use this
exact deterministic artifact construction with no timestamp:

```js
export const WORKFLOW_CONTRACT_SOURCE_PATHS = Object.freeze([
  "lib/workflow-plan.mjs",
  "lib/workflow-compiler.mjs",
  "lib/workflow-state.mjs",
  "lib/workflow-scheduler.mjs",
  "lib/workflow-orchestrator.mjs",
  "lib/workflow-ledger.mjs",
  "lib/workflow-recovery.mjs",
  "lib/workflow-outcome.mjs",
  "tests/workflow-acceptance.test.mjs",
]);

const PASS_CONTRACT = Object.freeze({
  stageOrderPreserved: true,
  selfContainedHandoff: true,
  firstRealExecutionCanary: true,
  futureCapacityReserved: true,
  resultAdoptionExplicit: true,
  typedIdentityRequired: true,
  permissionsRequired: true,
  runtimeEvidenceRequired: true,
  resumableWithoutDuplicateWork: true,
  privacySafeOutcome: true,
});

const evidence = {
  schemaVersion: 1,
  kind: "verified_workflow_contract",
  sourceManifest: await createWorkflowSourceManifest(
    repositoryRoot,
    WORKFLOW_CONTRACT_SOURCE_PATHS,
  ),
  scenarioCount: 5,
  passedScenarioCount: 5,
  scenarios: SCENARIOS.map(({ id }) => ({
    id,
    pass: true,
    contract: { ...PASS_CONTRACT },
  })),
};
```

The CLI script must write only the explicitly supplied repository-relative output path using
an atomic write; it must not default to a global path. `--check` must recompute
the evidence and fail on any content or source-manifest drift without writing.

Generate and check the deterministic artifact:

```bash
rtk npm run workflow:evidence -- --output docs/workflow-contract-evidence.json
rtk npm run workflow:evidence -- --check docs/workflow-contract-evidence.json
```

Run: `rtk node --test tests/workflow-acceptance.test.mjs tests/workflow-contract-evidence.test.mjs tests/acceptance-exam.test.mjs tests/gearbox.test.mjs`

Expected: all comparative and exact ten-question acceptance tests PASS.

Run: `rtk npm test`

Expected: all repository tests PASS.

- [ ] **Step 7: Commit the superiority contract**

```bash
rtk git add package.json docs/workflow-contract-evidence.json lib/gearbox.mjs lib/acceptance-exam.mjs lib/workflow-contract-evidence.mjs scripts/gearbox.mjs scripts/workflow-contract-evidence.mjs tests/workflow-acceptance.test.mjs tests/workflow-contract-evidence.test.mjs tests/acceptance-exam.test.mjs tests/gearbox.test.mjs
rtk git commit -m "test: require verified workflow canary"
```

---

### Task 9: Managed Runtime Inventory and Dry-Run Installation

**Files:**
- Modify: `lib/gearbox.mjs`
- Modify: `tests/gearbox.test.mjs`
- Modify: `tests/dispatch-cli.test.mjs`
- Modify: `tests/gearbox-cli.test.mjs`

**Interfaces:**
- Extends: `DISPATCH_RUNTIME_FILES`
- Extends automatically: `RUNTIME_BINDING_FILES`, apply manifest runtime hashes, active status verification, rollback ownership
- Preserves: marker-delimited global writes and `allowTypedBridge=false`

- [ ] **Step 1: Write a failing exact runtime-inventory test**

Require every runtime import used by the installed CLI:

```js
const WORKFLOW_RUNTIME_FILES = [
  "lib/workflow-plan.mjs",
  "lib/workflow-compiler.mjs",
  "lib/workflow-state.mjs",
  "lib/workflow-scheduler.mjs",
  "lib/workflow-orchestrator.mjs",
  "lib/private-jsonl.mjs",
  "lib/workflow-ledger.mjs",
  "lib/workflow-recovery.mjs",
  "lib/workflow-outcome.mjs",
  "lib/owned-packet.mjs",
  "lib/workflow-cli.mjs",
];

for (const path of WORKFLOW_RUNTIME_FILES) {
  assert.ok(DISPATCH_RUNTIME_FILES.includes(path), path);
  assert.ok(RUNTIME_BINDING_FILES.includes(path), path);
}
for (const path of [
  "lib/workflow-contract-evidence.mjs",
  "scripts/workflow-contract-evidence.mjs",
  "docs/workflow-contract-evidence.json",
]) {
  assert.ok(RUNTIME_BINDING_FILES.includes(path), path);
  assert.equal(DISPATCH_RUNTIME_FILES.includes(path), false, path);
}
```

Add an import-closure test that recursively parses relative imports from
`scripts/gearbox-dispatch.mjs` and every listed runtime module and fails when a
reachable repository module is absent from `DISPATCH_RUNTIME_FILES`.

- [ ] **Step 2: Run focused tests and confirm inventory omissions**

Run: `rtk node --test tests/gearbox.test.mjs tests/dispatch-cli.test.mjs tests/gearbox-cli.test.mjs`

Expected: the new runtime-inventory assertions FAIL while existing apply and
CLI tests remain green.

- [ ] **Step 3: Add the workflow modules to the managed runtime**

Append `WORKFLOW_RUNTIME_FILES` to `DISPATCH_RUNTIME_FILES` in dependency order
before `scripts/gearbox-dispatch.mjs`. Add the deterministic evidence module,
generator, and tracked JSON only to `RUNTIME_BINDING_FILES`; they are apply and
release inputs, not installed dispatch runtime. Do not add test helpers, plans,
raw reports, or live generated evidence. Preserve deduplication.

The existing apply code must copy each source to
`$CODEX_HOME/gearbox/runtime/<relative-path>` at mode `0644`, bind its hash into
the activation manifest, include it in active `dispatch:status`, and restore
only Gearbox-owned targets on rollback. Do not add a separate installer or a
new write path.

- [ ] **Step 4: Extend fixture manifests and drift tests**

Update temporary active-manifest fixtures to include every new runtime file.
Prove status returns off after changing one workflow module's contents, mode,
symlink state, source path, target path, or manifest hash. Prove dry-run apply
reports the new files without touching the fixture's real global config and a
simulated post-write failure rolls back every newly owned runtime target.

- [ ] **Step 5: Run focused and full tests**

Run: `rtk node --test tests/gearbox.test.mjs tests/dispatch-cli.test.mjs tests/gearbox-cli.test.mjs`

Expected: all runtime inventory, active status, dry-run, and rollback fixture
tests PASS.

Run: `rtk npm test`

Expected: all repository tests PASS.

- [ ] **Step 6: Commit managed runtime integration**

```bash
rtk git add lib/gearbox.mjs tests/gearbox.test.mjs tests/dispatch-cli.test.mjs tests/gearbox-cli.test.mjs
rtk git commit -m "feat: bind workflow runtime files"
```

---

### Task 10: Bundled Skill, Managed Policy, and Release Contract

**Files:**
- Create: `skills/sol-ultra-gearbox/references/verified-workflows.md`
- Modify: `skills/sol-ultra-gearbox/SKILL.md`
- Modify: `skills/sol-ultra-gearbox/references/quality-first-dispatch.md`
- Modify: `skills/sol-ultra-gearbox/references/subagent-skill-compatibility.md`
- Modify: `skills/sol-ultra-gearbox/agents/openai.yaml`
- Modify: `lib/gearbox.mjs`
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `lib/skill-install.mjs`
- Modify: `lib/release-check.mjs`
- Modify: `lib/release-evidence.mjs`
- Modify: `scripts/release-evidence.mjs`
- Modify: `scripts/gearbox.mjs`
- Modify: `scripts/gearbox-dispatch.mjs`
- Modify: `tests/skill-install.test.mjs`
- Modify: `tests/release-check.test.mjs`
- Modify: `tests/release-evidence.test.mjs`
- Modify: `tests/gearbox.test.mjs`
- Modify: `tests/dispatch-cli.test.mjs`

**Interfaces:**
- Requires installed reference: `references/verified-workflows.md`
- Publishes managed order: validate -> compile -> plan -> schedule -> canary -> evidence -> verify -> adopt -> close
- Requires deterministic artifact: `docs/workflow-contract-evidence.json`
- Adds release summary: `{ deterministicScenarioCount: 5, deterministicPass, q10CanaryVerified }`

- [ ] **Step 1: Write failing installer, policy, and release assertions**

Require all of `WORKFLOW_POLICY`, bundled `SKILL.md`, and the new reference to
contain these enforceable concepts:

```js
const REQUIRED_WORKFLOW_CONCEPTS = [
  /validated.*DAG/i,
  /schema.*version 2/i,
  /reserved.*verification/i,
  /first real execution.*canary/i,
  /evidence.*verify.*adopt.*close/is,
  /upstream.*source of truth/i,
  /resume.*adopted/i,
  /root_inline.*typed_child.*isolated_role_root/is,
  /app_thread_root.*not enabled/i,
  /not.*Codex core hook/i,
];
```

Require the skill installer and release file list to reject a source missing
`references/verified-workflows.md`; the release list must also require
`docs/workflow-contract-evidence.json`. Require release evidence validation to
reject a missing, stale-source, false, extra-field, or non-five deterministic
summary and a false Q10 canary verdict.

- [ ] **Step 2: Run focused tests and confirm the reference is missing**

Run: `rtk node --test tests/skill-install.test.mjs tests/release-check.test.mjs tests/release-evidence.test.mjs tests/gearbox.test.mjs`

Expected: failures name the missing verified-workflow reference and absent
workflow contract.

- [ ] **Step 3: Write the installed verified-workflow operator contract**

`references/verified-workflows.md` must contain these sections with exact
operational rules:

1. **When to use** — multi-stage, dependency-bearing work only; direct bounded
   work remains packet v1.
2. **Plan contract** — exact workflow/stage fields, safe approval facts, graph
   and artifact validation, packet v2, and `block_and_report`.
3. **Scheduling** — quality before cost, two readers or one writer, verification
   and recovery reserves, no App-thread shape.
4. **Materialization** — first real action only, persisted running/completed
   receipt, no second launch on failure.
5. **Acceptance** — runtime identity, permission, scope, descendant, tokens,
   artifact evidence, mechanical verification, explicit Sol adoption, then
   provider close.
6. **Recovery** — upstream store first, otherwise one private managed ledger;
   exact plan/policy/permission/workspace/artifact binding; adopted work never
   reruns; incomplete executions block.
7. **Failure classes** — exact plan, hard execution, and local output defect
   behavior with one delegated correction maximum.
8. **Evidence** — safe hashes/counts only and no performance claim before ten
   comparable accepted root-inclusive pairs.

- [ ] **Step 4: Update the skill, AGENTS policy, and public README consistently**

In `SKILL.md`, require reading `verified-workflows.md` before a supported
multi-stage dispatch. In `quality-first-dispatch.md`, replace the one-stage
close-before-validation wording with the approved workflow order while keeping
direct packet-v1 behavior. In `subagent-skill-compatibility.md`, keep the
upstream workflow's plan/progress ledger as source of truth and use the managed
ledger only when no compatible source exists.

Update both `WORKFLOW_POLICY` and the marker-delimited block in repository
`AGENTS.md` with the same bounded workflow rules. Update README and
`openai.yaml` to describe verified workflow orchestration without claiming a
core hook, App-thread provider, cost savings, speed, or superior output quality.

- [ ] **Step 5: Update installer, release inventory, and redacted evidence schema**

Add `references/verified-workflows.md` to both `REQUIRED_FILES` and
`REQUIRED_RELEASE_FILES`. Extend release evidence with exactly:

```js
workflowContract: {
  deterministicScenarioCount: 5,
  deterministicPass: true,
  q10CanaryVerified: true,
}
```

Require `scripts/release-evidence.mjs generate` to accept
`--workflow-contract docs/workflow-contract-evidence.json`. Derive
`q10CanaryVerified` from the validated Q10 public question and
`deterministicPass` from a current source-manifest-bound deterministic artifact.
Do not copy scenario internals, topology, prompts, plan content, paths, tool
calls, or runtime IDs. Existing generated `docs/release-evidence.json` and
`docs/RELEASE_EVIDENCE.md` remain unchanged until current owner-approved live
reports exist.

Also add `--latest-current`: it scans only ignored regular non-symlink files
beneath `reports/`, uses the existing binding validators to select the newest
current smoke, SDD, acceptance, and applied-manifest set, and fails closed when
any current input is absent or ambiguous. It must print the selected safe
report kinds and hashes, not private paths or manifest contents.

Before active apply, validate the deterministic artifact against its current
source manifest. Persist only `workflowContractEvidenceSha256` in the ignored
activation manifest. Active `dispatch:status` must require the field to be a
current lowercase SHA-256 and must fail off on missing, stale, malformed, or
mismatched evidence; it must not print the artifact path or contents.

- [ ] **Step 6: Run focused and full tests**

Run: `rtk node --test tests/skill-install.test.mjs tests/release-check.test.mjs tests/release-evidence.test.mjs tests/gearbox.test.mjs tests/dispatch-cli.test.mjs`

Expected: all installer, managed policy, documentation, and redacted release
schema tests PASS.

Run: `rtk npm test`

Expected: all repository tests PASS.

- [ ] **Step 7: Commit source documentation before generated evidence**

```bash
rtk git add AGENTS.md README.md lib/gearbox.mjs lib/skill-install.mjs lib/release-check.mjs lib/release-evidence.mjs scripts/gearbox.mjs scripts/gearbox-dispatch.mjs scripts/release-evidence.mjs skills/sol-ultra-gearbox tests/skill-install.test.mjs tests/release-check.test.mjs tests/release-evidence.test.mjs tests/gearbox.test.mjs tests/dispatch-cli.test.mjs
rtk git commit -m "docs: publish verified workflow contract"
```

Do not stage generated release evidence in this commit.

---

### Task 11: Deterministic Evidence, Static Verification, and Implementation Review

**Files:**
- Verify without changing: `docs/workflow-contract-evidence.json`
- Modify only files required by concrete failures found in this task.

**Interfaces:**
- Produces a committed, deterministic implementation candidate.
- Leaves paid runtime evidence, active global apply, and generated release evidence behind explicit owner gates.

- [ ] **Step 1: Run the complete deterministic suite**

Run: `rtk npm test`

Expected: every test PASS, including graph, packet v2, lifecycle, scheduler,
canary, ledger concurrency, resume drift, outcome privacy, CLI, five comparative
scenarios, and the exact ten-question acceptance contract.

- [ ] **Step 2: Recompute and validate deterministic workflow evidence**

Check the committed artifact without writing:

```bash
rtk npm run workflow:evidence -- --check docs/workflow-contract-evidence.json
```

Run its focused validator:

```bash
rtk node --test tests/workflow-contract-evidence.test.mjs
```

Expected: schema PASS, exactly 5/5 scenarios, current workflow source-manifest
hashes, and no raw plan, prompt, path, ID, or tool output.

Expected: no file changes. If validation fails, fix the source or generator in
a focused regression-test commit, regenerate the artifact atomically, rerun
`--check`, and include the artifact only in that confirmed repair commit.

- [ ] **Step 3: Run current doctor and managed dry run without global writes**

Run: `rtk npm run doctor -- --json`

Expected: `pass: true` for role files, model catalog, config patchability,
strict config, feature visibility, and Codex doctor. This is static/current-root
evidence only; it does not prove the new active runtime is installed.

Run:

```bash
rtk node scripts/gearbox.mjs apply --promote-v2 --dispatch-mode active --dry-run
```

Expected: PASS with the new workflow runtime files listed in the plan and no
change to global config, AGENTS, roles, policy, runtime, wrapper, or skill.

- [ ] **Step 4: Run diff, secret, and source-only release hygiene**

Run: `rtk git diff --check`

Expected: no output and exit zero.

Run: `rtk gitleaks dir . --redact`

Expected: no verified leaks.

Run:

```bash
rtk python3 "$HOME/.codex/skills/.system/skill-creator/scripts/quick_validate.py" skills/sol-ultra-gearbox
```

Expected: PASS.

Run: `rtk npm run release:check`

Expected before new paid evidence: FAIL only because
`docs/release-evidence.json` and `docs/RELEASE_EVIDENCE.md` remain bound to the
previous runtime source manifest. Any missing file, privacy issue, skill issue,
workflow-contract issue, or failure other than stale generated live evidence is
a real defect and must be fixed now. Do not weaken the release validator to
make stale live evidence pass.

- [ ] **Step 5: Perform the requirements and security-boundary review**

Review the approved spec, this plan, the complete diff, and test evidence.
Reject any of these:

- packet-v1 hash or routing behavior changed;
- packet-v2 can omit stage/dependency/artifact/interface context;
- work consumes verification or recovery reserve;
- second execution starts before a real canary receipt;
- verified is treated as adopted;
- rejected work unlocks a dependent;
- adopted work reruns during resume;
- upstream state is ignored in favor of a second managed ledger;
- raw plan, path, execution identity, session identity, or tool output persists;
- a hard failure retries, changes backend/model/role/permission, or silently
  broadens scope;
- more than two children, more than one writer, a descendant, generic role,
  model override, or enabled typed bridge appears;
- Node code claims to intercept native `spawn_agent`;
- App-thread execution or a public performance claim appears;
- a global write occurs outside the existing managed commands.

- [ ] **Step 6: Fix only confirmed findings and rerun affected checks**

Use at most three repair rounds. Begin each repair with a regression test, run
the narrow failed check, then run `npm test`. Commit each confirmed repair with
explicit paths; never use `git add -A`.

- [ ] **Step 7: Confirm the implementation candidate state**

Run: `rtk git status --short --branch`

Expected in the original shared workspace: implementation paths are committed;
only the pre-existing owner-owned `.superpowers/`, `media/`, and `outputs/`
paths may remain untracked. In an isolated implementation worktree, expect a
clean status. Any other path stops the handoff until its owner and purpose are
known.

Record the exact candidate commit and the expected stale-live-evidence release
gate. Do not call the branch release-ready or active-ready yet.

---

### Task 12: Owner-Gated Live Verification, Active Apply, and Release Evidence

**Owner gate:** Stop before this task. It requires a new explicit approval for
paid model-backed smoke/acceptance and global Gearbox writes. Public GitHub
publication remains a separate approval and is not part of this task.

**Files:**
- Global managed targets written only by existing approved installers/apply.
- Local ignored reports beneath `reports/`.
- Regenerate and commit: `docs/release-evidence.json`
- Regenerate and commit: `docs/RELEASE_EVIDENCE.md`

**Interfaces:**
- Produces: current role smoke, strengthened ten-question acceptance with Q10 canary, active manifest, fresh-root readback, rollback command, and redacted public evidence.

- [ ] **Step 1: Establish a clean, current activation candidate**

Use the execution-time `superpowers:using-git-worktrees` flow when the shared
workspace still contains owner-owned untracked paths. Do not delete, move,
ignore, or stage those paths merely to satisfy the clean-tree gate.

Run: `rtk git status --short`

Expected in the activation worktree: no output.

Run: `rtk git rev-parse HEAD`

Record the exact candidate commit. Any source change after this point invalidates
reused smoke, acceptance, workflow evidence, and release evidence.

- [ ] **Step 2: Preview and install the managed skill while routing remains safe**

Run: `rtk npm run skill:status`

Expected: managed current target or a safe install/update plan. Unmanaged or
locally modified targets stop activation.

Run only under the explicit owner approval for this task:

```bash
rtk npm run skill:install -- --apply
```

Expected: installed, updated, or already current. A missing or invalid dispatch
policy still resolves off.

- [ ] **Step 3: Run the paid SDD adapter verification**

Run under the same explicit paid-verification approval:

```bash
rtk npm run smoke:sdd
```

Expected: `GEARBOX_SDD_PASS` with a current ignored `sdd.json` report. This is a
separate paid probe and is not implied by role smoke, writing-skills pressure
tests, or the active apply. Stop on failure and do not retry automatically.

- [ ] **Step 4: Run the owner-witnessed paid active apply**

Run:

```bash
rtk node scripts/gearbox.mjs apply --promote-v2 --dispatch-mode active
```

Expected sequence includes doctor PASS, all role smoke checks, all existing
writing-skills pressure checks, and the exact ten-question acceptance exam.
Q10 must additionally prove the persisted order
`spawn luna -> list agents -> spawn terra`, both exact role runtimes, no writer,
no descendants, unchanged fixture, cleanup, and public
`workflowCanary: true`.

Stop on the first failure and do not retry a paid run automatically. A
post-write failure must invoke existing manifest-bound automatic rollback and
restore the prior Gearbox-owned blocks and runtime targets to their recorded
hashes.

- [ ] **Step 5: Verify active state and a fresh root**

Run: `rtk npm run dispatch:status`

Expected: `active`, integrity PASS, `allowTypedBridge=false`, current policy,
config, AGENTS, role, launcher, wrapper, and every workflow runtime hash; no
activation-record or manifest path in public output.

Open a fresh CLI root and require persisted `gpt-5.6-sol` at Max or Ultra effort.
This proves the active CLI quality floor, not the task-local Desktop mode. Do
not use the pre-install task as fresh-root evidence.

- [ ] **Step 6: Verify rollback readiness without rolling back success**

Inspect the emitted ignored manifest and confirm it binds config, AGENTS, roles,
policy, launcher, wrapper, all workflow runtime files, smoke, acceptance,
workflow evidence, persistent activation-record path/hash, current commit, and
pre-install hashes. Preserve the exact
manual rollback command by inserting the literal manifest path printed by
Step 4 into `rtk node scripts/gearbox.mjs rollback --manifest` and recording the
resulting full command in the handoff.

Do not execute rollback after a successful apply. Do not use `--force` unless
the owner separately accepts overwriting post-install drift.

- [ ] **Step 7: Generate redacted current release evidence**

Run:

```bash
rtk npm run release:evidence -- \
  --latest-current \
  --workflow-contract docs/workflow-contract-evidence.json \
  --usage reports/<history-run>/real-work-usage.json
```

`--usage` accepts the observed child-runtime report whose basename is exactly
`real-work-usage.json`. Do not pass `reports/cost-evidence.json`; that file is
the separate comparable-pair ledger used only by `--cost-ledger`.

Expected: public JSON and Markdown contain aggregate runtime facts, 5/5
deterministic workflow scenarios, Q10 canary true, and no raw reports, prompts,
paths, IDs, or estimator.

- [ ] **Step 8: Run final publication checks**

Run: `rtk npm test`

Expected: all tests PASS.

Run: `rtk npm run release:check`

Expected: `RELEASE_PASS` with current source and live evidence bindings.

Run: `rtk gitleaks dir . --redact`

Expected: no verified leaks.

- [ ] **Step 9: Commit only generated redacted evidence**

```bash
rtk git add docs/release-evidence.json docs/RELEASE_EVIDENCE.md
rtk git commit -m "docs: publish verified workflow evidence"
```

Do not stage `reports/`, manifests, raw usage records, authentication state, or
owner-owned workspace artifacts.

- [ ] **Step 10: Record the final verified handoff**

Report the operation and result; Sol root runtime; each live role's actual
model, effort, sandbox, fork, read/write scope, tokens, retry, and escalation;
ten acceptance outcomes; Q10 canary verdict; five deterministic workflow
outcomes; active policy hash; ignored manifest path; fresh-root result; global
state change; and rollback command. Label any missing runtime metadata
`unverified`. Do not infer or publish a savings, speed, or output-quality
percentage.

---

### Task 13: Durability & Runbook Closure

**Scope gate:** This task may change repository code, tests, and documentation
only. It must not run paid live probes, mutate `~/.codex`, replace the current
active policy, or regenerate live release evidence. Persistent-root
re-activation requires a new explicit owner approval after all checks below
finish.

**Files:**
- Activation policy, installer/rollback, dispatch status, and release evidence.
- Task 12 runbook and its deterministic contract test.
- Isolated-runner cleanup regression tests.

- [x] **Step 1: Lock the observed gaps with deterministic RED tests**

Require a persistent activation-record policy shape with legacy read
compatibility, an exact Task 12 SDD/usage command contract, and a concurrent
foreign runner fixture that reproduces the old global tmp scan failure.

- [x] **Step 2: Persist active installed-state evidence outside reports**

Write the managed record only to
`$CODEX_HOME/gearbox/activations/<installId>.json` with directory mode `0700`
and file mode `0600`. Keep the ignored `reports/.../install-manifest.json` as
the rollback and release-evidence artifact. The record must contain installed
target paths, modes, hashes, static checks, active root evidence, and evidence
bindings only; it must not contain repository roots, source paths, backups, raw
rollout data, or the local manifest path.

- [x] **Step 3: Make status and rollback durable and fail closed**

Current policy uses `recordPath`; status validates the exact private record and
installed targets without reading repository sources or reports. Legacy
`manifestPath` policy remains read-only compatible until re-activation.
Rollback verifies and removes only the exact hash-bound new record, while
preserving any earlier record needed by the restored policy.

- [x] **Step 4: Close the paid runbook contract**

Task 12 must run `rtk npm run smoke:sdd` before active apply and must pass a
`reports/<history-run>/real-work-usage.json` file to `--usage`. The deterministic
test derives that basename from the release CLI contract and rejects the cost
ledger as usage input.

- [x] **Step 5: Remove the tmp cleanup global-scan race**

Tests must assert cleanup only for the exact temporary paths returned to that
runner. A concurrent Gearbox-owned directory from another valid run must remain
untouched and must not fail the test.

- [x] **Step 6: Verify locally, commit, and stop before global state**

Run targeted tests, `npm test`, doctor/dry-run checks, release checks, and a
redacted secret scan as available. Expected before re-activation: deterministic
tests pass, while checked-in live release evidence may be stale because source
and the required durable activation record changed. Commit only Task 13 source,
tests, and docs, then request a separate persistent-root re-activation approval.
