# Decision Verbs (Tax Inbox)

When a user resolves an item in the Tax Inbox, record the decision with **one**
of these verbs. Re-run the tax engine on the same event stream with the new
decision applied. Do not re-pull history.

## Verbs

| Verb                         | Applies to                        | Effect                                                                              |
| ---------------------------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| `confirm_self_transfer`      | `OWNERSHIP_UNKNOWN`               | Set `isSelfTransfer = true` on the event. Becomes non-taxable transfer.             |
| `confirm_external_transfer`  | `OWNERSHIP_UNKNOWN`               | Reclassify as `sell` at fair-market value (`usdValue`). Becomes a taxable disposal. |
| `set_basis`                  | `MISSING_BASIS` (on an acquisition or unresolved disposal) | Attach `usdValue` (and optional `feeUsd`) to the event. |
| `set_income`                 | `MISSING_VALUATION` on a reward/staking/airdrop | Attach `usdValue` at receipt and reclassify to the given `incomeType`.       |
| `ignore`                     | any                               | Drop the event from the stream. Use sparingly — the audit trail retains the record. |

## Decision record shape

```json
{
  "eventId":   "<same as event.id>",
  "action":    "confirm_self_transfer" | "confirm_external_transfer" | "set_basis" | "set_income" | "ignore",
  "usdValue":  <number, required for set_basis/set_income and optional for confirm_external_transfer>,
  "feeUsd":    <number, optional, for set_basis only>,
  "incomeType":"reward" | "staking" | "airdrop" | "income"  (set_income only),
  "note":      "<up to 500 chars, free text for audit>",
  "updatedAt": "<ISO 8601 UTC>"
}
```

## Suggested action per inbox code

| Inbox code           | Default suggestion         | Ask the user for                       |
| -------------------- | -------------------------- | -------------------------------------- |
| `MISSING_BASIS`      | `set_basis`                | acquisition USD value                  |
| `MISSING_VALUATION`  | `set_income`               | FMV at receipt + income category       |
| `OWNERSHIP_UNKNOWN`  | ask user first             | "was the destination your own wallet?" |
| `UNSUPPORTED_TYPE`   | `ignore` (with visible note) | confirmation to skip                  |
| `INVALID_EVENT`      | `ignore`                   | nothing — the event is malformed       |

## Prompt templates

**MISSING_BASIS:**
> "You disposed of {quantity} {asset} on {date}, but I don't have a matching acquisition. What was your cost basis in USD? (If you bought it before Binance, this is the price you paid at that other venue.)"

**MISSING_VALUATION:**
> "You received {quantity} {asset} on {date} as a {reward/airdrop/etc}. What was the fair market value in USD at that moment? (Check the Binance transaction history or a public price at the timestamp.)"

**OWNERSHIP_UNKNOWN (withdrawal):**
> "You withdrew {quantity} {asset} on {date}. Did it go to another wallet you own (e.g. a hardware wallet), or was this a payment / sale to someone else?"

## Idempotency

- Two decisions with the same `eventId` — the newer one replaces the older.
- Storing a decision does not immediately mutate the report. The next
  computation applies all current decisions in one pass.
- Decisions persist across syncs. If a re-sync surfaces the same event, its
  existing decision is re-applied. If the event disappears (e.g. Binance
  changed the id), the decision becomes orphaned and should be surfaced to
  the user for cleanup.

## What NOT to record as a decision

- **Never** invent a `set_basis` or `set_income` value the user did not
  explicitly supply. Always ask.
- **Never** silently `ignore` an `OWNERSHIP_UNKNOWN` — that would treat a
  potential taxable withdrawal as gone from the report.
- **Never** record a decision without a note when the user asked to do
  something ambiguous — write down what they said.
