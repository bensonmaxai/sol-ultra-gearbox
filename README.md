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

## Roles

| Role | Model | Effort | Permission | Intended use |
|---|---|---|---|---|
| `luna_clerk` | `gpt-5.6-luna` | `low` | read-only | Deterministic inventory and extraction |
| `terra_explorer` | `gpt-5.6-terra` | `medium` | read-only | Repository, log, and evidence exploration |
| `terra_worker` | `gpt-5.6-terra` | `high` | workspace-write | Planned implementation with an exclusive scope |
| `sol_reviewer` | `gpt-5.6-sol` | `high` | read-only | Requirements, diff, security boundary, and test review |
| `terra_ultra_specialist` | `gpt-5.6-terra` | `ultra` | workspace-write | Exceptional module-scale, rollback-safe work |

`terra_max_worker` remains available only for legacy compatibility.

## Safety model

- Inspect the current task's spawn schema. Never create an untyped child when
  `agent_type` is unavailable.
- Always use `fork_turns="none"` for typed roles. Let role TOML own model,
  reasoning effort, and sandbox settings.
- Allow at most two direct children, depth 1, and no descendant agents.
- Prefer multiple readers and one writer. A writer must own an exclusive file
  scope.
- Read persisted rollout metadata instead of trusting a model's prose claim
  about its identity.
- Use an isolated `CODEX_HOME` for live probes and require the real global
  config to have the same contents before and after the probe.
- Stop after the first failed role. Do not retry a cost-bearing smoke test.
- Back up and marker-manage every global write so rollback does not replace an
  unrelated complete config file.

See [the risk gates](skills/sol-ultra-gearbox/references/risk-gates.md) for the
full decision table.

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
node scripts/gearbox.mjs apply --promote-v2 --dry-run
```

These commands do not run model-backed role probes and do not modify global
configuration.

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
were changed locally. Updates preserve the previous directory as a sibling
backup. Uninstall is also preview-only by default and renames the installation
to a disabled directory instead of deleting it:

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

Run it only with explicit owner approval. A pass requires all five roles to
match their expected role, model, effort, sandbox, depth, parent and child token
metadata, marker, filesystem scope, and no-descendant policy. Raw reports are
written under `reports/` and intentionally ignored by Git.

## Promote and rollback global configuration

Preview:

```bash
node scripts/gearbox.mjs apply --promote-v2 --dry-run
```

Apply only after explicit approval:

```bash
node scripts/gearbox.mjs apply --promote-v2
```

The apply command reruns all live role probes, writes marker-delimited changes,
performs post-install checks, and automatically rolls back on failure. For a
manual rollback, use the local manifest printed by the apply command:

```bash
node scripts/gearbox.mjs rollback --manifest reports/<run>/install-manifest.json
```

Existing Codex tasks retain the tool schema captured at task start. Validate
the `agent_type` surface again in a fresh task.

## Publication checks

```bash
npm test
npm run release:check
gitleaks dir . --redact
```

The release check excludes raw reports, rejects private home paths and common
credential formats, validates the bundled skill metadata, and prevents
accidental npm publication. CI runs the deterministic checks on every push and
pull request.

## License

[MIT](LICENSE)
