# Sol Ultra Gearbox V2 Repository Instructions

## Scope

- This repository is the non-secret source of truth for Codex role profiles, validation, installation, and rollback tooling.
- Do not store complete user config, auth state, tokens, cookies, environment values, or rollout message contents here.
- Unit tests and dry runs must use fixtures or temporary directories. They must not mutate `~/.codex`.

## Global writes

- Only `node scripts/gearbox.mjs apply --promote-v2`, its matching `rollback`,
  and `node scripts/skill.mjs install|uninstall --apply` may write to
  `~/.codex`.
- One narrowly scoped runtime exception exists after active install: an
  owner-invoked foreground `gearbox-root launch|smoke` may let Codex persist
  its normal session rollout and may write one private Gearbox receipt beneath
  `$CODEX_HOME/gearbox/root-receipts/`. It must not modify global config,
  installed runtime/roles, auth, or any other `$CODEX_HOME` state, and it may
  not run as a background provider.
- Global writes require explicit owner approval, successful preflight checks, and successful live role probes.
- Configuration changes must be marker-delimited, minimal, idempotent, and removable without restoring a full `config.toml` backup.
- Skill installation must refuse unmanaged or locally modified target folders.

## Verification

- Use persisted rollout metadata for actual agent role, model, effort, sandbox, depth, and token evidence.
- Never treat a model's prose claim about its own role or model as verification.
- Any role mismatch, schema mismatch, unexpected write, descendant spawn, or missing metadata is a hard failure.
- Keep `terra_max_worker` as a compatibility role but do not make it the default route.
- Keep raw `reports/` local and run `npm run release:check` before publication.
- The policy-v2 `app_server_root` path is executable only through the installed
  foreground `gearbox-root` launcher before a new turn. It must verify
  persisted model/effort, declared write scope, readback, archive/unsubscribe,
  clean host exit, and the activation-bound acceptance hash. It is not a Codex
  core hook or stock Desktop interception.
- Fresh release evidence requires the owner-authorized `gearbox-root smoke`
  marker receipt created after active install. A handshake or ordinary
  `root_inline` fallback is not runtime verification.

## Verified workflow boundary

<!-- BEGIN sol-ultra-gearbox-v2:workflow -->
- Use a validated DAG and exact schema version 2 stage packets only for multi-stage dependency-bearing work; direct bounded work remains packet v1.
- Preserve reserved verification and recovery attempts. The first real execution is the canary; require a persisted running/completed receipt before releasing another stage.
- Process evidence, mechanical verify, explicit Sol adopt, then provider close. Verified is not adopted.
- Keep a compatible upstream workflow store as the source of truth. Use one private managed ledger only when no compatible source exists; resume adopted work without rerunning it and block incomplete executions.
- Workflow execution remains `root_inline`, `typed_child`, or `isolated_role_root`; `app_thread_root` is not enabled. This is not a Codex core hook.
<!-- END sol-ultra-gearbox-v2:workflow -->
