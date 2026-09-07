# Tax Methodology

TaxPilot implements the mechanical FIFO calculation for each supported
jurisdiction. Anything requiring judgment (wash sales across brokers,
hard-fork character, staking-as-service vs solo staking, the correct
NGN/USD reference rate for a given disposal date) is **out of scope** —
surface it to the user for a licensed professional.

This document has one section per supported jurisdiction. Apply the section
matching the user's chosen jurisdiction (`US` or `NG`).

---

## Section A — United States

### Policy version

```
jurisdiction:  US
taxYear:       2025
version:       2025.1
defaultMethod: FIFO
filingForm:    Form 8949 + Schedule D
```

### Sources encoded in the report policy block

- Digital assets are property; sales and exchanges create gain or loss. — https://www.irs.gov/filing/digital-assets
- Self-transfers are not dispositions; digital-asset-paid network fees may be. — https://www.irs.gov/filing/digital-assets
- Rewards and staking are ordinary income at fair market value when received. — https://www.irs.gov/filing/digital-assets
- Capital dispositions are reported on Form 8949 and Schedule D. — https://www.irs.gov/forms-pubs/about-form-8949
- 2025 basis allocation is wallet/account specific under Rev. Proc. 2024-28. — https://www.irs.gov/pub/irs-drop/rp-24-28.pdf

### FIFO with account-scoped lots

Lots are keyed by `(accountId, asset)`. This is the Rev. Proc. 2024-28 rule
for 2025 onward — do not pool lots across accounts.

**Acquisition events** (`buy`, `reward`, `staking`, `airdrop`, `income`):
- Push a lot `{ id, quantity, unitCost, acquiredAt, basis }` to the queue for that `(accountId, asset)` key.
- For `buy`: `basis = usdValue + feeUsd`. Fees add to basis.
- For income events: `basis = usdValue` — the FMV at receipt is both the ordinary income and the new lot's basis.

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

### Holding period

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

### Ordinary income (US)

`reward`, `staking`, `airdrop`, and `income` events with a `usdValue` at
receipt are ordinary income in the year of receipt. Emit to `income[]` with
`ordinaryIncome = usdValue`, and record the category label:

| type       | Category label               |
| ---------- | ---------------------------- |
| `staking`  | `Staking reward`             |
| `airdrop`  | `Airdrop`                    |
| `reward`   | `Other digital asset income` |
| `income`   | `Other digital asset income` |

If the event has no FMV, put it in the Tax Inbox with `MISSING_VALUATION`.
Do NOT default the value to 0.

### Out of scope for US v1 (surface to the user)

- Wash sales (§1091) — under active IRS/Treasury guidance for digital assets. Not enforced by this skill.
- Cost-basis method other than FIFO. If the user asks, refuse: *"Only FIFO is supported. Switching methods requires accountant advice on §1012 elections and Rev. Proc. 2024-28 §5."*
- Hard forks — flag events that look like a fork (`airdrop` with a novel asset) so the user can decide with an advisor whether the character is ordinary income or capital.
- Mining income (this skill covers exchange history, not on-chain mining rewards).
- Staking-as-a-service vs solo staking distinction — record all staking as ordinary income at receipt; leave the character question to an advisor.
- NFT ordinary-income vs capital treatment.
- State-level tax. This skill computes federal only; most conforming states adopt the federal capital-gains character.

---

## Section B — Nigeria

### Policy version

```
jurisdiction:  NG
taxYear:       2025
version:       2025.1
defaultMethod: FIFO
filingForm:    FIRS Capital Gains Tax return
capitalGainsRate: 10%
```

### Sources encoded in the report policy block

- Finance Act 2023 introduced Capital Gains Tax on the disposal of digital assets, effective 1 September 2023. — https://firs.gov.ng/finance-act-2023/
- Digital assets are chargeable assets; disposals attract 10% Capital Gains Tax. — https://firs.gov.ng/finance-act-2023/
- Companies are also subject to CGT on digital asset gains under the Capital Gains Tax Act (Cap. C1 LFN 2004). — https://firs.gov.ng/
- Staking, airdrops, and other rewards are typically Personal Income Tax at the user's applicable PIT rate (7% – 24%). — https://firs.gov.ng/
- PwC Nigeria — Finance Act 2023 summary. — https://www.pwc.com/ng/en/publications/finance-act-2023.html

### FIFO with account-scoped lots

