# Quality-first managed dispatch

Use this reference only when a bounded unit of work may actually be delegated.
Gearbox is an instruction-level and runner-level control, not a Codex core
hook. A direct `spawn_agent` call outside the bundled skill or
`gearbox-dispatch` is not intercepted by this repository.

## Policy and capability gate

Load the managed dispatch policy before planning. A missing, invalid,
unknown-version, hash-mismatched, or unmanaged policy is `off`.

| Mode | Meaning |
|---|---|
| `off` | Gearbox makes no automatic routing decision. |
| `shadow` | Calculate and record the decision, but the Sol root executes it. |
| `active` | Execute only a decision that passes every managed gate. |

First activation requires trusted current ten-question acceptance evidence, a
persistent managed activation record, and an applied local rollback manifest.
It must set `allowTypedBridge=false`.
`typed_child_bridge` remains unavailable unless a future, explicitly enabled
capability has its own verified runtime evidence.

## Exact routing order

Quality is a hard gate before cost. A cheap role cannot overturn a quality
rejection.

1. Build one self-contained packet only when actual delegation is intended.
2. Load the managed policy; missing or invalid means `off`.
3. Run `gearbox-dispatch plan` with separate `agentTypeVisible`,
   `isolatedRunnerVerified`, runtime-metadata, and permission facts.
4. `root_inline`: Sol completes the task.
5. `typed_child`: Sol calls `spawn_agent` with exact typed arguments, persists the receipt, collects evidence, mechanically verifies it, explicitly adopts it, and only then closes the provider.
6. `isolated_role_root`: run `gearbox-dispatch run-isolated`; it is an isolated root, never a child.
7. Reject missing or mismatched evidence before integration.
8. On a hard active-mode failure, stop delegation and use the hash-bound local rollback manifest with the managed rollback command.
9. Sol integrates, runs final relevant tests, records the privacy-safe outcome, and cleans the packet.

Direct bounded packet-v1 work keeps this routing behavior. For a validated DAG,
compile a self-contained schema version 2 packet for each stage and use the
verified workflow lifecycle below.

## Verified workflow lifecycle

Preserve reserved verification and recovery attempts. Materialize the first
real execution as the canary, require a persisted running/completed receipt,
and release no deferred stage when the canary fails. Then collect evidence,
verify hashes/runtime/scope, obtain explicit Sol adoption, and close the
provider. `verified` alone never unlocks a dependent.

Treat a compatible upstream workflow store as the source of truth; use one
private managed ledger only when no compatible upstream source exists. Resume
adopted work without rerunning it and block incomplete executions. Workflow
shapes remain `root_inline`, `typed_child`, and `isolated_role_root`;
`app_thread_root` is not enabled. This is not a Codex core hook.

The only shape names are `root_inline`, `typed_child`, `isolated_role_root`,
and `typed_child_bridge`. Verified Luna/Terra isolated roots solve read-only
parent-permission mismatch and may also operate when the native child schema
lacks `agent_type`; they do not claim native-child lineage. Writer permission
mismatches and writers without native typed capability remain `root_inline`.
The exact owner-approved `superpowers:writing-skills` adapter may instead run
the isolated-only `sol_skill_tester` with its dedicated reason for sequential
fresh-context RED/GREEN pressure testing. No other adapter may request it.

## Acceptance and recovery

Unknown skills, generic roles, no verified native-or-isolated execution
surface, or missing/mismatched runtime evidence fail closed to `root_inline`.
Missing `agent_type` blocks native children but does not block a verified
read-only `isolated_role_root`.
One initial cheap-role attempt and one correction are allowed only for a
concrete local output defect. Identity, effort, sandbox, scope, permission,
cleanup, policy, ambiguity, hidden-coupling, or security failure receives no
retry.

After a hard active-mode failure, stop delegation for the task. Active status
reads the private managed record beneath `$CODEX_HOME/gearbox/activations/` and
verifies managed configuration, AGENTS, role, launcher, runtime, and wrapper
hashes and modes without repository reports. Status and public evidence redact
both record and manifest paths. Only the managed rollback command may consume the local manifest to
alter global state. Do not publish a savings percentage or estimator until ten
comparable root-inclusive real-work pairs exist.

Before reporting an applied active policy, require a persisted fresh CLI root
on `gpt-5.6-sol` at Max or Ultra effort. This is an isolated CLI quality-floor
check; it does not prove the task-local Desktop mode. Persist privacy-safe root
diagnostics before rollback. Restore the previous Gearbox-owned config blocks
to the bound pre-install hash without restoring a complete user config.

Q10 proves exact typed fields, distinct non-empty task messages, declared
disjoint scope mapping, persisted child identity, lineage, markers, tokens, no
writers or descendants, and an unchanged fixture. Persisted prompt text is not
treated as byte-identical scope telemetry, so do not claim observed per-file
reads.
