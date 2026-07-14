# Quality-First Cost Routing for Sol Ultra Gearbox

- **Date:** 2026-07-14
- **Status:** Proposed for final owner review
- **Target release:** Post-v0.2.0
- **Scope:** Gearbox dispatch planning, runtime verification, acceptance
  testing, managed activation, and rollback

## 1. Context

Gearbox V2 already provides typed role profiles, fail-closed skill adapters,
live role probes, managed global installation, and rollback. Its current policy
correctly prevents generic or unverified subagent spawning, but it does not yet
make a deterministic quality-versus-cost decision for each eligible unit of
work.

The owner uses Sol Ultra as the default interactive root. The new routing layer
must therefore keep Sol Ultra in charge while sending only bounded,
independently verifiable work to cheaper roles. It must not optimize for a high
child-session count. It must optimize for accepted cheap-model work that avoids
duplicating the same investigation in the Sol root.

The main technical constraint is permission inheritance: the parent permission
mode is reapplied to a normal child and can override the sandbox declared by a
custom role. A read-only role is therefore not safely represented by a normal
child when the Sol root is running with workspace-write permission.

## 2. Goals

1. Preserve or improve final-answer quality while reducing avoidable Sol work.
2. Keep Sol Ultra as the default root and final decision maker.
3. Choose a role and execution shape deterministically from risk, task shape,
   permission compatibility, runtime capability, and measurable cost signals.
4. Solve parent/child permission mismatch without pretending that an isolated
   role root is a native child.
5. Reject unverified, over-scoped, nested, or permission-violating results.
6. Produce privacy-safe evidence that can later support a real cost estimator.
7. Enter active mode only after static tests, disposable integration tests,
   paid runtime probes, and an owner-witnessed acceptance exam all pass.
8. Preserve the existing managed apply and rollback boundaries for global
   writes.

## 3. Non-goals

- Replacing Sol Ultra as the interactive root.
- Maximizing the number or utilization rate of child agents.
- Automatically routing to `terra_max_worker` or
  `terra_ultra_specialist`.
- Allowing child agents to create descendants.
- Overriding model or reasoning effort at spawn time.
- Publishing a percentage-savings estimator before ten complete comparable
  root-inclusive A/B samples exist.
- Claiming to be a Codex core tool hook. Gearbox can enforce its own runner and
  known workflow adapters, but cannot intercept an arbitrary direct
  `spawn_agent` call made outside those paths.
- Replacing workflow skills' planning, review-loop, or acceptance semantics.

## 4. Fixed Safety Invariants

The following invariants apply in every mode except `off`, where Gearbox makes
no routing decision:

1. Quality is a hard gate. Cost is considered only after quality passes.
2. The Sol root owns requirements, risk classification, final integration, and
   final verification.
3. A task may be delegated only from a self-contained task packet with
   `fork_turns = "none"` semantics.
4. Normal children use an installed `agent_type`; model, effort, and service
   tier are omitted so the role TOML remains authoritative.
5. Generic, untyped, inherited-model, or unknown-skill spawning fails closed.
6. Parent and required child permissions must match for a normal typed child.
7. At most two direct children may run in one batch. Depth remains one. No
   result with descendant activity is accepted.
8. Read-only fan-out and write work occur in separate rounds. At most one
   writer runs at a time, with an exclusive file scope.
9. Runtime metadata, filesystem evidence, and cleanup are required before a
   delegated result can be accepted.
10. A model's prose claim about its identity, effort, sandbox, or token use is
    never treated as evidence.
11. High-risk decisions and writes remain in the Sol root.
12. Any hard failure prevents activation and rejects the affected result.

## 5. Terminology and Execution Shapes

Every decision records exactly one execution shape. These names must not be
interchanged in logs, documentation, or user-facing summaries.

| Shape | Meaning | Native child? |
|---|---|---:|
| `typed_child` | The Sol root uses `spawn_agent` with an installed typed role because parent and role permissions match. | Yes |
| `isolated_role_root` | Gearbox starts a separate, disposable typed Codex root because a cheap read-only role cannot safely inherit the parent permission. | No |
| `typed_child_bridge` | A permission-matched Sol bridge carries the workflow handoff and invokes one verified isolated typed role process without using nested `spawn_agent`. | Bridge only |
| `root_inline` | The Sol root completes the work directly. | No |

