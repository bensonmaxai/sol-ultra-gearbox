# Workflow packaging review

This document records the durable packaging decisions. It is not runtime or
release evidence. The current public evidence is generated from
`docs/release-evidence.json` into `docs/RELEASE_EVIDENCE.md`; raw reports remain
local under ignored `reports/`.

## Current decisions

| Area | Decision | Reason |
|---|---|---|
| Typed roles | Keep six published roles | Clerk, explorer, normal worker, reviewer, Ultra specialist, and Max compatibility lane have distinct contracts |
| `terra_max_worker` | Explicit opt-in compatibility only | It must not become the default route or automatic escalation |
| Live smoke | Require a clean immutable runtime binding | A passing report is tied to commit, config, Codex version, role hashes, and runner hashes |
| Apply after smoke | Permit explicit trusted reuse for 30 minutes | Avoids a duplicate paid six-role run while failing closed on any drift |
| SDD adapter | Verify two sequential permission-matched phases | A workspace-write parent must not launch a reviewer that is supposed to be read-only |
| Release evidence | Generate JSON and Markdown together | Manual synchronization and hand-edited claims become detectable failures |
| Cost evidence | Accept real comparable work only | Smoke tokens are not a daily-work savings benchmark |
| Estimator | Keep unpublished before ten complete pairs | Price and savings claims need adequate evidence plus dated official pricing |
| Core hook | Out of scope | This repository cannot intercept Codex below the instruction layer |

## Verification boundary

Deterministic tests prove config rendering, role contracts, spawn argument
validation, evidence freshness, cost-ledger thresholds, and installer safety.
Paid runtime probes separately prove observed lineage, model, effort, sandbox,
depth, token metadata, filesystem scope, and temporary cleanup.

The SDD probe verifies the Gearbox adapter contract and artifact handoff. It
does not prove that every third-party workflow skill is intercepted, and it
does not change the Codex scheduler or `spawn_agent` implementation.

## Cost boundary

The local real-work ledger stores only accepted comparable pairs with duration,
rework count, and token breakdown by model. It rejects smoke records, prompts,
paths, raw outputs, and unknown fields. At ten complete pairs it reports only
that a dated estimate may be evaluated; pricing and savings remain a separate
future decision.
