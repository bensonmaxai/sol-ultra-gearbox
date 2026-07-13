# Release evidence

This file is generated from `docs/release-evidence.json`. Manual edits fail
`npm run release:check`.

## Deterministic checks

- Generated: 2026-07-13T13:59:11.799Z
- Source manifest: `2fb274dec401929096964b5730afd7d2a64f42969b75e9adfbd19128510f35eb` (38 files)
- Tests: PASS (44/44)

## Runtime evidence

- Six-role smoke: PASS (6/6), root metadata verified, commit `47d5191b599d`
- SDD adapter probe: PASS (terra_worker -> sol_reviewer), commit `47d5191b599d`

| Role | Actual model | Effort | Sandbox | Parent tokens | Child tokens | Status |
|---|---|---|---|---:|---:|---|
| `luna_clerk` | `gpt-5.6-luna` | low | read-only | 40334 | 26829 | PASS |
| `terra_explorer` | `gpt-5.6-terra` | medium | read-only | 40871 | 27160 | PASS |
| `terra_worker` | `gpt-5.6-terra` | high | workspace-write | 41510 | 56477 | PASS |
| `sol_reviewer` | `gpt-5.6-sol` | high | read-only | 40347 | 41164 | PASS |
| `terra_ultra_specialist` | `gpt-5.6-terra` | ultra | workspace-write | 41345 | 42042 | PASS |
| `terra_max_worker` | `gpt-5.6-terra` | max | workspace-write | 41804 | 57052 | PASS |


Runtime reports remain local and ignored. This public evidence contains only
sanitized pass/fail summaries and immutable source identifiers.

## Real-work cost evidence

- Complete comparable pairs: 0/10
- Eligible for a dated estimate: no
- Estimator published: no

Smoke tokens are excluded. No price or savings claim is published before ten
accepted pairs of comparable real work exist.

## Explicit boundary

- Codex core runtime hook: out of scope for this repository.
- Gearbox remains an instruction-level pre-spawn gate plus persisted runtime verification.
