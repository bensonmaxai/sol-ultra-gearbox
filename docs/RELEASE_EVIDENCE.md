# Release evidence

This file is generated from `docs/release-evidence.json`. Manual edits fail
`npm run release:check`.

## Deterministic checks

- Generated: 2026-07-17T19:47:43.168Z
- Source manifest: `70d664252e2b3b1b3e2610067ddb0fc2639f7e16bbbf9eaeddc9c8c1c124af39` (95 files)
- Tests: PASS (285/285)
- Verified workflow contract: PASS (5/5); Q10 canary: verified

## Runtime evidence

- Active installation: PASS; integrity pass; bridge disabled; fresh root `gpt-5.6-sol` / ultra
- Bound config state: `8b09cf731818` -> `8b09cf731818` (unchanged); policy `3dbd99765f49`
- Six-role smoke: PASS (6/6), root metadata verified, commit `ef411c252176`
- Writing-skills pressure test: PASS (5 RED, 5 GREEN), isolated role `sol_skill_tester`
- SDD adapter probe: PASS (terra_worker -> sol_reviewer), commit `ef411c252176`
- Ten-question acceptance exam: PASS (10/10), active eligible: yes
- Acceptance execution shapes: `isolated_role_root`, `root_inline`, `typed_child`; runtime binding `5a96f8aecfa6`
- App Server root launcher: PASS; `gpt-5.6-sol` / low; fixed smoke bound; persisted rollout reverified; scope verified; lifecycle closed

| Role | Actual model | Effort | Sandbox | Parent tokens | Child tokens | Status |
|---|---|---|---|---:|---:|---|
| `luna_clerk` | `gpt-5.6-luna` | low | read-only | 42906 | 27792 | PASS |
| `terra_explorer` | `gpt-5.6-terra` | medium | read-only | 42906 | 28441 | PASS |
| `terra_worker` | `gpt-5.6-terra` | high | workspace-write | 44037 | 74016 | PASS |
| `sol_reviewer` | `gpt-5.6-sol` | high | read-only | 43166 | 58555 | PASS |
| `terra_ultra_specialist` | `gpt-5.6-terra` | ultra | workspace-write | 43998 | 44439 | PASS |
| `terra_max_worker` | `gpt-5.6-terra` | max | workspace-write | 43953 | 77040 | PASS |


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