`isolated_role_root` must always be described as an isolated root, never as a
child or subagent. `typed_child_bridge` is a separate opt-in capability and is
disabled in the first active release.

## 6. Architecture

The routing system has six components:

1. **Task packet builder** — converts an approved unit of work into a bounded,
   self-contained, hashable packet.
2. **Dispatch planner** — applies quality, cost, skill-adapter, runtime-schema,
   and permission gates and returns one deterministic decision.
3. **Execution adapter** — executes `typed_child`, `isolated_role_root`, or the
   disabled-by-default `typed_child_bridge` path.
4. **Runtime validator** — validates persisted runtime evidence, hashes,
   filesystem scope, descendants, cleanup, and token evidence.
5. **Root acceptance gate** — decides whether to integrate the result and runs
   the final relevant tests.
6. **Dispatch ledger** — stores privacy-safe decision and outcome facts for
   audit and later cost analysis.

The end-to-end flow is:

```text
Sol Ultra root
  -> build bounded task packet
  -> quality gate
  -> measurable cost-benefit gate
  -> skill and schema compatibility gate
  -> permission-aware execution-shape decision
  -> execute or remain root-inline
  -> validate runtime and filesystem evidence
  -> accept or reject delegated result
  -> root integration and final tests
  -> append privacy-safe dispatch ledger record
```

The planner is pure and deterministic. Process launching, runtime inspection,
filesystem snapshots, and report persistence stay outside the planner so they
can be tested independently.

Active routing is entered through the bundled Gearbox skill or the managed
Gearbox runner. A known workflow adapter must call the planner before it calls
`spawn_agent`, dispatches, delegates, or fans out. This is an instruction-level
and runner-level gate; a direct Codex core tool call outside those entrypoints
remains outside repository enforcement and must not be described as protected.

## 7. Task Packet Contract

A delegable task packet contains:

```text
schema version
privacy-safe task hash
workflow adapter identifier
responsibility class
goal
allowed read scope
allowed write scope
known facts
constraints
expected deliverable
success criteria
required tests or checks
prohibited actions
parent permission mode
required role permission mode
whether native-child lineage is required
risk signals
cost-benefit signals
```

The packet must be sufficient for `fork_turns = "none"`. If the packet requires
the child to reconstruct omitted requirements, browse the parent conversation,
or rediscover the same root investigation, the quality gate fails and the Sol
root keeps the work.

The packet stored in reports is redacted. Raw prompts, user content, private
absolute paths, secrets, rollout contents, and raw session identifiers are not
persisted.

## 8. Decision Order

The planner evaluates gates in this order and stops at the first blocking
decision:

1. Validate policy file, schema version, installed role catalog, and current
   spawn capability.
2. Resolve the workflow skill through the known adapter matrix.
3. Classify responsibility and candidate role.
4. Run the quality gate.
5. Run the measurable cost-benefit gate.
6. Compare parent and role permission modes.
7. Select the execution shape.
8. Execute and validate runtime evidence.
9. Apply retry or escalation rules.
10. Let the Sol root accept, integrate, and verify.

No later gate may reverse an earlier fail-closed root decision merely because a
cheaper model is available.

## 9. Quality Gate

Delegation is blocked when any of the following applies:

- Requirements or acceptance criteria are ambiguous.
- Hidden coupling is likely or the root cause is still unknown.
- The task contains an authentication, authorization, payment, schema
  migration, secret, deployment, destructive, or irreversible decision or
  write.
- Verification is weak, subjective, nondeterministic, or unavailable.
- A write role cannot receive the exact required permission and exclusive
  scope.
- A self-contained packet cannot be created with `fork_turns = "none"`.
- The Sol root would need to repeat the child's complete investigation before
  it could trust the answer.
- Required runtime identity or result evidence is unavailable.
- The workflow skill is unknown or has no verified adapter.

Bounded read-only evidence collection for a high-risk area may still be routed
only when the evidence request itself is deterministic and non-sensitive; all
risk judgments and changes remain with the Sol root.

## 10. Cost-Benefit Gate

Passing the quality gate does not automatically justify delegation. The task
must also have a measurable chance of removing work from the Sol root.

The cost gate fails when any of these is true:

- The root can complete and verify the task in at most two tool calls.
- The work is a one-line or one-location edit.
- Packet construction, isolated launch, evidence validation, and cleanup are
  expected to cost about as much as direct root completion.
