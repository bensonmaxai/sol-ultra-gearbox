# Release evidence

This file is generated from `docs/release-evidence.json`. Manual edits fail
`npm run release:check`.

## Deterministic checks

- Generated: 2026-07-14T00:06:23.583Z
- Source manifest: `864488472c0dd1e440dac56e11d8d0d6c4dea1904021a8d31ecec3b1e4360c21` (58 files)
- Tests: PASS (129/129)

## Runtime evidence

- Active installation: PASS; integrity pass; bridge disabled; fresh root `gpt-5.6-sol` / max
- Bound config transition: `b18f26faa459` -> `ca9c41de6987`; policy `0140b1ec8594`
- Six-role smoke: PASS (6/6), root metadata verified, commit `bf69f35c6ac5`
- SDD adapter probe: PASS (terra_worker -> sol_reviewer), commit `bf69f35c6ac5`
- Ten-question acceptance exam: PASS (10/10), active eligible: yes
- Acceptance execution shapes: `isolated_role_root`, `root_inline`, `typed_child`; runtime binding `fdbd3636d691`

| Role | Actual model | Effort | Sandbox | Parent tokens | Child tokens | Status |
|---|---|---|---|---:|---:|---|
| `luna_clerk` | `gpt-5.6-luna` | low | read-only | 54603 | 40693 | PASS |
| `terra_explorer` | `gpt-5.6-terra` | medium | read-only | 40408 | 26838 | PASS |
| `terra_worker` | `gpt-5.6-terra` | high | workspace-write | 41493 | 71615 | PASS |
| `sol_reviewer` | `gpt-5.6-sol` | high | read-only | 40364 | 55208 | PASS |
| `terra_ultra_specialist` | `gpt-5.6-terra` | ultra | workspace-write | 41462 | 27778 | PASS |
| `terra_max_worker` | `gpt-5.6-terra` | max | workspace-write | 41359 | 73344 | PASS |


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
