# Verified Workflow Orchestrator for Sol Ultra Gearbox

- **Date:** 2026-07-15
- **Status:** Architecture approved; written spec ready for owner review
- **Target base:** `origin/main` at `64d43d0`
- **Scope:** Workflow planning, dispatch lifecycle, recovery, outcome evidence,
  bundled skill policy, and deterministic verification

## 1. Context

Gearbox already provides typed Sol, Terra, and Luna roles, permission-aware
dispatch, runtime identity validation, fail-closed policy activation, and
manifest-bound rollback. It is stronger than prompt-only routing for bounded
engineering work, but its current planner makes one dispatch decision at a
time. Multi-stage workflow structure, dependency readiness, reserved future
attempts, and resumable adoption state remain mostly implicit in workflow-skill
instructions.

The reviewed `codex-model-routing-team` skill handles these operational concerns
well at the instruction layer. It creates independent Codex App threads,
preserves upstream workflow stages, verifies that the first thread materializes
before fan-out, reserves capacity for later verification and recovery, records
thread routes at creation time, and archives only adopted results. Its execution
surface is flexible and persistent, but its role identity, permissions, scope,
and post-execution evidence are less mechanically enforced than Gearbox.

Matching those instructions is not a sufficient reason to maintain Gearbox.
The next design must dominate that useful workflow behavior while preserving
Gearbox's verified execution, permission, and rollback boundaries. The product
should become a verified workflow orchestrator, not merely a safer model router.

## 2. Product Claim

Gearbox will compile a bounded workflow graph into verified stage executions.
It will schedule only dependency-ready stages, preserve future verification and
recovery capacity, validate every materialized execution, accept only root-
verified artifacts, resume without duplicating adopted work, and retain
privacy-safe evidence for later routing improvement.

The initial implementation uses only currently verified active execution
shapes:

- `root_inline`
- `typed_child`
- `isolated_role_root`

`typed_child_bridge` remains part of the known shape vocabulary but is disabled
by policy and therefore is not schedulable.

An App-thread provider may be executed later as `app_thread_root` only after the
current runtime exposes the required tools and persisted evidence can prove its
model, reasoning effort, project binding, lifecycle, and cleanup. It is not part
of the initial release and must not appear as an available route before those
gates pass.

## 3. Goals

1. Represent multi-stage work as a validated directed acyclic graph instead of
   relying on narrative ordering alone.
2. Preserve an upstream workflow's goals, stage order, artifacts, quality
   gates, and owner approvals.
3. Prevent initial fan-out from consuming capacity reserved for verification,
   review, or one permitted recovery attempt.
4. Verify the first real execution has materialized before opening the rest of
   its batch.
5. Require runtime evidence, artifact verification, and a root adoption
   decision before a stage becomes complete.
6. Resume from the last adopted stage without re-running accepted work or
   creating a second source of truth.
7. Keep existing typed-role, permission, lineage, no-descendant, one-writer,
   privacy, apply, and rollback invariants.
8. Measure accepted-first-attempt, rejected work, root rework, retries, tokens,
   and escalation without publishing unsupported savings claims.
9. Demonstrate superiority through contract coverage and fault injection, not
   feature-count prose.

## 4. Non-goals

- Replacing Sol as the root planner, risk owner, integrator, or final verifier.
- Increasing the current two-direct-child or one-writer limits.
- Copying the external skill's six-concurrent or eight-cumulative thread caps.
- Treating a successfully created process, child, or thread as a successful
  result.
- Adding App-thread execution before the required tool and evidence surfaces
  exist.
- Allowing a workflow graph to expand its own scope or spawn descendants.
- Automatically selecting Max or Ultra child profiles.
- Persisting raw prompts, private paths, source content, rollout messages,
  credentials, or complete user configuration.
- Publishing a cost or quality percentage before comparable real-work evidence
  satisfies the existing minimum sample rules.

## 5. Competitive Success Criteria

The initial release is accepted only when it covers every useful workflow
contract observed in the external thread skill and adds enforceable guarantees
that the thread skill does not provide.

