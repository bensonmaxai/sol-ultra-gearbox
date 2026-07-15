# Release evidence

This file is generated from `docs/release-evidence.json`. Manual edits fail
`npm run release:check`.

## Deterministic checks

- Generated: 2026-07-15T05:56:45.181Z
- Source manifest: `85c8986e9d3cadfe7f720200dc3a6d7baf0b4d47cb98d0709c880fd0e577095a` (90 files)
- Tests: PASS (251/251)
- Verified workflow contract: PASS (5/5); Q10 canary: verified

## Runtime evidence

- Active installation: PASS; integrity pass; bridge disabled; fresh root `gpt-5.6-sol` / ultra
- Bound config state: `1bd5662de4b1` -> `1bd5662de4b1` (unchanged); policy `9d04bfea9f12`
- Six-role smoke: PASS (6/6), root metadata verified, commit `82aa28d8a423`
- Writing-skills pressure test: PASS (5 RED, 5 GREEN), isolated role `sol_skill_tester`
- SDD adapter probe: PASS (terra_worker -> sol_reviewer), commit `82aa28d8a423`
- Ten-question acceptance exam: PASS (10/10), active eligible: yes
- Acceptance execution shapes: `isolated_role_root`, `root_inline`, `typed_child`; runtime binding `bf9a8bdd7c8c`

| Role | Actual model | Effort | Sandbox | Parent tokens | Child tokens | Status |
|---|---|---|---|---:|---:|---|
| `luna_clerk` | `gpt-5.6-luna` | low | read-only | 40905 | 26952 | PASS |
| `terra_explorer` | `gpt-5.6-terra` | medium | read-only | 40942 | 27068 | PASS |
| `terra_worker` | `gpt-5.6-terra` | high | workspace-write | 41978 | 72379 | PASS |
| `sol_reviewer` | `gpt-5.6-sol` | high | read-only | 40855 | 56217 | PASS |
| `terra_ultra_specialist` | `gpt-5.6-terra` | ultra | workspace-write | 42092 | 28038 | PASS |
| `terra_max_worker` | `gpt-5.6-terra` | max | workspace-write | 42099 | 71546 | PASS |


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
