# Release evidence

This file is generated from `docs/release-evidence.json`. Manual edits fail
`npm run release:check`.

## Deterministic checks

- Generated: 2026-07-14T04:15:07.318Z
- Source manifest: `dc59d475e03c8c8ebd5e68ed1018f33ea101ea6670e67a8b7b0bb151adb6e636` (58 files)
- Tests: PASS (134/134)

## Runtime evidence

- Active installation: PASS; integrity pass; bridge disabled; fresh root `gpt-5.6-sol` / ultra
- Bound config state: `5ccfcec350d8` -> `5ccfcec350d8` (unchanged); policy `9892e7416cda`
- Six-role smoke: PASS (6/6), root metadata verified, commit `e4164b3bf06d`
- SDD adapter probe: PASS (terra_worker -> sol_reviewer), commit `e4164b3bf06d`
- Ten-question acceptance exam: PASS (10/10), active eligible: yes
- Acceptance execution shapes: `isolated_role_root`, `root_inline`, `typed_child`; runtime binding `b5c8926c9450`

| Role | Actual model | Effort | Sandbox | Parent tokens | Child tokens | Status |
|---|---|---|---|---:|---:|---|
| `luna_clerk` | `gpt-5.6-luna` | low | read-only | 40017 | 26462 | PASS |
| `terra_explorer` | `gpt-5.6-terra` | medium | read-only | 39919 | 26470 | PASS |
| `terra_worker` | `gpt-5.6-terra` | high | workspace-write | 40992 | 69404 | PASS |
| `sol_reviewer` | `gpt-5.6-sol` | high | read-only | 40156 | 40549 | PASS |
| `terra_ultra_specialist` | `gpt-5.6-terra` | ultra | workspace-write | 41059 | 41460 | PASS |
| `terra_max_worker` | `gpt-5.6-terra` | max | workspace-write | 41020 | 57742 | PASS |


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
