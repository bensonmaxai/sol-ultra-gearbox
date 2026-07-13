---
name: sol-ultra-gearbox
description: Audit, verify, install, route, and roll back Codex Sol root modes plus typed Terra and Luna subagent configurations. Use when working with Sol Max or Ultra, multi-agent model routing, workflow-skill spawn compatibility, custom agent TOML files, spawn_agent schema visibility, role smoke tests, cost evidence, global Gearbox installation, or fail-closed rollback.
---

# Sol Ultra Gearbox

Use the repository tooling as the source of truth. Do not reconstruct global
configuration edits by hand.

## Establish scope

1. Locate the Gearbox repository supplied by the user or current workspace.
2. Read its `AGENTS.md`, `README.md`, role files, and latest relevant local
   report summary.
3. Classify the request as audit, live verification, global apply, rollback,
   skill installation, or release preparation.
4. Treat unrelated scheduler, deployment, social-media, payment, or production
   execution controls as out of scope unless matching code exists in the repo.

Read [references/risk-gates.md](references/risk-gates.md) before any live probe,
global write, or public release.

Read [references/routing-matrix.md](references/routing-matrix.md) before model
or effort selection, changing role defaults, or deciding between Max and Ultra.

Read
[references/subagent-skill-compatibility.md](references/subagent-skill-compatibility.md)
before any workflow skill dispatches, delegates, fans out, or calls
`spawn_agent`.

## Run the least costly gate

For an audit or planned change, run:

```bash
npm test
npm run doctor -- --json
node scripts/gearbox.mjs apply --promote-v2 --dry-run
```

Report static checks as static evidence only. Do not claim typed routing works
until persisted runtime metadata proves it.

## Route root modes and typed roles

Treat Sol root modes and typed child roles as different controls.

- Keep Sol as the root decision-maker and use the lightest sufficient root
  effort.
- Use Sol Max as a single root for ambiguous, tightly sequential, high-risk, or
  difficult-to-verify work that does not benefit from parallel delegation. Sol
  Max is a root execution mode, not an `agent_type`; do not spawn a Sol child to
  simulate it.
- Use Sol Ultra only when at least two independent workstreams have concrete,
  non-overlapping deliverables.
- Route deterministic reads to `luna_clerk`, exploration to `terra_explorer`,
  planned bounded implementation to `terra_worker`, and focused high-risk diff
  review to `sol_reviewer`.
- Reserve `terra_ultra_specialist` for exceptional module-scale work with an
  exclusive scope and safe rollback path.
- Support `terra_max_worker` as an explicit opt-in compatibility role when the
  owner requests that exact role or an existing workflow depends on its Max
  effort profile. Never select it automatically or treat it as the normal
  upgrade from `terra_worker`.

Use the routing matrix for the complete Low through Ultra mapping. Do not create
one custom role for every supported effort; keep only profiles with a distinct,
stable responsibility.

## Decide whether delegation is allowed

Inspect the `spawn_agent` schema exposed in the current task.

- Require `agent_type` before using a named role.
- Set `fork_turns="none"` explicitly.
- Omit `model`, `reasoning_effort`, and `service_tier`; role TOML owns them.
- Refuse untyped children that would inherit the parent model.
- Limit delegation to two direct children, depth 1, with no nested spawning.
- Prefer read-only fan-out. Allow one writer per exclusive file scope.

## Adapt skill-driven delegation

Keep workflow skills active on the Sol root. They may own planning, task order,
review loops, artifact handoffs, and acceptance criteria. Immediately before an
actual child spawn, apply the compatibility gate:

- do not select Sol Ultra merely because a workflow uses subagents; a known
  sequential adapter may dispatch one typed child at a time from the lightest
  sufficient Sol root;
- translate generic implementer, explorer, clerk, and reviewer requests to a
  known typed role;
- preserve the workflow's semantics without inheriting its generic model or
  agent defaults;
- batch compatible independent work within the two-child limit;
- keep external side effects, security findings, and final adjudication on the
  Sol root;
- fail closed for an unknown skill or an unresolvable conflict instead of
  guessing a role or silently changing required concurrency.

Use the compatibility matrix for the explicit
`subagent-driven-development`, `dispatching-parallel-agents`,
`requesting-code-review`, `security-scan`, and `security-diff-scan` adapters.
The presence of words such as subagent, multi-agent, or spawn in documentation
does not trigger the gate; an actual delegation intent does.

## Run live verification

Run `npm run smoke` only after explicit owner approval because it consumes
model credits. Stop on the first failure and do not retry automatically.

Require persisted evidence for:

- parent and child lineage;
- role, model, effort, sandbox, and depth;
- `fork_turns="none"` with no model, effort, or service-tier override;
- parent and child token usage;
- no descendant spawn;
- exact filesystem scope and expected marker;
- identical global config contents before and after the isolated probe.

Mark missing runtime metadata as `unverified`; never infer cost savings from a
role name or prose response.

## Apply or roll back

Preview global configuration with the dry-run command. Run
`node scripts/gearbox.mjs apply --promote-v2` only with explicit owner approval
and only after all live roles pass. Preserve the emitted manifest.

If post-install validation fails, require automatic rollback. For a later
manual rollback, use the exact manifest path and avoid `--force` unless the
owner accepts overwriting post-install drift.

Install this skill globally with `npm run skill:install -- --apply`. Refuse to
overwrite unmanaged or locally modified skill folders. Uninstall only through
the managed command; it disables the folder instead of deleting it.

## Prepare a public release

Run unit tests, `npm run release:check`, the official skill validator when
available, and a local secret scanner. Keep raw reports, auth state, complete
user config, rollout contents, and private filesystem paths out of Git.

## Report the result

Separate verified facts, inference, and remaining risk. Include:

- operation and result;
- role, actual model, effort, fork, read/write scope, retry, and escalation;
- tests and report path;
- whether global state changed;
- rollback path when applicable;
- cost evidence only when runtime token metadata exists.
