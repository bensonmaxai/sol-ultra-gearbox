# Risk gates

Use these gates in order. Stop at the first failure.

| Gate | Required evidence | Hard failure | Action |
|---|---|---|---|
| Scope | Matching Gearbox files and request | Risk text belongs to another system | Exclude it and report the mismatch |
| Static config | Tests, doctor, strict config, dry-run | Parse error, unmanaged v2 table, unsupported model | Do not run live probes |
| Spawn surface | Current task exposes `agent_type` | Only untyped spawn is available | Keep work on the Sol root |
| Prompt isolation | Self-contained task and `fork_turns="none"` | Full-history fork or runtime override | Refuse the child |
| Permissions | Role sandbox matches the parent permission mode | Bypass permissions, `--yolo`, or broader access | Refuse delegation |
| Runtime identity | Persisted role, model, effort, sandbox, depth | Missing or mismatched metadata | Mark failure, not unverified success |
| Lineage | One typed child, depth 1, no descendants | Extra spawn or missing parent-child link | Stop the smoke run |
| Filesystem | Exact expected file diff | Unexpected write | Stop and preserve evidence |
| Global immutability | Same config contents before and after one isolated smoke | Same-run global config changed | Fail and inspect owned entries |
| Reusable smoke | Clean commit, matching config/Codex/role/runtime hashes, fixed TTL | Dirty tree, stale report, path escape, symlink, or any hash drift | Run a fresh approved smoke or stop |
| Cost | Persisted parent and child token usage | Tokens inferred from prose or role | Do not claim savings |
| Global apply | Explicit owner approval and all live roles pass | Any earlier gate failed | Do not modify `~/.codex` |
| Skill install | Managed target and unchanged installed hashes | Unmanaged or locally edited target | Refuse overwrite |
| Publication | Tests, release check, skill validation, secret scan | Raw reports, secrets, or private home paths | Do not commit or push |

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
