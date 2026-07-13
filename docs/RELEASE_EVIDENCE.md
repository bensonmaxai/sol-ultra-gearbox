# Release evidence

This file records sanitized evidence for the initial public release. Raw smoke
reports remain local because they contain machine-specific paths.

## Environment

- Date: 2026-07-13
- Codex CLI: 0.144.2
- Node.js requirement: 20 or newer
- Root execution: Sol root; no in-task subagent was used to implement the
  release because the current task surface did not expose a typed `agent_type`
  parameter.

## Deterministic gates

| Gate | Result |
|---|---|
| Node unit tests | 18 passed, 0 failed |
| Gearbox doctor | PASS |
| Global apply dry-run | PASS; config and AGENTS unchanged |
| Release scanner | PASS |
| Official skill validator | PASS |
| Global skill install status | Managed and source hashes match |
| Fresh explicit `$sol-ultra-gearbox` invocation | `GEARBOX_SKILL_FORWARD_PASS` |
| Bash syntax check | PASS |
| Gitleaks 8.30.1 directory scan | No leaks found |

## Cost-bearing five-role smoke

The open-source candidate ran one sequential, no-retry smoke pass. Each parent
spawned exactly one typed child with `fork_turns="none"`; no parent supplied a
model, reasoning-effort, or service-tier override.

| Role | Actual model | Effort | Sandbox | Parent tokens | Child tokens | Result |
|---|---|---|---|---:|---:|---|
| `luna_clerk` | `gpt-5.6-luna` | low | read-only | 40,361 | 26,819 | PASS |
| `terra_explorer` | `gpt-5.6-terra` | medium | read-only | 40,323 | 27,225 | PASS |
| `terra_worker` | `gpt-5.6-terra` | high | workspace-write | 41,280 | 70,750 | PASS |
| `sol_reviewer` | `gpt-5.6-sol` | high | read-only | 40,471 | 41,402 | PASS |
| `terra_ultra_specialist` | `gpt-5.6-terra` | ultra | workspace-write | 41,838 | 42,462 | PASS |
| **Total** |  |  |  | **204,273** | **208,658** | **PASS** |

Every role also passed persisted lineage, exact runtime identity, depth 1, no
descendant spawn, expected marker, and filesystem-scope checks. The real global
config contents were identical before and after the isolated smoke.

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
