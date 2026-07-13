# Sol Ultra Gearbox V2 Repository Instructions

## Scope

- This repository is the non-secret source of truth for Codex role profiles, validation, installation, and rollback tooling.
- Do not store complete user config, auth state, tokens, cookies, environment values, or rollout message contents here.
- Unit tests and dry runs must use fixtures or temporary directories. They must not mutate `~/.codex`.

## Global writes

- Only `node scripts/gearbox.mjs apply --promote-v2`, its matching `rollback`,
  and `node scripts/skill.mjs install|uninstall --apply` may write to
  `~/.codex`.
- Global writes require explicit owner approval, successful preflight checks, and successful live role probes.
- Configuration changes must be marker-delimited, minimal, idempotent, and removable without restoring a full `config.toml` backup.
- Skill installation must refuse unmanaged or locally modified target folders.

## Verification

- Use persisted rollout metadata for actual agent role, model, effort, sandbox, depth, and token evidence.
- Never treat a model's prose claim about its own role or model as verification.
- Any role mismatch, schema mismatch, unexpected write, descendant spawn, or missing metadata is a hard failure.
- Keep `terra_max_worker` as a compatibility role but do not make it the default route.
- Keep raw `reports/` local and run `npm run release:check` before publication.
