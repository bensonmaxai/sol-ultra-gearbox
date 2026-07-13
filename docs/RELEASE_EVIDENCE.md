# Release evidence

This file records sanitized evidence for the current public release candidate.
Raw smoke reports remain local because they contain machine-specific paths.

## Environment

- Date: 2026-07-13
- Codex CLI: 0.144.2
- Node.js requirement: 20 or newer
- Release-maintenance root: `gpt-5.6-sol` with `ultra` effort,
  `workspace-write` sandbox, and `on-request` approval, verified from persisted
  rollout metadata. The task made zero `spawn_agent` calls.

## Deterministic gates

| Gate | Result |
|---|---|
| Node unit tests | 23 passed, 0 failed |
| Gearbox doctor | PASS |
| Global apply dry-run | PASS; config unchanged; managed AGENTS block would update |
| Managed global apply | PASS; six-role smoke and fresh-root smoke passed |
| Release scanner | PASS |
| Official skill validator | PASS |
| Global skill install status | Managed and source hashes match |
| Fresh explicit `$sol-ultra-gearbox` invocation | `GEARBOX_SKILL_FORWARD_PASS` |
| Bash syntax check | PASS |
| Gitleaks 8.30.1 directory scan | No leaks found |

## Cost-bearing six-role smoke

The open-source candidate ran one sequential, no-retry smoke pass on
2026-07-13. Each parent used persisted `gpt-5.6-sol` / `max` runtime metadata
and spawned exactly one typed child with `fork_turns="none"`; no parent supplied
the child model, reasoning-effort, or service-tier override.

| Role | Actual model | Effort | Sandbox | Parent tokens | Child tokens | Result |
|---|---|---|---|---:|---:|---|
| `luna_clerk` | `gpt-5.6-luna` | low | read-only | 40,387 | 40,724 | PASS |
| `terra_explorer` | `gpt-5.6-terra` | medium | read-only | 39,955 | 26,468 | PASS |
| `terra_worker` | `gpt-5.6-terra` | high | workspace-write | 41,389 | 88,636 | PASS |
| `sol_reviewer` | `gpt-5.6-sol` | high | read-only | 54,398 | 41,049 | PASS |
| `terra_ultra_specialist` | `gpt-5.6-terra` | ultra | workspace-write | 41,982 | 42,684 | PASS |
| `terra_max_worker` | `gpt-5.6-terra` | max | workspace-write | 41,985 | 42,641 | PASS |
| **Total** |  |  |  | **260,096** | **282,202** | **PASS** |

Every role also passed persisted lineage, exact parent and child runtime
identity, depth 1, no descendant spawn, expected marker, filesystem scope, and
temporary-artifact cleanup. The real global config contents were identical
before and after the isolated smoke.

The managed apply then updated the global AGENTS block, installed all six role
files and the launcher, passed post-install static checks, and passed a fresh
root smoke. File hashes matched the rollback manifest after installation.

## Model-routing correction

The bundled skill now distinguishes Sol Max single-root reasoning from Sol
Ultra parallel orchestration and includes a complete work-to-model routing
matrix. `terra_max_worker` is documented as an explicit opt-in compatibility
role rather than an automatic upgrade from `terra_worker`.

The 2026-07-13 local catalog reported Low through Ultra for Sol and Terra, and
Low through Max for Luna. Gearbox doctor statically validates all six role
profiles. The six-role smoke above additionally verifies `terra_max_worker` as
`gpt-5.6-terra` / `max` at runtime.

## Deliberate exclusions

- Scheduler, batch-runner, Meta reconciliation, and execute-intent controls are
  not part of this repository and were not represented as Gearbox risks.
- Raw reports, auth state, complete config files, prompts, and rollout contents
  are not published.
- Credit prices are not embedded in runtime evidence because rates can change;
  calculate costs from dated official pricing and the persisted token counts.

## Remaining limits

- The tested multi-agent surface is experimental and may change after a Codex
  update.
- A successful isolated CLI role probe does not prove that an already-open
  Desktop task has refreshed its tool schema.
- Long-term savings still require comparable evidence from real work, including
  completion rate, latency, and rework.
