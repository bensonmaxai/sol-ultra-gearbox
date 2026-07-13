# Real-work cost evidence

This ledger stores only sanitized, accepted evidence from comparable real work.
It does not store prompts, paths, messages, raw outputs, authentication data,
secrets, pricing, credits, or estimated savings.

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
