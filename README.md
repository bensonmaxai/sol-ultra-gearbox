# Sol Ultra Gearbox

Fail-closed tooling for routing Codex work to typed Sol, Terra, and Luna
subagents, verifying the runtime identity of every child, and applying or
rolling back the corresponding local configuration.

> Experimental and version-sensitive. This project verifies observed runtime
> behavior; it does not promise that an undocumented multi-agent schema will
> remain compatible with future Codex builds.

中文摘要：這個專案讓 Sol root 只在適合平行化時委派給明確角色，並用
persisted rollout metadata 驗證實際 model、effort、sandbox、depth 與 token
usage。任何 metadata 缺失、越界寫入或 schema mismatch 都會 fail closed。

## Root modes

| Mode | Intended use |
|---|---|
| Sol root, lightest sufficient effort | Default single-agent execution |
| Sol Max root | Ambiguous, tightly sequential, high-risk, or difficult-to-verify work |
| Sol Ultra root | Orchestration with at least two independent workstreams |

Sol Max is selected on the root task. It is not a custom child role and the
Gearbox does not spawn a Sol child to simulate it.

See the [complete work and model routing matrix](skills/sol-ultra-gearbox/references/routing-matrix.md)
for Low through Ultra effort boundaries, escalation, and the distinction
between Sol Ultra root orchestration and the Terra Ultra child profile.

## Roles

| Role | Model | Effort | Permission | Intended use |
|---|---|---|---|---|
| `luna_clerk` | `gpt-5.6-luna` | `low` | read-only | Deterministic inventory and extraction |
| `terra_explorer` | `gpt-5.6-terra` | `medium` | read-only | Repository, log, and evidence exploration |
| `terra_worker` | `gpt-5.6-terra` | `high` | workspace-write | Planned implementation with an exclusive scope |
| `sol_reviewer` | `gpt-5.6-sol` | `high` | read-only | Requirements, diff, security boundary, and test review |
| `terra_ultra_specialist` | `gpt-5.6-terra` | `ultra` | workspace-write | Exceptional module-scale, rollback-safe work |
| `terra_max_worker` | `gpt-5.6-terra` | `max` | workspace-write | Explicitly requested or existing Max-profile workflows |

`terra_max_worker` is a supported opt-in compatibility role, but it is never an
automatic route or the default upgrade from `terra_worker`.

## Safety model

- Inspect the current task's spawn schema. Never create an untyped child when
  `agent_type` is unavailable.
- Always use `fork_turns="none"` for typed roles. Let role TOML own model,
  reasoning effort, and sandbox settings.
- Allow at most two direct children, depth 1, and no descendant agents.
- Reserve three MultiAgentV2 session slots because the root consumes one slot;
  this enables, but never exceeds, two simultaneous direct children.
- Prefer multiple readers and one writer. A writer must own an exclusive file
  scope.
- Read persisted rollout metadata instead of trusting a model's prose claim
  about its identity.
- Use an isolated `CODEX_HOME` for live probes and require the real global
  config to have the same contents before and after the probe.
- Remove owned temporary probe homes and fixtures after evidence extraction;
  treat cleanup failure as a smoke failure.
- Bind paid runtime evidence to a clean Git commit, global config hash, Codex
  version, every role hash, and the runner source hashes.
- Stop after the first failed role. Do not retry a cost-bearing smoke test.
- Back up and marker-manage every global write so rollback does not replace an
  unrelated complete config file.

See [the risk gates](skills/sol-ultra-gearbox/references/risk-gates.md) for the
full decision table.

## Skill-driven delegation compatibility

Installed workflow skills remain available to the Sol root. Gearbox does not
replace their planning, review, or artifact flow. Instead, immediately before
an actual `spawn_agent` call, the managed policy applies a pre-spawn
compatibility gate that:

- keeps sequential skill adapters on the lightest sufficient Sol root and
  reserves Sol Ultra for meaningful parallel workstreams;
- translates generic implementer, explorer, clerk, and reviewer requests to
  verified typed roles;
- preserves `fork_turns="none"` and role-owned model, effort, and sandbox
  settings;
- refuses a child when the current parent permission mode does not match the
  role sandbox;