| Capability | Required Gearbox behavior |
|---|---|
| Stage preservation | Store and validate stage identifiers, dependencies, inputs, outputs, and gates. |
| Self-contained handoff | Render a stage-aware packet that requires no parent-history inheritance. |
| Bounded fan-out | Keep at most two direct children, one writer, and disjoint concurrent scopes. |
| Materialization canary | Do not start the second member of a batch until the first returns a real execution identity and readable status. |
| Reserved capacity | Prevent work stages from consuming verification and recovery reserves. |
| Result adoption | Require runtime evidence, artifact checks, and root verification before adoption. |
| Durable recovery | Resume from hash-bound adopted state and reject stale or mismatched state. |
| Upstream ownership | Reuse an upstream ledger when it can hold required fields; do not create a competing ledger. |
| Typed identity | Verify actual role, model, effort, sandbox, lineage, and no descendants. |
| Permission enforcement | Reject parent, role, writer, or filesystem-scope mismatches. |
| Failure recovery | Stop on hard failures and retain manifest-bound rollback behavior. |
| Outcome evidence | Record privacy-safe route and result facts suitable for later policy evaluation. |

No public comparison may say Gearbox is faster, cheaper, or higher quality
until controlled real-work evidence supports that statement. It may accurately
say that the contracts above are mechanically enforced and covered by tests.

## 6. Fixed Safety Invariants

1. Quality remains a hard gate before cost or parallelism.
2. Sol owns risk classification, approvals, final integration, and final
   verification.
3. Workflow skills retain business semantics; Gearbox owns execution shape,
   role, permissions, concurrency, attempts, evidence, and lifecycle state.
4. Native children use `agent_type`, `fork_turns="none"`, and no model, effort,
   or service-tier override.
5. Unknown workflow adapters disable managed delegation and return control to
   Sol. Generic roles, missing capabilities, permission mismatch, ambiguous
   scope, hidden coupling, or weak verification remain root-inline.
6. At most two direct children may be active. Depth remains one. Descendant
   activity rejects the result.
7. At most one writer may be active, with an exclusive declared scope.
8. A hard identity, permission, scope, cleanup, policy, or state-integrity
   failure receives no retry and stops further delegation for the workflow.
9. One delegated correction is allowed only for a concrete local output defect
   and only when the recovery reserve remains available.
10. Global writes remain restricted to the existing managed apply, rollback,
    skill-install, and skill-uninstall commands.

## 7. Architecture

The verified workflow orchestrator adds six components above the existing
dispatch planner and runners:

1. **Workflow plan validator** — validates graph structure, stage contracts,
   logical artifacts, scopes, gates, permissions, and attempt budgets.
2. **Workflow compiler** — converts each dependency-ready stage into a
   stage-aware task packet accepted by the current quality-first planner.
3. **Scheduler** — chooses a legal ready batch while preserving concurrency,
   writer, dependency, and reserved-capacity invariants.
4. **Lifecycle controller** — records materialization, execution, evidence,
   verification, adoption, rejection, blocking, and semantic closure.
5. **Recovery store adapter** — writes workflow state either into an existing
   compatible upstream ledger or one private Gearbox-owned ignored ledger.
6. **Outcome evaluator** — aggregates privacy-safe workflow outcomes without
   modifying policy until the evidence threshold and owner gate are satisfied.

The end-to-end flow is:

```text
approved workflow intent
  -> validate workflow graph and attempt budget
  -> compile dependency-ready stages into task packets
  -> quality-first dispatch plan per stage
  -> select legal batch and preserve reserved attempts
  -> materialize first real execution
  -> verify identity/status, then materialize remaining batch member
  -> execute and collect persisted runtime evidence
  -> verify artifact, scope, descendants, tokens, and cleanup
  -> Sol adopts, rejects, or blocks the stage
  -> persist hash-bound state and privacy-safe outcome
  -> unlock dependent stages or stop on a hard failure
```

