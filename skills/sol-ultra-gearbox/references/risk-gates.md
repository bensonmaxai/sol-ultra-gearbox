# Risk gates

Use these gates in order. Stop at the first failure.

| Gate | Required evidence | Hard failure | Action |
|---|---|---|---|
| Scope | Matching Gearbox files and request | Risk text belongs to another system | Exclude it and report the mismatch |
| Managed policy | Signed policy, capability flags, and trusted current ten-question acceptance for active mode | Missing, invalid, unmanaged, stale, or hash-mismatched policy/evidence | Resolve to `off`; do not delegate or activate |
| Static config | Tests, doctor, strict config, dry-run | Parse error, unmanaged v2 table, unsupported model | Do not run live probes |
| Native spawn surface | Current task exposes `agent_type` | Only untyped spawn is available | Refuse native children; evaluate only a separately verified read-only isolated route |
| Isolated runner | Managed integrity passes and `isolatedRunnerVerified=true` | Missing, drifted, or unverified runner | Keep schema-unavailable and permission-mismatched reads on the Sol root |
| Prompt isolation | Self-contained task and `fork_turns="none"` | Full-history fork or runtime override | Refuse the child |
| Quality | Clear scope, deterministic verification, safe risk class, and no hidden coupling | Ambiguous, high-risk, weakly verifiable, or over-scoped work | Keep work on the Sol root before considering cost |
| Cost | Measurable avoided root work after quality passes | Root can finish in two calls, one location, or packet overhead dominates | Keep work on the Sol root |
| Permissions | Role sandbox matches the parent permission mode | Bypass permissions, `--yolo`, or broader access | Refuse delegation |
| Runtime identity | Persisted role, model, effort, sandbox, depth | Missing or mismatched metadata | Mark failure, not unverified success |
| Lineage | One typed child, depth 1, no descendants | Extra spawn or missing parent-child link | Stop the smoke run |
| Filesystem | Exact expected file diff | Unexpected write | Stop and preserve evidence |
| Global immutability | Same config contents before and after one isolated smoke | Same-run global config changed | Fail and inspect owned entries |
| Reusable smoke | Clean commit, matching config/Codex/role/runtime hashes, fixed TTL | Dirty tree, stale report, path escape, symlink, or any hash drift | Run a fresh approved smoke or stop |
| Writing-skills pressure test | Owner approval, isolated `sol_skill_tester`, at least five RED plus five GREEN fresh contexts, identical task/model/effort, target skill only in GREEN | Missing control, verdict leakage, parallel reuse, role/runtime mismatch, write, spawn, or cleanup failure | Stop on the first failure; do not publish or apply Active evidence |
| Cost | Persisted parent and child token usage | Tokens inferred from prose or role | Do not claim savings |
| Global apply | Explicit owner approval, all live roles pass, and persisted fresh CLI root is Sol Max or Ultra | Any earlier gate failed | Do not modify `~/.codex` |
| Skill install | Managed target and unchanged installed hashes | Unmanaged or locally edited target | Refuse overwrite |
| Publication | Tests, release check, skill validation, secret scan | Raw reports, secrets, or private home paths | Do not commit or push |

For an actual supported route, call `gearbox-dispatch plan` after the policy,
quality, and cost gates. A read-only Luna/Terra phase may use
`isolated_role_root` through `gearbox-dispatch run-isolated` when
`isolatedRunnerVerified=true` and either native `agent_type` is unavailable or
parent permission mismatches. It is an isolated root, not a child. A writer
mismatch or schema-unavailable writer remains root-inline. Unsupported direct
Codex core calls are outside repository interception.

`off` makes no routing decision, `shadow` only records a root-executed plan,
and `active` may execute an approved decision. First active installation sets
`allowTypedBridge=false`. One correction is allowed only for a concrete local
output defect; identity, permission, scope, cleanup, policy, or ambiguity
failure receives no retry. Hard active failures stop delegation and use only
the hash-bound activation manifest with the managed rollback command.

Automatic rollback must restore the previous Gearbox-owned config blocks to
the bound pre-install hash and retain privacy-safe failure diagnostics. Do not
store or restore a complete user config. Legacy recovery is allowed only when a
bounded candidate exactly matches the recorded hash.

## Version changes

After a Codex Desktop or CLI update, rerun tests, doctor, dry-run, and one
read-only role first. Run the full cost-bearing smoke only when the update can
affect the multi-agent runtime and the owner approves it.

Do not carry a successful `agent_type` conclusion from another task. Tool
schemas are captured per task and may differ after restart or upgrade.

## Cost interpretation

Do not calculate savings from smoke runs. Store only sanitized accepted
`real_work` evidence and require ten complete `sol_single`/`gearbox` pairs
before even marking an estimate as eligible. Dated official pricing remains a
separate later evaluation.