- batches compatible fan-out within the two-child and one-writer limits;
- keeps security decisions, external side effects, and final adjudication on
  the Sol root;
- fails closed for unknown skills or incompatible requirements instead of
  using an untyped or parent-inherited child.

Known adapters cover Superpowers subagent-driven development, parallel
dispatch, code review, and Codex Security repository or diff scans. Exact
behavior, conflict handling, and unsupported workflow fallbacks are documented
in the
[subagent skill compatibility matrix](skills/sol-ultra-gearbox/references/subagent-skill-compatibility.md).

This is an instruction-level pre-spawn policy gate, not a hook inside the Codex
tool runtime. Static tests protect the managed policy and spawn-argument
validator; persisted rollout metadata remains the authority for actual runtime
identity.

## Quality-first dispatch

For supported actual delegation, Gearbox uses managed instructions plus the
`gearbox-dispatch` runner. It does not intercept a direct Codex core
`spawn_agent` call made outside those entrypoints.

The managed policy is fail closed: missing, invalid, unmanaged, or
hash-mismatched policy is `off`. In `off`, Gearbox makes no automatic routing
decision. In `shadow`, it calculates and records a decision but the Sol root
executes the work. In `active`, it may execute only a decision that passes all
gates. Quality is always checked before cost, so an available cheaper role
cannot reverse a quality rejection.

Build a self-contained packet only when delegation is intended, then run
`gearbox-dispatch plan` with the packet, current spawn-schema capability, and
parent-permission facts. The possible shapes are:

| Shape | Meaning |
|---|---|
| `root_inline` | Sol completes the work after a failed gate or unsafe permission shape. |
| `typed_child` | Sol calls the exact typed `spawn_agent` arguments only when permissions match. |
| `isolated_role_root` | Direct Luna/Terra read-only work in a separate isolated root when parent permission would not match. It is never a child. |
| `typed_child_bridge` | Disabled for first activation with `allowTypedBridge=false`. |

Unknown skills, generic roles, missing typed capability flags, and missing or
mismatched runtime evidence remain root-inline. A cheap role gets one initial
attempt and at most one correction for a concrete local output defect; identity,
permission, scope, cleanup, policy, ambiguity, or hidden-coupling failures do
not retry. Trusted current ten-question acceptance evidence and an applied
activation manifest are required before first active mode. A hard active-mode
failure stops delegation; the manifest path is redacted from public output, and
only the managed rollback command can consume it to alter global state.

Q10 verifies exact typed fields, two distinct non-empty task messages, declared
disjoint scope mapping, persisted child identity, lineage, markers, tokens, no
writers or descendants, and an unchanged fixture. It does not claim observed
per-file read telemetry or byte-identical prompt persistence.

The exact root workflow is: build packet, load policy, plan, complete
`root_inline` in Sol or execute/validate the selected `typed_child` or
`isolated_role_root`, reject missing evidence, stop and roll back through the
hash-bound manifest after a hard active failure, then let Sol integrate, test,
record a privacy-safe outcome, and clean the packet. See the
[quality-first dispatch reference](skills/sol-ultra-gearbox/references/quality-first-dispatch.md)
for the complete contract.

## Requirements

- Node.js 20 or newer
- A Codex CLI or Codex Desktop installation with an authenticated local CLI
- A local model catalog containing the role models and reasoning levels
- An `[agents]` table with `max_depth = 1`; any positive legacy `max_threads`
  value is preserved and temporarily suspended while v2 owns concurrency

The CLI can be selected with `CODEX_BIN`. `CODEX_HOME` defaults to
`$HOME/.codex`.

## Safe start

```bash
npm test
npm run release:check
npm run doctor -- --json
node scripts/gearbox.mjs apply --promote-v2 --dispatch-mode active --dry-run
npm run acceptance
node scripts/gearbox.mjs apply --promote-v2 --dispatch-mode active
npm run dispatch:status
```

An active status reports integrity `pass`, `allowTypedBridge=false`, the policy
digest, and current managed configuration, role, launcher, and runtime hashes
without exposing the manifest path.