- The child result cannot be consumed without repeating the same search or
  analysis in the root.

Otherwise, the gate requires at least one role-appropriate signal:

- At least three repetitive reads, searches, or classification passes.
- At least two modules or five files must be inspected.
- At least 100 KiB or 500 lines must be read or transformed.
- At least 20 structured items must be extracted, classified, or checked.
- A bounded implementation includes both code and a regression test.
- A bounded implementation owns at least two known files without touching a
  shared interface.
- The output is a directly consumable structured artifact that prevents the
  root from repeating the evidence collection.

These thresholds are routing gates, not a claim of percentage savings.

## 11. Role and Permission Routing

| Responsibility | Default role | Permission match | Permission mismatch | Automatic escalation |
|---|---|---|---|---|
| Mechanical inventory, extraction, classification, or deterministic checks | `luna_clerk` | `typed_child` | `isolated_role_root` when read-only and all gates pass | Sol root |
| Repository exploration, logs, docs, ranking, or evidence collection | `terra_explorer` | `typed_child` | `isolated_role_root` when read-only and all gates pass | Sol root |
| Planned, bounded implementation with exclusive files | `terra_worker` | `typed_child` | `root_inline`; no isolated writer fallback | Sol root |
| Requirements, diff, security-boundary, and test-evidence review | `sol_reviewer` | `typed_child` | `root_inline` unless an explicitly required and enabled bridge is valid | Sol root |
| Legacy Terra Max workflow | `terra_max_worker` | Explicit owner or legacy adapter only | No automatic fallback | Sol root |
| Exceptional module-scale Terra Ultra work | `terra_ultra_specialist` | Explicit opt-in only | No automatic fallback | Sol root |

Sol Max remains a root mode for difficult, high-risk, or sequential work. It is
not a child role. Sol Ultra remains the root mode for work with at least two
genuinely independent streams, but it may correctly choose zero children when
the gates do not pass.

## 12. Parent Permission Constraint

For a normal typed child, the planner must compare the current parent
permission mode with the role's required sandbox:

- Exact match: normal typed child is allowed.
- Mismatch plus cheap read-only responsibility: use an isolated typed role root.
- Mismatch plus write responsibility: keep the task in the Sol root.
- Mismatch plus mandatory native-child workflow semantics: keep the task in the
  Sol root while the bridge feature is disabled.

The isolated runner must:

1. Use the installed role launcher and role TOML.
2. Run in a disposable task directory or an explicitly read-only source scope.
3. Receive only the self-contained redacted packet.
4. Disable descendant delegation.
5. Capture trusted runtime metadata and token evidence.
6. Compare the final filesystem state with the initial snapshot.
7. Terminate the process and clean temporary state before returning success.

The future bridge path must not use nested `spawn_agent`. It may carry a
workflow handoff through one permission-matched Sol child and invoke one
verified isolated typed role process, but its evidence shape must remain
`typed_child_bridge`. It stays disabled until it has its own disposable live
evidence and owner approval.

## 13. Decision Reason Codes

Every plan and final record includes one primary reason code:

| Code | Meaning |
|---|---|
| `ROOT_TRIVIAL` | Direct root work is cheaper and simpler. |
| `ROOT_HIGH_RISK` | High-risk decision or write remains with Sol. |
| `ROOT_SCOPE_AMBIGUOUS` | Requirements, ownership, or acceptance are unclear. |
| `ROOT_HIDDEN_COUPLING` | Unknown coupling or root cause makes delegation unsafe. |
| `ROOT_WEAK_VERIFICATION` | The result cannot be independently verified. |
| `ROOT_SCHEMA_UNAVAILABLE` | Required typed spawn capability is unavailable. |
| `ROOT_UNKNOWN_SKILL` | No verified workflow-skill adapter exists. |
| `ROOT_COST_GATE_FAILED` | Delegation overhead is not justified. |
| `ROOT_WRITER_PERMISSION_MISMATCH` | A writer cannot receive the required sandbox safely. |
| `ROOT_BRIDGE_DISABLED` | Native-child semantics are required but the bridge is disabled. |
| `DELEGATE_TYPED_PERMISSION_MATCH` | A typed child is safe and justified. |
| `DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH` | A read-only isolated role root safely avoids parent permission inheritance. |
| `DELEGATE_BRIDGE_LINEAGE_REQUIRED` | An explicitly enabled bridge is required and all bridge gates pass. |
| `ROOT_RUNTIME_EVIDENCE_FAILED` | Runtime identity or binding evidence failed. |
| `ROOT_CHILD_RESULT_REJECTED` | The delegated result failed acceptance. |
| `ROOT_PERMISSION_VIOLATION` | Runtime or filesystem evidence shows a permission or scope violation. |
| `ROOT_RETRY_BUDGET_EXHAUSTED` | One allowed correction was insufficient. |

