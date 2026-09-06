# Output Format

## Form 8949 CSV

```
Description,Date Acquired,Date Sold,Proceeds,Cost Basis,Adjustment Code,Adjustment Amount,Gain or Loss,Source Event ID
```

- **Description** — `"<quantity> <asset>"` (e.g. `"0.18 BTC"`)
- **Date Acquired** — the acquisition date if a single lot was consumed; `VARIOUS` when the disposal spans multiple lots
- **Date Sold** — UTC calendar date of the disposal
- **Proceeds** — 2-decimal USD
- **Cost Basis** — 2-decimal USD
- **Adjustment Code** — empty in v1 (wash-sale and other codes are out of scope)
- **Adjustment Amount** — `0` in v1
- **Gain or Loss** — 2-decimal USD, negative for losses
- **Source Event ID** — the canonical event `id` (traceable to `raw_records`)

Emit **two** CSVs (or one CSV with a `Term` column) — one for short-term rows,
one for long-term rows. Users file them on separate Form 8949 boxes.

## Audit package JSON

```json
{
  "generatedAt": "<ISO 8601>",
  "mode":        "live" | "demo",
  "snapshotId":  "<24-char content hash>",
  "policy":      { "jurisdiction": "US", "taxYear": 2025, "version": "2025.1", "defaultMethod": "FIFO", "sources": [ ... ] },
  "settings":    { "taxYear": 2025, "method": "FIFO", "accountScopedLots": true },
  "provenance":  {
    "endpoint":            "<MCP URL>",
    "connectedAt":         "<ISO 8601>",
    "historyTools":        [ "<tool names actually called>" ],
    "sourceBreakdown":     { "spot_trades": 42, "deposits": 3, ... },
    "recordCount":         50,
    "normalized":          48,
    "skipped":             [ { "code": "UNKNOWN_TYPE", "asset": null, "reason": "..." } ],
    "priced":              45,
    "unpriced":            [ ],
    "duplicatesRemoved":   0,
    "pagesFetched":        7,
    "pageLimitReached":    false,
    "warnings":            [ ],
    "complete":            true
  },
  "dispositions": [ ... ],
  "disposals":    [ ... ],
  "income":       [ ... ],
  "transfers":    [ ... ],
  "unresolved":   [ ... ],
  "audit":        [ { "eventId": "...", "action": "LOT_CREATED|DISPOSAL_CALCULATED|EXCLUDED", "rule": "..." } ],
  "form8949":     { "shortTerm": [ ... ], "longTerm": [ ... ] },
  "totals":       { "proceeds": 0, "basis": 0, "gains": 0, "capitalGains": 0, "capitalLosses": 0, "shortTermNet": 0, "longTermNet": 0, "ordinaryIncome": 0 }
}
```

The `snapshotId` is deterministic over `(policyVersion, engineVersion, taxYear, events, decisions, historicalLots)`. Two byte-identical inputs produce the same id — safe to cache and reference.

## Tax Inbox rows

```json
{
  "id":        "<event id>",
  "code":      "MISSING_BASIS | MISSING_VALUATION | OWNERSHIP_UNKNOWN | UNSUPPORTED_TYPE | INVALID_EVENT",
  "asset":     "BTC | ETH | ...",
  "timestamp": "<ISO 8601>",
  "reason":    "<one-sentence human explanation>"
}
```

## User-facing presentation guidelines

- Lead with the **headline number**: net capital result + ordinary income.
- Immediately follow with the **confidence percentage** and the **Tax Inbox count**. Never present a report as "complete" while the inbox is non-empty.
- For each Tax Inbox row, show the suggested decision verb from `decision-verbs.md` and offer a one-tap action.
- End with the standing disclaimer: *"TaxPilot provides estimates for educational purposes and is not tax or legal advice."*
- Offer the two exports: `form-8949.csv` and `audit-package.json`.
