# Security policy

Sol Ultra Gearbox can modify Codex configuration and launch model-backed
verification. Treat configuration integrity, sandbox boundaries, local paths,
and authentication state as security-sensitive.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting flow when it is available. If it
is not available, open an issue containing no exploit details or secrets and
ask the maintainers for a private reporting channel.

Never include tokens, cookies, `auth.json`, complete `config.toml` files,
rollout transcripts, or private filesystem paths in a public report.

## Supported version

Only the latest commit on the default branch is supported. Multi-agent schemas
and model identifiers are version-sensitive; run the repository's doctor and
live verification against the exact Codex build in use.

## Security invariants

- Global configuration writes require explicit owner approval.
- Unknown or locally modified skill installations are never overwritten.
- Uninstall disables the managed skill directory instead of deleting it.
- Missing runtime metadata, schema mismatch, descendant spawning, or an
  unexpected filesystem write is a hard failure.
- Raw reports are local-only and excluded from version control.
