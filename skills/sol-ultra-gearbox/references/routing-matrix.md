# Work and model routing matrix

Use this matrix after the risk gates. Choose the smallest configuration that
can safely complete and verify the work.

## Verify availability first

Reasoning levels vary by model, account, client, and release. Do not infer them
from a model name. Check the current local model catalog and fail closed when a
requested level is missing.

The development catalog verified for this release exposes:

| Model | Low | Medium | High | XHigh | Max | Ultra |
|---|---:|---:|---:|---:|---:|---:|
| `gpt-5.6-sol` | yes | yes | yes | yes | yes | yes |
| `gpt-5.6-terra` | yes | yes | yes | yes | yes | yes |
| `gpt-5.6-luna` | yes | yes | yes | yes | yes | no |

This table is release evidence, not a permanent product guarantee. Rerun the
Gearbox doctor after a Codex update or account change.

## Choose the execution shape first

| Work shape | Root mode | Delegation |
|---|---|---|
| Small, clear, and easy to verify | Sol root at the lightest sufficient effort | None |
| Normal mixed work | Sol Medium root | Delegate only a bounded noisy subtask |
| Difficult but tightly sequential | Sol High, XHigh, or Max root | Usually none |
| High-risk, ambiguous, or hard to roll back | Sol Max root | Readers may collect evidence; Sol owns decisions and writes |
| At least two independent workstreams | Sol Ultra root | Typed children with non-overlapping deliverables |

After a self-contained packet passes the quality gate before the cost gate,
run `gearbox-dispatch plan`. The planner selects exactly one shape:

| Shape | When it is allowed |
|---|---|
| `root_inline` | Any rejected gate, high-risk work, or writer permission mismatch. |
| `typed_child` | Typed capability is visible and parent/role permissions match. |
| `isolated_role_root` | Read-only Luna/Terra work passes all gates and the isolated runner is verified, but native `agent_type` is unavailable or parent permission cannot be inherited safely; the owner-approved `sol_skill_tester` writing-skills contract also uses this shape. It is always an isolated root, never a child. |
| `typed_child_bridge` | Disabled in the first active release (`allowTypedBridge=false`); never infer availability. |

`off` makes no automatic decision, `shadow` records a root-inline outcome, and
`active` may execute only the validated decision. Unknown workflow skills and
unsupported direct core calls are not bridged by this matrix; keep them on Sol.

Max and Ultra solve different problems. Max spends more reasoning on one task.
Ultra is for meaningful parallel decomposition and usually consumes more total
tokens because every child performs its own model and tool work.

The machine-readable classifier uses these exact topology classes:

| Task class | Sol root route | Required evidence |
|---|---|---|
| `simple` | Sol Low | At most two expected root tool calls or one local location |
| `normal` | Sol Medium | No difficult or independently parallel shape proven |
| `indivisible_difficult` | Sol Max | Ambiguity, hidden coupling, high risk, or weak verification |
| `independent_workstreams` | Sol Ultra | At least two explicitly declared independent workstreams, disjoint scopes, and directly consumable results |

`requestedChildren >= 2` by itself remains `normal`. The packet must carry the
separate `independentWorkstreams >= 2` fact; Gearbox, not the owner, is
responsible for producing that classification.

## Match typed roles to work

| Typed role | Model / effort | Use for | Do not use for |
|---|---|---|---|
| `luna_clerk` | Luna Low | Deterministic inventory, extraction, classification, transformation, and mechanical checks | Ambiguous judgment, architecture, or writes |
| `terra_explorer` | Terra Medium | Repository exploration, logs, documentation, large-file scans, and evidence collection | Implementation or final decisions |
| `terra_worker` | Terra High | Planned, bounded implementation with an exclusive write scope and clear tests | Hidden coupling, high-risk systems, or open-ended architecture |
| `sol_reviewer` | Sol High | Focused requirement, diff, regression, security-boundary, and test-evidence review | Reimplementing the task or owning routine writes |
| `terra_max_worker` | Terra Max | An explicitly requested exact role or an existing Max-profile workflow with a bounded scope | Automatic escalation, ordinary implementation, or a substitute for Sol risk ownership |
| `terra_ultra_specialist` | Terra Ultra | Exceptional module-scale, self-contained work with an exclusive scope and safe rollback path | Nested delegation, irreversible decisions, or overlapping writes |

`sol_skill_tester` is a separate isolated-only Sol High pressure-test role, not
a normal typed work role. It exists only for owner-approved
`superpowers:writing-skills` RED/GREEN evaluation and cannot be selected by the
generic routing table.

`terra_max_worker` and `terra_ultra_specialist` are opt-in side lanes, not
automatic steps above `terra_worker`. Task shape, not the effort label alone,
selects them.

## Use reasoning levels deliberately

### Sol root

- Low: quick, fully specified work with cheap verification.
- Medium: normal default root work and orchestration.
- High or XHigh: complex multi-step work that needs more checking but is not
  the hardest single-threaded problem.
- Max: the hardest sequential, ambiguous, high-risk, or difficult-to-verify
  task when depth matters more than speed or usage.
- Ultra: parallel orchestration only when independent workstreams exist.

### Terra

- Low: narrow, low-risk work that still benefits from Terra tool use.
- Medium: exploration and evidence collection.
- High: normal bounded implementation.
- XHigh: a manually selected deeper Terra run when High is insufficient but no
  stable custom role is justified.
- Max: the explicit `terra_max_worker` compatibility profile.
- Ultra: the exceptional `terra_ultra_specialist` profile.

### Luna

- Low: the normal deterministic clerk profile.
- Medium through Max: available only when the current catalog confirms them;
  prefer rerouting judgment-heavy work to Terra or Sol instead of repeatedly
  raising Luna effort.
- Ultra: unsupported by the verified release catalog; never request it unless a
  later catalog explicitly adds it and the repository is revalidated.

## Escalate by uncertainty and risk

The normal escalation path is:

```text
Luna Low -> Terra Medium -> Terra High -> Sol High/XHigh/Max root
```

Escalate immediately to Sol root when requirements are ambiguous, hidden
coupling appears, more than one distinct failure cause emerges, verification is
weak, or the work touches security, authentication, authorization, payments,
schema migrations, secrets, deployment, destructive actions, or irreversible
decisions.

Do not retry the same cheap role repeatedly. Do not automatically route from
Terra High to Terra Max or Terra Ultra. Use those profiles only when their exact
task-shape conditions are already satisfied.

## Product boundary

Sol Max is a root execution mode, not a custom child role. Sol Ultra is a root
mode that may delegate. `terra_ultra_specialist` is a typed child profile whose
instructions still prohibit descendant agents and whose depth remains 1.

This matrix follows the official guidance to use the lowest sufficient effort,
use Max for the hardest single task, use Ultra for divisible parallel work, and
prefer Terra or Luna for narrower work:

- [Codex model selection](https://learn.chatgpt.com/docs/models)
- [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