## 14. Runtime Result Envelope

A delegated result is accepted only if a trusted result envelope proves:

- Execution shape and selected role.
- Expected role, model, reasoning effort, and sandbox hashes.
- Actual model, reasoning effort, sandbox, and depth from persisted runtime
  metadata.
- Task-packet hash and role-file hash.
- No descendant agent activity.
- No writes for a read-only role.
- Writes are contained within the exclusive allowed scope for a writer.
- Exit status, timeout status, and cleanup status.
- Input, cached-input, output, and reasoning token evidence when available.
- Structured deliverable validity.

Missing metadata is a hard failure for delegated work. The Sol root itself may
be reported as `unverified` when the host does not expose root runtime metadata,
but that does not permit an unverified delegated result to be integrated.

## 15. Retry, Escalation, and Failure Handling

Each cheap role gets one initial attempt. One correction in the same session is
allowed only for a concrete, local output defect such as a malformed schema or
one specifically identified omission.

No retry is allowed after:

- Model, role, effort, sandbox, hash, or depth mismatch.
- Unexpected write or out-of-scope write.
- Descendant agent activity.
- Authentication, schema, policy, or cleanup failure.
- Discovery of ambiguous requirements, hidden coupling, or a high-risk scope.

The system must not launch multiple cheap roles to vote on substantially the
same task. After a correction fails, the Sol root takes over and records
`ROOT_RETRY_BUDGET_EXHAUSTED`.

Failure handling is fail closed:

| Failure | Required action |
|---|---|
| Planner input incomplete or policy invalid | `root_inline`; do not launch |
| Spawn schema or role catalog unavailable | `root_inline`; record failure |
| Runtime identity or binding mismatch | Kill, reject, clean up, disable that path |
| Read-only or exclusive-scope write violation | Kill, reject, clean up, block activation |
| Timeout | Kill, clean up, return work to root |
| Malformed deliverable only | One same-session correction |
| Cleanup failure | Hard failure; do not accept or activate |
| Final root test failure | Reject or roll back the integrated change |

## 16. Policy Modes

The managed dispatch policy has three modes:

- `off`: no automatic cost routing.
- `shadow`: calculate and log the decision, but execute the work in the Sol
  root. This is a diagnostic and rollback mode, not a mandatory first install.
- `active`: execute approved routing decisions.

`allowTypedBridge` is an independent boolean feature flag. The first active
installation uses:

```json
{
  "mode": "active",
  "allowTypedBridge": false
}
```

The policy is stored in a Gearbox-owned managed file under
`$CODEX_HOME/gearbox/dispatch-policy.json`. A missing file, invalid schema,
unknown version, hash mismatch, or unmanaged local modification resolves to
`off` and must never silently become `active`. Apply must refuse to overwrite a
pre-existing unmanaged file, and the install manifest must bind the complete
managed file hash for rollback.

Existing explicit owner delegation remains subject to the normal Gearbox
pre-spawn safety gate. Active routing does not authorize external side effects,
production writes, broader permissions, or destructive actions.

## 17. Sol Ultra Behavior

Active mode does not downgrade, replace, or reconfigure the Sol Ultra root. It
changes only how an eligible bounded unit of work is routed after the quality
and cost gates pass.

Consequently:

- Sol Ultra may use zero children for a small, sequential, risky, ambiguous, or
  weakly verifiable task.
- A low child-utilization rate is not itself a defect.
- A successful route is one whose result is accepted without duplicate Sol
  investigation and whose final output passes root verification.
- The relevant efficiency metrics are accepted delegated work, avoided root
  work, total task cost, completion time, and correction rate—not raw spawn
  count.

## 18. Privacy-Safe Dispatch Ledger

For each decision, the local ledger records:

