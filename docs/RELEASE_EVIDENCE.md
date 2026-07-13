# Release evidence

This file is generated from `docs/release-evidence.json`. Manual edits fail
`npm run release:check`.

## Deterministic checks

- Generated: 2026-07-13T14:28:05.437Z
- Source manifest: `046a093de861e5b16037ac7e256ca18c610940f99fd0f4eafb6f5f4879d8aaa4` (38 files)
- Tests: PASS (48/48)

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

- Observed typed child runtime: 15 sessions, 24 completed turns across 4 parent threads
- Runtime metadata verified: 15/15; explicit `fork_turns=none`: 15/15; nested spawn sessions: 0
- Policy-compliant sessions: 2/15; rejected: 13 (permission mismatch: 13; spawn override mismatch: 1)

| Role | Actual model | Effort | Sessions | Completed turns | Child tokens | Policy compliant |
|---|---|---|---:|---:|---:|---:|
| `sol_reviewer` | `gpt-5.6-sol` | high | 6 | 13 | 10433652 | 0/6 |
| `terra_explorer` | `gpt-5.6-terra` | medium | 7 | 8 | 3889951 | 0/7 |
| `terra_worker` | `gpt-5.6-terra` | high | 2 | 3 | 7344884 | 2/2 |


- Complete comparable pairs: 0/10
- Eligible for a dated estimate: no
- Estimator published: no

Child-only runtime evidence is not a root-inclusive task cost or an A/B pair.
Smoke tokens are excluded. No price or savings claim is published before ten
accepted pairs of comparable real work exist.

## Explicit boundary

- Codex core runtime hook: out of scope for this repository.
- Gearbox remains an instruction-level pre-spawn gate plus persisted runtime verification.
