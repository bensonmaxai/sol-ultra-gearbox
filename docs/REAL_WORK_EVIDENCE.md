# Real-work cost evidence

This evidence has two deliberately separate layers:

1. observed child runtime proves that typed roles were used and records only
   sanitized session, completion, policy, and token aggregates;
2. the paired ledger stores accepted, root-inclusive comparable work for a
   future A/B estimate.

Neither layer stores prompts, paths, thread identifiers, messages, raw outputs,
authentication data, secrets, pricing, credits, or estimated savings.

## Observed child runtime

Historical typed child sessions may be summarized in a local ignored
`real-work-usage.json` report. The public summary can include session and turn
counts, runtime-verified model and effort, `fork_turns`, nested-spawn counts,
policy acceptance or rejection, and aggregate child tokens by role.

This layer proves real usage, but it is child-only. It does not reconstruct the
Sol root cost, define task boundaries inside a long parent thread, or create a
`sol_single`/`gearbox` pair. Permission mismatches, spawn overrides, missing
metadata, or other gate failures remain visible and are not relabeled as
accepted Gearbox samples.

## Record contract

Every record must be a JSON object with exactly these fields:

- `kind`: exactly `real_work` (smoke records are rejected)
- `taskFamily` and `pairId`: safe identifiers used to form a comparable pair
- `variant`: exactly `sol_single` or `gearbox`
- `completed` and `accepted`: both `true`
- `durationMs`: nonnegative number
- `reworkCount`: nonnegative integer
- `tokens`: non-empty model map, where every model has nonnegative
  integer `uncachedInput`, `cachedInput`, and `output` values

Users must supply only real, accepted work. A complete pair has exactly one
accepted record for each variant with the same `taskFamily` and `pairId`.
Duplicate variants are rejected; incomplete pairs do not count toward the
threshold or aggregate comparison totals.

## CLI

Check status without writing or creating the default ledger:

```sh
node scripts/cost-evidence.mjs status [ledger-path]
```

Add one explicit JSON record to one explicit ledger path:

```sh
node scripts/cost-evidence.mjs add reports/cost-evidence.json record.json
```

The default status path is `reports/cost-evidence.json`, but a status call only
reads it when it exists. Add uses an atomic temporary-file rename.

## Threshold and pricing boundary

Before there are 10 complete real-work pairs, status returns
`eligibleForEstimate: false`. It never returns a savings, price, credit, or
cost-estimate field. At 10 complete pairs it returns eligibility plus aggregate
raw duration, rework, and token evidence only.

Dated official pricing must be collected and evaluated separately from this
ledger. Do not infer a current price or a savings claim from runtime evidence.