Same acquisition, disposal, and transfer rules as US Section A. Lots are
still keyed by `(accountId, asset)` — Nigerian law does not require this,
but per-account FIFO is a strict superset of asset-level FIFO and preserves
audit clarity when the user has multiple sub-accounts.

### No holding-period distinction

Nigeria applies **one flat 10% CGT rate** to every digital-asset disposal
regardless of how long the asset was held. Do not compute short-term vs
long-term totals. The report omits `shortTermNet` and `longTermNet` for NG.

### Losses

- Losses within the same tax year may offset gains for that year.
- Excess losses do not generate a refund at the 10% rate. Per FIRS practice
  they may be carried forward — **the user must confirm this with their
  advisor**; TaxPilot flags remaining losses in the summary and does not
  assume a carryforward.
- `estimatedTaxOwed = 10% × max(0, netGain)`. If net position is a loss,
  estimated tax owed is $0.

### Ordinary income (NG)

Staking, airdrop, reward, and other income events are **not** CGT — they
belong to the Nigerian Personal Income Tax at the user's bracket (7% – 24%
under PITA). TaxPilot:
- Records these events in `income[]` with `ordinaryIncome = usdValue`.
- Reports the total to the user, converted to NGN if a rate is provided.
- Does **not** compute the PIT owed — the bracket is user-specific.
- Emits a disclosure line in the NG summary:
  > *"Ordinary income (staking, airdrops, rewards) is subject to Personal Income Tax at your bracket rate (7% – 24%). TaxPilot does not estimate PIT — apply your bracket externally."*

### NGN reporting

- All valuations are computed in USD, then converted to NGN at presentation
  using the `usdToLocalRate` supplied by the user.
- If no rate is supplied, TaxPilot displays USD only and prompts the user
  once for a rate to add NGN figures.
- The FIRS return must be filed in NGN. Apply the exchange rate on each
  disposal date for maximum accuracy; a single annual average is acceptable
  only for a rough estimate and is disclosed as such in the summary.

### Out of scope for NG v1 (surface to the user)

- **The correct NGN/USD reference rate for a given disposal date.** TaxPilot uses whatever rate the user provides. FIRS practice is evolving — the user's advisor should confirm which rate FIRS accepts (CBN official, NAFEM window, or documented exchange rate on the disposal date).
- **Excess-loss carryforward.** Whether unused losses at the 10% rate carry to the next year is a matter of FIRS practice and the user's specific facts. TaxPilot flags remaining losses; the user's advisor decides the carryforward treatment.
- **Personal Income Tax computation.** Individual PIT brackets (7% – 24%) and reliefs are not computed by this skill; only the ordinary-income total is reported.
- **Business income vs investment income character.** If the user's activity is a trade or business, the character (and rate) can differ. TaxPilot treats every disposal as a capital disposal; the user's advisor confirms the character.
- **Cost-basis methods other than FIFO.**

---

## Section C — Numeric hygiene (all jurisdictions)

- Round every currency number to two decimals only at the **presentation layer**. Keep 8+ decimals internally.
- Compare quantities using an epsilon of `1e-10` (Binance quantities are strings; parse to number carefully).
- Never treat `0` as "missing" — a zero-value airdrop is a valid taxable event with income = $0 (report it, but note it in the audit trail).
- FX conversion (NG only): USD × `usdToLocalRate` = NGN. Do not chain FX conversions; convert once, at the presentation layer, from the USD ledger.

---

## Section D — Totals to compute

```
proceeds        = sum(disposals[*].proceeds)
basis           = sum(disposals[*].basis)
gains           = sum(disposals[*].gain)                # can be negative
capitalGains    = sum(disposals[*].gain where > 0)
capitalLosses   = abs(sum(disposals[*].gain where < 0))
ordinaryIncome  = sum(income[*].ordinaryIncome)

# US only
shortTermNet    = sum(disposals[*].gain where term = 'short-term')
longTermNet     = sum(disposals[*].gain where term = 'long-term')

# NG only
taxableCapitalGain = max(0, gains)
estimatedCgtUsd    = round(taxableCapitalGain × 0.10, 2)
estimatedCgtNgn    = (usdToLocalRate ? round(estimatedCgtUsd × usdToLocalRate, 2) : null)
```

Unresolved events are **not** in totals. Confidence score = `resolved / total`
where `total` counts disposals + income + transfers + unresolved.
