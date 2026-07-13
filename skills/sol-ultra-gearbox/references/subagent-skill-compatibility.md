# Subagent skill compatibility

This reference defines how Gearbox adapts workflow skills that intend to
dispatch child agents. Workflow skills remain active on the Sol root. Gearbox
does not replace their planning, review loops, artifact handoffs, or acceptance
criteria.

The compatibility gate runs immediately before an actual `spawn_agent` call or
equivalent dispatch intent. Merely mentioning subagents, multi-agent work, or
spawn behavior does not trigger it. Supported actual delegation must first run
`gearbox-dispatch plan` with the self-contained packet and current schema plus
parent-permission facts. Quality passes before cost is considered.

## Pre-spawn compatibility gate

Apply these checks in order and stop at the first failure:

1. Identify the workflow skill, requested child responsibility, number of
   children, required concurrency, write scope, side effects, and review
   contract.
2. Look up a known adapter. Unknown skills default to no delegation.
3. Choose the lightest sufficient Sol root. Do not select Ultra merely because
   a sequential workflow uses child agents.
4. Preserve the workflow semantics. Do not silently reduce exact concurrency,
   remove a required independent verdict, or change an external action into a
   different task.
5. Translate the requested responsibility to an installed typed role.
6. Confirm the current spawn schema exposes `agent_type` and that parent
   permissions match the role sandbox. A read-only Luna/Terra mismatch may use
   `isolated_role_root` through `gearbox-dispatch run-isolated`; it is an
   isolated root, never a child. A writer mismatch stays root-inline.
7. Spawn with `agent_type`, `fork_turns="none"`, a self-contained message, and
   no model, reasoning-effort, or service-tier override.
8. Keep at most two direct children active, depth 1, no descendants, and one
   writer with an exclusive scope.
9. Integrate, verify, close the child, and report persisted runtime identity as
   unverified when metadata is unavailable.

Generic `default`, `general-purpose`, `worker`, and `reviewer` agent types are
not Gearbox fallbacks. A missing or generic `agent_type` fails the gate.
`typed_child_bridge` is disabled for first activation with
`allowTypedBridge=false`; do not substitute it for a parent-permission mismatch.

## Generic responsibility mapping

| Requested responsibility | Typed role | Boundary |
|---|---|---|
| Deterministic inventory, extraction, classification, or formatting | `luna_clerk` | Read-only and unambiguous |
| Exploration, research, ranking, logs, documentation, or evidence | `terra_explorer` | Read-only; no final decision |
| Planned implementation or a bounded fixer | `terra_worker` | One exclusive write scope with clear tests |
| Requirements, diff, regression, security-boundary, or test-evidence review | `sol_reviewer` | Read-only; no reimplementation |

`terra_max_worker` and `terra_ultra_specialist` remain explicit opt-in side
lanes. A workflow skill cannot select them merely by asking for a stronger
generic worker.

## Known adapters

| Workflow skill | Adapter | Fail-closed boundary |
|---|---|---|
| `superpowers:subagent-driven-development` | Sol root owns the plan and progress ledger. Dispatch a fresh `terra_worker` implementer or fixer. Use `sol_reviewer` only in a later parent phase whose permission mode matches read-only; otherwise the Sol root performs task review. Put the required TDD and test contract in the self-contained brief because child workflow plugins remain disabled. Writers remain sequential. Sol root integrates and performs final adjudication. | Do not pass the workflow's explicit model override. Never launch the read-only reviewer from a broader workspace-write parent. If permission switching, exclusive write scope, or a typed final review cannot be preserved, keep that phase on the Sol root. |
| `superpowers:dispatching-parallel-agents` | Translate each independent responsibility to a typed role and run at most two direct children per batch. Prefer read-only evidence batches before a separate writer round. | Do not use generic agents, overlapping writers, shared mutable state, or nested dispatch. |
| `superpowers:requesting-code-review` | Send exact requirements, diff, and existing test evidence to `sol_reviewer`. Route accepted fixes separately to one `terra_worker` or keep them on the Sol root. | The reviewer never edits, reimplements, or reruns the whole task without a concrete reason. |
| `codex-security:security-scan` | Use `terra_explorer` for ranking and evidence collection, then `sol_reviewer` for bounded validation, attack-path, or security-boundary review. Run no more than two direct children per batch. Sol root owns finding decisions and write-ups. | No Terra child owns security decisions or writes security fixes. Unknown validation permissions, descendant agents, or more than two required concurrent workers fail closed. |
| `codex-security:security-diff-scan` | Use the same security mapping, limited to the supplied diff and affected boundaries. | Sol root owns reportable findings, fixes, and final closure. |

`superpowers:writing-plans` may route into subagent-driven development, but it
does not need its own spawn adapter until it produces an actual delegation
intent.

## Known incompatible or root-only workflows

| Workflow | Safe fallback |
|---|---|
| `sites:sites-building`, which requires exactly three parallel design options | Do not silently reduce the count. Keep the work on the Sol root or ask the owner to accept changed semantics. |
| `hatch-pet` generation and blind-verdict workers, which require creative or isolated-verdict behavior outside the current role contracts | Keep the workflow on the Sol root until bounded creative and verdict roles have live verification. |
| `heygen:heygen-video`, whose child may submit and poll an external job | Sol root performs the external action under the applicable approval policy. |
| Any workflow requiring nested subagents | Refuse delegation; Gearbox depth remains 1. |

## Unknown skill fallback

Unknown skill means no child spawn. The Sol root either completes the work
directly or first adds a reviewed adapter that specifies:

- responsibility-to-role mapping;
- concurrency and write ownership;
- permission and side-effect boundary;
- retry, review, and escalation behavior;
- tests proving the managed policy keeps the route typed and fail closed.

Do not infer compatibility from a skill name, model prose, or an example that
uses a generic agent. Do not use parent-model inheritance as a fallback.

## Enforcement boundary

Gearbox installs managed instructions, typed role profiles, static
spawn-argument validation, and runtime smoke verification. It does not patch
the Codex `spawn_agent` implementation or intercept calls below the instruction
layer. Therefore:

- static tests prove the policy and validator are present;
- runtime smoke proves observed typed role identity and lineage;
- neither should be described as a universal tool-runtime hook.

The disposable `smoke:sdd` harness verifies the adapter contract through two
sequential isolated root phases so each child receives the exact required
sandbox. It proves typed runtime identity, handoff order, and filesystem scope;
it does not prove that arbitrary third-party skill code is intercepted below
the instruction layer.

## Active failure boundary

`off` makes no automatic routing decision; `shadow` records a plan but keeps
execution in Sol; `active` executes only validated results. First active mode
requires trusted current ten-question acceptance evidence and an applied
manifest. One correction is allowed only for a concrete local output defect.
On a hard active failure, stop delegation; dispatch status and public evidence
redact the manifest path, and only the managed rollback command may consume it
to change global state. Do not publish a savings percentage before ten
comparable root-inclusive real-work pairs exist.