The dry run does not run model-backed probes or modify global configuration.
`npm run acceptance` and the final active apply are paid, owner-authorized
operations. The final apply runs fresh paid smoke and acceptance evidence unless
both trusted reuse paths (`--reuse-smoke` and `--reuse-acceptance`) validate
against the current clean binding. All global changes are manifest-bound and
reversible through the managed rollback command.

## Install the global skill

Preview first:

```bash
npm run skill:status
npm run skill:install
```

Apply only after reviewing the target and plan:

```bash
npm run skill:install -- --apply
```

The installer refuses an unmanaged target or a managed install whose files
were changed locally. Updates and uninstall preserve prior managed directories
under `$CODEX_HOME/backups/skills/sol-ultra-gearbox/`, outside the active skill
scan directory. The installer safely migrates legacy managed sibling backups;
an unmanaged or locally modified legacy archive fails closed. Uninstall is also
preview-only by default and archives the installation instead of deleting it:

```bash
npm run skill:uninstall
npm run skill:uninstall -- --apply
```

Restart Codex and open a fresh task after installing or updating the skill.

## Cost-bearing runtime verification

The following command launches real model-backed probes and consumes credits:

```bash
npm run smoke
```

Run it only with explicit owner approval. A pass requires all six roles to
match their expected role, model, effort, sandbox, depth, parent and child token
metadata, marker, filesystem scope, no-descendant policy, and temporary-artifact
cleanup. Raw reports are written under `reports/` and intentionally ignored by
Git.

The disposable SDD adapter contract is a separate paid probe:

```bash
npm run smoke:sdd
```

It runs `terra_worker` and `sol_reviewer` sequentially from isolated roots
whose permission modes match each role. It verifies the write-to-review
handoff; it is not a Codex core interception test.

## Promote and rollback global configuration

Preview:

```bash
node scripts/gearbox.mjs apply --promote-v2 --dry-run
```

Apply only after explicit approval:

```bash
node scripts/gearbox.mjs apply --promote-v2
```

By default the active apply runs fresh role smoke and ten-question acceptance
evidence. To avoid immediately repeating those paid checks, explicitly provide
both trusted local reports:

```bash
node scripts/gearbox.mjs apply --promote-v2 \
  --dispatch-mode active \
  --reuse-smoke reports/<run>/smoke.json \
  --reuse-acceptance reports/<run>/acceptance.json
```

Reuse fails closed unless the report is under this repo's `reports/`, is a
regular non-symlink file, is at most 30 minutes old, and exactly matches the
current clean commit, config, Codex version, role files, and runtime sources.
Apply writes marker-delimited changes, performs post-install checks, and
automatically rolls back on failure. For a manual rollback, use the local
manifest printed by the apply command:

```bash
node scripts/gearbox.mjs rollback --manifest reports/<run>/install-manifest.json
```

Existing Codex tasks retain the tool schema captured at task start. Validate
the `agent_type` surface again in a fresh task.

## Publication checks

After one current role smoke and SDD probe, generate both public evidence
artifacts from their ignored local reports:

```bash
npm run release:evidence -- \
  --smoke reports/<run>/smoke.json \
  --sdd reports/<run>/sdd.json \
  --acceptance reports/<run>/acceptance.json \
  --usage reports/<run>/real-work-usage.json
```

```bash
npm test
npm run release:check
gitleaks dir . --redact
```

The release check excludes raw reports, rejects private home paths and common
credential formats, validates the bundled skill metadata, verifies the JSON
and Markdown evidence against the current source manifest, and prevents
accidental npm publication. CI runs the deterministic checks on every push and
pull request.

## Real-work cost evidence

Smoke tokens are not a savings benchmark. Historical typed child sessions can
be summarized as child-only observed runtime, including rejected policy runs,
without pretending they are full-task A/B samples. Add only sanitized,
accepted, root-inclusive comparable work to the ignored ledger described in
[docs/REAL_WORK_EVIDENCE.md](docs/REAL_WORK_EVIDENCE.md):

```bash
node scripts/cost-evidence.mjs status
node scripts/cost-evidence.mjs add reports/cost-evidence.json record.json
```

Nine complete pairs remain ineligible. Ten pairs expose aggregate raw evidence
and eligibility only; the repository still does not publish prices, a savings
percentage, or an estimator. Any future estimate must use a separately dated
official pricing source.

## License

[MIT](LICENSE)