The graph validator, compiler, scheduler, and state reducer must remain pure and
deterministic. Process launching, agent-tool calls, filesystem inspection,
runtime parsing, and persistence stay in adapters so unit tests can cover the
core without model calls or global writes.

## 8. Workflow Plan Contract

A workflow plan uses an exact versioned schema. The initial schema contains:

```text
schemaVersion
workflowId
goal
workflowAdapter
inputArtifacts[]
attemptBudget
stages[]
```

`workflowId` is a privacy-safe identifier, not a user prompt or filesystem
path. The canonical plan hash covers the complete normalized plan, excluding
mutable runtime state.

`attemptBudget` contains:

```text
total
reservedForVerification
reservedForRecovery
```

The plan is invalid when reserves are negative, exceed the total, or cannot
cover every declared mandatory verification stage. The managed policy may set
an upper bound, but the first release must not invent an unsupported universal
cap merely to imitate another skill.

An attempt is one non-root managed execution entering `materializing`. It is
consumed even when readiness later fails. Plan validation and dispatch planning
consume no attempt, and a second batch member that was never launched consumes
no attempt. `root_inline` work consumes no delegated attempt but still records
workflow state, evidence, verification, and adoption; it cannot bypass a
mandatory stage or quality gate.

Each stage contains:

```text
id
responsibility
dependsOn[]
attemptClass: work | verification | recovery
inputArtifacts[]
outputArtifacts[]
approvalGate
readScope[]
writeScope[]
interfaces[]
knownFacts[]
constraints[]
deliverable
successCriteria[]
checks[]
prohibitedActions[]
parentPermission
requiredPermission
requestedRole
riskSignals
costSignals
```

Stage identifiers and logical artifact identifiers must be safe, bounded, and
unique. A stage may consume only declared artifacts produced by its transitive
dependencies or supplied as plan inputs. Absolute private paths may be used by
the live execution adapter when necessary but must not enter public workflow
state or outcome evidence.

The validator rejects:

- cycles, self-dependencies, duplicate stages, and unknown dependencies;
- missing artifact producers or multiple producers for one logical artifact;
- verification stages that can run before the work they verify;
- malformed approval gates or references to unknown approval authorities;
- concurrent writers with overlapping or ambiguous scopes;
- stages that require descendants, unsupported concurrency, or an unknown
  workflow adapter;
- budgets that cannot preserve mandatory verification and recovery reserves.

## 9. Task Packet Compatibility

Existing schema-version-1 task packets remain valid for direct single-stage
dispatch. They gain no workflow, recovery, or reserved-capacity claim.

Compiled workflow stages use task packet schema version 2 with one additional
exact object, `workflowContext`:

```text
workflowId
planHash
stageId
dependsOn[]
inputArtifacts[]
outputArtifacts[]
interfaces[]
attemptClass
missingInformationPolicy: block_and_report
```

The compiler maps the remaining stage fields to the existing packet fields. A
schema-version-2 packet is invalid when the workflow context is incomplete or
does not match the validated plan. The rendered child message must include the
stage position, available inputs, expected outputs, interfaces, predecessor
gates, and the instruction to block and report missing information instead of
guessing.

Raw packets remain ephemeral. Reports store only their canonical hash and
privacy-safe identifiers.

## 10. Scheduling and Reserved Capacity

The scheduler receives a validated plan and immutable workflow state. It
returns either one legal batch or a fail-closed reason.

Scheduling order:

1. Select stages whose dependencies are adopted and whose approval gate is
   satisfied.
2. Remove stages already materializing, running, evidence-ready, verified,
   adopted, rejected, blocked, or closed.
3. Enforce attempt-class reserves before consuming a work attempt.
4. Enforce the current two-direct-child, one-writer, disjoint-scope limits.
5. Keep read-only fan-out separate from a writer round.
6. Return root-inline when no legal batch exists but root work can progress.
7. Return blocked when a mandatory dependency, approval, capability, or budget
   cannot be satisfied.