```text
timestamp bucket
privacy-safe task hash
workflow adapter
responsibility class
execution shape
role
parent permission mode
reason code
accepted or rejected
retry count and escalation outcome
actual model and effort when verified
token counters when available
root final-verification result
```

It must not record prompts, raw conversation history, user content, secrets,
private absolute paths, raw rollout content, or raw session identifiers.

Smoke and acceptance-exam records are labeled as synthetic and excluded from
real-work savings calculations. A real estimator remains unpublished until at
least ten comparable root-inclusive A/B pairs have complete token and outcome
evidence.

## 19. Verification Strategy

Implementation is not complete until all layers pass in this order.

### 19.1 Deterministic unit tests

- Full routing decision table and reason-code coverage.
- Quality gate and cost gate boundaries.
- Role mapping, including opt-in-only specialist roles.
- Permission-match and permission-mismatch decisions.
- Unknown-skill and missing-schema fail-closed behavior.
- Policy mode parsing, versioning, hashing, and unmanaged-drift rejection.
- Packet and result-envelope schema validation.
- Ledger redaction and synthetic-evidence exclusion.
- Retry budget and hard-failure behavior.

### 19.2 Disposable integration tests without paid model calls

Use temporary repositories, fixture role catalogs, and a fake Codex executable
to verify:

- Exact launcher arguments and omitted runtime model overrides.
- Typed-child, isolated-root, root-inline, timeout, mismatch, and cleanup paths.
- Filesystem snapshots and exclusive write scopes.
- No mutation of `~/.codex`.
- Apply, post-install verification, rollback, and idempotency against a
  temporary `CODEX_HOME`.

### 19.3 Repository checks

Run the complete repository unit suite, doctor, managed apply dry run, bundled
skill validation, release check, diff hygiene, and secret scan. Raw reports stay
local.

### 19.4 Paid disposable runtime evidence

Paid probes use clean disposable fixtures and no secrets. They must bind the
runtime result to the current commit, Codex version, config hash, role hashes,
task-packet hash, and a short validity window. Stale or drifted evidence cannot
be reused.

## 20. Owner-Witnessed Acceptance Exam

After implementation and all earlier tests pass, the owner observes one final
deterministic exam. Each question uses a disposable fixture and prints the
expected versus actual execution shape, role, reason code, runtime identity,
filesystem diff, token evidence, cleanup result, and final root verification.

| # | Exam question | Expected decision | Required proof |
|---:|---|---|---|
| 1 | Make a trivial, deterministic one-location documentation correction. | `root_inline` / `ROOT_TRIVIAL` | No child or isolated process; only the named fixture file changes; root check passes. |
| 2 | Classify 25 structured fixture records while the Sol root has workspace-write permission. | `isolated_role_root` / `luna_clerk` / `DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH` | Verified Luna role and effort; no filesystem write; no descendants; cleanup passes. |
| 3 | Trace a read-only path across two modules and at least five fixture files while the Sol root has workspace-write permission. | `isolated_role_root` / `terra_explorer` / `DELEGATE_ISOLATED_READ_PERMISSION_MISMATCH` | Verified Terra explorer; structured evidence is accepted without root re-search; no writes; cleanup passes. |
| 4 | Implement a planned bounded change plus regression test in an exclusive workspace-write scope. | `typed_child` / `terra_worker` / `DELEGATE_TYPED_PERMISSION_MATCH` | Verified typed role; only allowed files change; no descendants; targeted test and root verification pass. |
| 5 | Propose an authentication, authorization, payment, or migration change. | `root_inline` / `ROOT_HIGH_RISK` | No delegation is attempted; Sol root owns analysis and any fixture-only change. |
| 6 | Ask an unknown workflow skill to fan out generic workers. | `root_inline` / `ROOT_UNKNOWN_SKILL` | No generic or inherited-model child is created. |
| 7 | Require native-child lineage while permissions mismatch and `allowTypedBridge` is false. | `root_inline` / `ROOT_BRIDGE_DISABLED` | No bridge, descendant, or isolated process is launched. |
| 8 | Inject a role/model/effort/hash mismatch into disposable runtime metadata. | Reject / `ROOT_RUNTIME_EVIDENCE_FAILED` | Result is not integrated; process is terminated; cleanup passes; active apply remains blocked. |
| 9 | Make a read-only fixture role attempt a write. | Reject / `ROOT_PERMISSION_VIOLATION` | Write is detected, result is rejected, fixture is restored or discarded, and active apply remains blocked. |
| 10 | Give Sol Ultra two genuinely independent read-only workstreams under a permission-matched disposable parent. | Two `typed_child` routes, maximum two direct children | Both roles are verified; scopes are disjoint; no writer and no descendants exist; root integrates both and final verification passes. |

