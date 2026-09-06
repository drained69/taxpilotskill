# US Tax Methodology (v1: 2025 tax year)

TaxPilot v1 implements the mechanical FIFO calculation for US federal reporting.
Anything requiring judgment (wash sales across brokers, hard-fork character,
staking-as-service vs solo staking) is **out of scope** — surface it to the
user for a licensed professional.

## Policy version

```
jurisdiction:  US
taxYear:       2025
version:       2025.1
defaultMethod: FIFO
```

Sources encoded in the report policy block:

- Digital assets are property; sales and exchanges create gain or loss.
  https://www.irs.gov/filing/digital-assets
- Self-transfers are not dispositions; digital-asset-paid network fees may be.
  https://www.irs.gov/filing/digital-assets
- Rewards and staking are ordinary income at fair market value when received.
  https://www.irs.gov/filing/digital-assets
- Capital dispositions are reported on Form 8949 and Schedule D.
  https://www.irs.gov/forms-pubs/about-form-8949
- 2025 basis allocation is wallet/account specific under Rev. Proc. 2024-28.
  https://www.irs.gov/pub/irs-drop/rp-24-28.pdf

## FIFO with account-scoped lots

Lots are keyed by `(accountId, asset)`. This is the Rev. Proc. 2024-28 rule for
2025 onward — do not pool lots across accounts.

**Acquisition events** (`buy`, `reward`, `staking`, `airdrop`, `income`):
- Push a lot `{ id, quantity, unitCost, acquiredAt, basis }` to the queue for that `(accountId, asset)` key.
- For `buy`: `basis = usdValue + feeUsd`. Fees add to basis.
- For income events: `basis = usdValue` (the FMV at receipt is both the ordinary income and the new lot's basis).

**Disposal events** (`sell`, `convert`, `spend`, `fee`):
- Consume oldest-first from the queue until `remaining` reaches 0 or the queue is empty.
- Sum consumed basis into `basis`. Record which lots and quantities were used in `matchedLots`.
- `proceeds = max(0, usdValue - feeUsd)`. Fees subtract from proceeds.
- `gain = proceeds - basis`.
- If any `remaining` is left when the queue is empty, do NOT partially report. Add the entire disposal to Tax Inbox with reason `MISSING_BASIS` and note the missing quantity. It is excluded from totals.

**Transfers**:
- If `isSelfTransfer === true`: record in `transfers[]` with treatment `Non-taxable self-transfer`. If a fee was paid in the same asset, note it: `"Transfer fee may be a separate disposition."`
- If `isSelfTransfer === false`: treat as a disposal (proceeds = FMV at time of transfer) or acquisition (basis = FMV at time of receipt) depending on direction.
- If unknown: Tax Inbox with `OWNERSHIP_UNKNOWN`.

## Holding period

Long-term is > 1 year, using the "one day after acquisition" start rule per IRS Pub 544.

```
Let A = acquisition date
    D = disposal date
    A' = A + 1 day
    anniv = A' + 1 year
    term = (D >= anniv) ? 'long-term' : 'short-term'
```

If a disposal consumes lots with mixed holding periods, split the row so each
matched lot's contribution is reported under its own term. Practically: if
**any** matched lot is short-term, the row is short-term for reporting
purposes (the more conservative side); indicate `VARIOUS` in `dateAcquired`.

## Ordinary income

`reward`, `staking`, `airdrop`, and `income` events with a `usdValue` at receipt
are ordinary income in the year of receipt. Emit to `income[]` with
`ordinaryIncome = usdValue`, and record the category name:

| type       | Category label            |
| ---------- | ------------------------- |
| `staking`  | `Staking reward`          |
| `airdrop`  | `Airdrop`                 |
| `reward`   | `Other digital asset income` |
| `income`   | `Other digital asset income` |

If the event has no FMV, put it in the Tax Inbox with `MISSING_VALUATION`.
Do NOT default the value to 0.

## Out of scope for v1 (surface these to the user)

- Wash sales (§1091) — under active IRS/Treasury guidance for digital assets. Not enforced by this skill.
- Cost-basis method other than FIFO. If the user asks, refuse in v1: "Only FIFO is supported. Switching methods requires accountant advice on §1012 elections and Rev. Proc. 2024-28 §5."
- Non-US jurisdictions.
- Hard forks — flag events that look like a fork (`airdrop` with a novel asset) so the user can decide with an advisor whether it's ordinary income.
- Mining income (this skill covers exchange history, not on-chain mining rewards).
- Staking-as-a-service vs solo staking distinction — record all staking as ordinary income at receipt; leave the character question to an advisor.
- NFT ordinary-income vs capital treatment.

## Numeric hygiene

- Round every USD number to two decimals only at the **presentation layer**. Keep 8+ decimals internally.
- Compare quantities using an epsilon of `1e-10` (Binance quantities are strings; parse to number carefully).
- Never treat `0` as "missing" — a zero-value airdrop is a valid taxable event with income = $0 (report it, but note it in the audit trail).

## Totals to compute

```
proceeds        = sum(disposals[*].proceeds)
basis           = sum(disposals[*].basis)
gains           = sum(disposals[*].gain)                # can be negative
capitalGains    = sum(disposals[*].gain where > 0)
capitalLosses   = abs(sum(disposals[*].gain where < 0))
shortTermNet    = sum(disposals[*].gain where term = 'short-term')
longTermNet     = sum(disposals[*].gain where term = 'long-term')
ordinaryIncome  = sum(income[*].ordinaryIncome)
```

Unresolved events are **not** in totals. Confidence score = `resolved / total`
where `total` counts disposals + income + transfers + unresolved.