A work stage may consume only the unreserved portion of the total budget. A
verification stage consumes the verification reserve. A correction consumes
the recovery reserve. Unused reserves are not automatically reassigned to more
work; Sol may release them only after all mandatory downstream stages are
adopted or explicitly cancelled by the owner.

## 11. Materialization Gate

For a batch of two real executions, the first actual stage acts as the canary.
It is not a synthetic probe and does not add a model call solely for health
checking.

Before launching the second stage, require execution-shape-specific readiness:

- `typed_child`: a real agent identifier, canonical task identity, and readable
  running or completed status;
- `isolated_role_root`: a successfully started managed process plus the
  existing readiness and runtime-envelope checks;
- future `app_thread_root`: a real thread identifier, readable thread state,
  verified project binding, and supported persisted model/effort evidence.

Materialization failure prevents the second launch, preserves unused attempts,
records the failure, and returns control to Sol. It does not automatically try
a different backend, project, role, or model.

This gate proves readiness only. Runtime identity, scope, outputs, tokens,
descendants, and cleanup remain result-acceptance requirements.

## 12. Lifecycle and Adoption

Every stage has one state from this exact set:

```text
planned
ready
materializing
running
evidence_ready
verified
adopted
rejected
blocked
closed
```

Allowed normal transitions are:

```text
planned -> ready -> materializing -> running -> evidence_ready
evidence_ready -> verified -> adopted -> closed
evidence_ready -> rejected
rejected -> ready only after Sol records an authorized correction disposition
rejected -> closed when Sol records the rejection as final
planned | ready | materializing | running -> blocked
blocked -> ready only after an explicit resolved fact is recorded
```

`verified` means the execution and artifact evidence passed mechanical checks.
It does not mean Sol accepted the result. `adopted` requires an explicit root
decision that the deliverable satisfies the workflow's success criteria and is
safe to unlock dependents.

Each execution attempt is immutable. A correction increments the stage attempt
number and preserves the rejected attempt and its evidence rather than
overwriting it. A delegated correction additionally requires the recovery
reserve and remains limited to one; an inline Sol remediation does not consume
that delegated reserve. Provider-resource cleanup for an attempt is distinct
from the stage's semantic `closed` state.

Semantic closure occurs only after adoption or a rejection that Sol explicitly
marks final. A result must never be marked adopted merely because the agent,
process, or thread is idle or completed. A rejected result cannot unlock
dependencies.

Invalid transitions fail closed and do not rewrite prior state.

## 13. Recovery and Source of Truth

Before creating workflow state, inspect whether the upstream workflow already
has a plan or ledger that can store:

```text
workflowId
planHash
stageId
state
attempt
executionShape
role
taskHash
resultHash
disposition
adopted
updatedAt
```

If it can, append transition and attempt records through its defined adapter
and do not create a second workflow-state file. If it cannot, use one
Gearbox-owned private ledger under ignored `reports/`, with an owned `0700`
directory and `0600` regular file, following the existing dispatch-ledger
durability pattern. Rejected attempts are immutable records and may not be
replaced by a correction attempt.

Resume requires:

- exact plan hash;
- compatible workflow schema and policy mode;
- no incomplete or malformed ledger record;
- adopted-stage result hashes still matching expected local artifacts when
  those artifacts are part of the contract;
- current workspace and runtime facts that do not invalidate remaining stages.

Hash mismatch, missing adopted artifacts, permission drift, policy drift, or
ambiguous workspace drift blocks resume and returns adjudication to Sol. Resume
must never silently rerun an adopted stage or overwrite upstream state.

## 14. Execution Providers

The orchestrator calls providers through a narrow interface:

```text
capabilities()
materialize(stagePacket)
readiness(executionId)
collectEvidence(executionId)
close(executionId, disposition)
```

Providers do not choose roles, stages, budgets, retries, or success. The
planner and lifecycle controller own those decisions.

The initial provider set wraps current verified Gearbox paths. A future App-
thread provider is accepted only when all of these are true:

1. The task exposes the required App project, create, read, follow-up, and
   archive tools.