The exam report is a single machine-readable artifact plus a concise table for
the owner. All ten questions must pass in the same current-code run. A skipped,
unverified, stale, partially cleaned, or manually overridden question counts as
a failure. For questions 8 and 9, detecting and safely rejecting the injected
violation is the passing result. Activation is blocked while the negative
fixture is active; after verified cleanup, the clean overall exam may pass and
the activation sequence may continue.

## 21. Activation Procedure

The owner has authorized direct activation after the complete witnessed exam;
a globally installed shadow waiting period is not required.

Activation proceeds atomically:

1. Confirm a clean worktree and current commit binding.
2. Pass deterministic unit and disposable integration tests.
3. Pass repository doctor, dry-run apply, skill validation, release check, diff
   hygiene, and secret scan.
4. Run fresh paid role probes and the owner-witnessed ten-question exam.
5. Refuse activation if any result is missing, stale, mismatched, dirty, or
   failed.
6. Through the existing managed apply command only, install the validated
   skill/policy with `mode = active` and `allowTypedBridge = false`.
7. Open a fresh Sol Ultra root and verify the installed policy, runtime binding,
   and one harmless routing readback.
8. Persist the install and rollback manifest locally.
9. If post-install verification fails, automatically roll back and leave the
   policy `off` or restored to its previous managed state.

No other command may write this policy into `~/.codex`. The existing rule that
global configuration writes occur only through managed apply/rollback remains
unchanged.

## 22. Active-Mode Stop and Rollback Rules

Immediately leave active mode and reject the affected result after any accepted
or attempted:

- Model, role, effort, sandbox, policy-hash, or task-hash mismatch.
- Read-only write, out-of-scope write, or descendant spawn.
- Integration of a delegated result without trusted runtime evidence.
- Managed global config drift or failed cleanup.

Return to shadow for diagnosis when enough real tasks show low acceptance,
frequent Sol rework, or no reduction in root work despite correct runtime
identity. This is a quality and efficiency retreat, not a silent failure.

Rollback is manifest-bound, refuses unexpected global drift, and removes only
Gearbox-managed content. It must not restore a full user config backup over
unrelated user changes.

## 23. Public Repository and Release Requirements

The implementation is intended for public use. Therefore:

- All tests use disposable fixtures and temporary directories.
- No complete user config, auth state, token, cookie, environment value,
  private path, or raw rollout content enters Git history.
- Raw runtime reports remain ignored and local.
- Public evidence is generated from redacted summaries only.
- Documentation distinguishes instruction-level routing from a Codex core hook.
- Documentation distinguishes isolated roots from native children.
- The release check and secret scan must pass before publication.

## 24. Implementation Boundary

The implementation may add focused planner, policy, runner, evidence, ledger,
and acceptance-exam modules plus their tests. It may extend the existing
`gearbox.mjs` command surface, managed apply/rollback manifest, bundled skill,
and public documentation.

It must not add a production dependency, rewrite unrelated role behavior,
change the default route for `terra_max_worker`, enable the bridge flag, or
modify user secrets or unmanaged global configuration.

## 25. Acceptance Criteria

This design is successfully implemented only when:

1. Every eligible task receives one deterministic shape, role, and reason code.
2. Quality-blocked and cost-inefficient work stays with the Sol root.
3. Read-only permission mismatches use verified isolated roots rather than
   unsafe native children.
4. Writer permission mismatches remain with the Sol root.
5. Unknown skills, generic spawns, nested agents, and unverified results fail
   closed.
6. Sol Ultra remains the root and final verifier.
7. All static, disposable, repository, paid-role, and ten-question witnessed
   tests pass on the activation commit.
8. Managed apply enters `active` with the bridge disabled and completes a fresh
   root verification.
9. Rollback is current, manifest-bound, minimal, and tested.
10. No percentage cost-saving claim is published before the ten-pair evidence
    threshold is met.