2. The provider can prove requested and actual model and reasoning effort from
   trusted evidence, not only the creation request.
3. Project-bound writes can be scoped and verified without colliding with
   another writer.
4. Materialization, completed/idle state, adoption, archival, and cleanup are
   deterministically testable.
5. A current paid smoke and owner-approved acceptance scenario pass.
6. Missing capability or evidence maps to `root_inline`; it never falls back to
   an unverified App thread.

## 15. Privacy-Safe Outcome Evidence

Extend outcome records with privacy-safe workflow facts:

```text
workflowHash
stageIdHash
attemptClass
attemptNumber
materialized
verified
adopted
closed
rootReworkRequired
reservedAttemptsBefore
reservedAttemptsAfter
retryCount
escalatedToRoot
actualModel
actualEffort
tokens
reasonCode
```

Do not persist raw workflow goals, prompts, artifact contents, private paths,
session identifiers, thread identifiers, or tool output.

Policy remains deterministic and unchanged by individual runs. After at least
ten comparable accepted root-inclusive pairs, a separate owner-reviewed
analysis may propose threshold changes. It must report raw counts, rejected
runs, and uncertainty. It may not silently self-modify policy.

## 16. Error Handling

Classify failures into three groups:

1. **Plan failures** — invalid graph, budget, scope, adapter, or approvals.
   Perform no delegation and return exact validation errors.
2. **Hard execution failures** — identity, model, effort, sandbox, lineage,
   permission, unexpected write, descendant, cleanup, state integrity, or
   policy failure. Reject the result, stop later stages, and invoke existing
   managed rollback only when active global state requires it.
3. **Local output defects** — a concrete, bounded deliverable defect with
   intact identity, scope, policy, and cleanup. Permit one delegated correction
   only when the recovery reserve exists and the correction does not broaden
   scope. Sol may instead remediate inline within the original scope; that is
   not a delegated retry and does not consume the delegated attempt reserve.

Timeout or unavailable capability does not authorize a different backend,
model, role, permission, or project target. Sol may complete the stage inline
or leave the workflow blocked.

## 17. Testing Strategy

### Pure contract tests

- Accept a valid multi-stage graph and produce a stable plan hash.
- Reject cycles, self-dependencies, duplicates, unknown dependencies, missing
  artifacts, multiple producers, and invalid approval gates.
- Reject overlapping concurrent writer scopes and unsupported concurrency.
- Preserve verification and recovery reserves under every work-stage schedule.
- Keep schema-version-1 direct packets compatible.
- Require exact workflow context for schema-version-2 packets.
- Render stage, dependencies, artifacts, interfaces, and missing-information
  behavior into the child message.
- Reject every invalid lifecycle transition.

### Deterministic integration tests

- Materialize one canary and prove the second execution is not started when
  readiness fails.
- Prove the second execution starts after a valid first readiness result.
- Prove verification does not imply adoption.
- Prove only adopted stages unlock dependents.
- Resume without re-running an adopted stage.
- Reject resume after plan-hash, artifact, permission, policy, or workspace
  drift.
- Reuse a compatible upstream ledger and avoid creating a second ledger.
- Create a private Gearbox ledger only when no upstream state adapter exists.
- Preserve every complete record under concurrent appends.

### Fault-injection acceptance

Inject and require rejection of:

- actual model or effort mismatch;
- permission or sandbox mismatch;
- missing lineage or runtime metadata;
- unexpected filesystem writes;
- descendant creation;
- malformed or incomplete recovery state;
- exhausted verification reserve;
- closure before adoption or a rejection explicitly marked final;
- materialization timeout followed by an attempted second launch;
- cleanup failure.

### Comparative contract evaluation

Use the same bounded scenarios to evaluate the external skill contract and the
Gearbox orchestrator contract without leaking expected outcomes into the task:

1. parallel research followed by verifier and reviewer;
2. two read-only module audits followed by one writer;
3. interrupted workflow resumed after one adopted stage;
4. first execution fails to materialize;
5. successful execution returns an invalid or out-of-scope artifact.

Gearbox passes the superiority gate only when it covers the external workflow
behavior and the additional typed identity, permission, graph, recovery,
evidence, and rollback assertions. Live comparative cost or quality claims
remain blocked until owner-approved runtime evaluation is possible.

## 18. Implementation Phases

### Phase 1: Pure workflow contracts

Add workflow-plan validation, graph compilation, packet schema version 2,
scheduling, attempt reserves, lifecycle reduction, and unit tests. Do not add
process launching, global writes, or new execution shapes.

### Phase 2: Current-provider integration

Connect typed-child and isolated-root providers, materialization canary,
evidence collection, adoption, recovery-store adapters, and privacy-safe
workflow outcomes. Add deterministic fake-runtime and fault-injection tests.

### Phase 3: Skill and release integration

Update the bundled skill, managed AGENTS policy, installer inventory, release
checks, acceptance scenarios, README, and redacted evidence schema. Run the
complete deterministic suite, doctor, managed dry run, skill validation, and
secret scanning. Do not run paid smoke or global apply without a later explicit
owner approval.

### Phase 4: Optional App-thread provider

The repository may define and deterministically test the capability contract
before execution exists. Do not mark it deploy-ready until an owner-authorized
App Server host can select model and effort before turn creation and prove the
actual runtime, project write scope, lifecycle close, paid smoke, acceptance
gate, policy flag, and rollback-safe installation. Contract-only fallback to
`root_inline` is partial progress, not automatic root-routing success.

### Phase 5: Real-work evaluation

Collect comparable root-inclusive workflow pairs. Review outcome evidence after
the minimum sample threshold, then propose policy changes or public performance
claims in a separate owner-reviewed change.

## 19. Expected Source Boundaries

The implementation plan may create focused modules such as:

```text
lib/workflow-plan.mjs
lib/workflow-scheduler.mjs
lib/workflow-state.mjs
lib/workflow-ledger.mjs
tests/workflow-plan.test.mjs
tests/workflow-scheduler.test.mjs
tests/workflow-state.test.mjs
tests/workflow-ledger.test.mjs
skills/sol-ultra-gearbox/references/verified-workflows.md
```

It will also make bounded changes to existing planner, dispatch, acceptance,
installer, release-check, skill, AGENTS policy, and README files. It must not
combine unrelated refactoring, launch-media work, dependency upgrades, global
activation, or generated paid evidence into this feature.

## 20. Risks and Trade-offs

- **Complexity:** A workflow engine is larger than a routing-rule update.
  Mitigate with pure modules, exact schemas, narrow providers, and phased
  delivery.
- **Packet overhead:** Stage-aware packets contain more metadata. Mitigate by
  keeping reusable detail in the workflow plan and rendering only the current
  stage context.
- **Canary latency:** The second child starts after one readiness round trip.
  Accept this bounded delay because it prevents a broken environment from
  failing the full batch.
- **Schema migration:** Version-2 packets and workflow state need explicit
  compatibility. Keep version-1 direct dispatch valid and reject unknown
  versions.
- **Stale recovery:** Persisted state may outlive workspace assumptions. Bind
  resume to plan, policy, permissions, and artifact evidence and block on drift.
- **Provider asymmetry:** Typed children, isolated roots, and future App threads
  expose different metadata. Define one minimum evidence contract and disable
  providers that cannot satisfy it.
- **Unproven performance:** Stronger contracts do not prove lower cost or higher
  output quality. Keep claims limited to enforced behavior until comparable
  evidence exists.

## 21. Approval and Release Boundaries

The approved architecture authorizes writing this spec. The implementation
plan starts only after the owner reviews and approves the committed spec. This
approval does not authorize:

- paid model-backed smoke or comparative runs;
- installing or updating the global skill;
- activating a new dispatch policy;
- adding an App-thread execution provider without current capability evidence;
- publishing performance claims, a release, or external messages.

Each of those actions retains its existing explicit owner gate.
