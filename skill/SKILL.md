---
name: taxpilot
description: |
  Compute an explainable, audit-ready US crypto tax report from a Binance
  account using the Binance Agent OS MCP server. Read-only: no trades, no
  transfers, no withdrawals. Produces Form 8949 rows (short-term + long-term),
  ordinary income, and a Tax Inbox of events that need the user's decision.
  Use for: "compute my crypto taxes", "generate my Form 8949 for 2025",
  "what's my capital gains from Binance last year", "show my unresolved tax
  events", "export a tax package for my accountant", "reconcile my Binance
  history for tax season". Never invents a valuation; flags anything it
  cannot value. Not tax advice.
metadata:
  author: taxpilot
  version: "1.0"
license: MIT
---

# TaxPilot Skill

Compute a US crypto tax report from a user's Binance account.

## When to Use This Skill

| User intent                                    | This skill?                                |
| ---------------------------------------------- | ------------------------------------------ |
| "What's my capital gains from Binance in 2025" | Yes                                        |
| "Generate my Form 8949"                        | Yes                                        |
| "Give me an audit-ready tax package"           | Yes                                        |
| "Which of my trades don't have cost basis"     | Yes — surface the Tax Inbox                |
| "Give me tax advice"                           | No — refuse and recommend a CPA            |
| "File my taxes for me"                         | No — refuse                                |
| "Sell some of my BTC"                          | No — this skill is read-only               |

## Hard Rules

1. **Read-only.** Only call the MCP tools listed in `references/tool-registry.md`. Never call any tool whose name starts with `create_`, `delete_`, `send_`, `place_`, `cancel_`, `borrow_`, or `withdraw_`.
2. **Never invent a valuation.** If an event has no USD value and no way to derive one (see `references/normalization.md` §Valuation), leave it out of totals and put it in the Tax Inbox with reason `MISSING_VALUATION`.
3. **Never guess ownership.** If a transfer/withdrawal/deposit has no `isInternal` signal, put it in the Tax Inbox with reason `OWNERSHIP_UNKNOWN` and ask the user before treating it as taxable or non-taxable.
4. **Never file or advise.** State clearly in the final output: *"TaxPilot provides estimates for educational purposes and is not tax or legal advice. Have a licensed professional review before filing."*
5. **Never store the user's OAuth token.** The MCP session already holds it. Do not print, log, or copy it.

## The Six-Step Workflow

Follow these steps in order. Each step names an artifact to produce so the workflow is resumable.

### STEP 1 — Confirm scope

Ask the user (once) for:
- **Tax year** (default 2025).
- **Jurisdiction** (default US; if anything else → refuse: "TaxPilot v1 supports US only").
- **Lot method** (default FIFO; refuse anything else in v1).
- **Sub-account id** if the user has more than one (otherwise leave unset).

Confirm the read-only scope before pulling anything: *"I will read your Binance trade, deposit, withdrawal, convert, transfer, and futures history. I will not place trades or move funds. Continue?"*

### STEP 2 — Pull history from every relevant Binance MCP tool

Call each tool in `references/tool-registry.md` **in parallel** with `startTime = Jan 1 of tax year` and `endTime = Dec 31 23:59:59 of tax year` when the tool accepts them. Also pull the full history for the previous 3 years if the user has no imported historical lots, so pre-year acquisitions get basis.

If a tool call fails, note it in the provenance but continue with the others. A partial pull is honest; a missing tool must be surfaced to the user as *"I could not read <category>; your report will be incomplete."*

Produce artifact: `raw_records` — one array per tool category, tagged with the category (`spot_trades`, `deposits`, `withdrawals`, `converts`, `transfers`, `futures_usds`, `futures_coin`, `margin_trades`, `margin_borrow_repay`).

### STEP 3 — Normalize

Follow `references/normalization.md` to map each raw record into a tax event `{ id, type, accountId, asset, quantity, usdValue, feeUsd, feeAsset, feeQuantity, timestamp, isSelfTransfer?, raw }`. Skip records that cannot be mapped and add them to a `skipped` list with a reason.

Produce artifact: `events` — one flat array, deduplicated by `id`/`txId`/`orderId`/`tradeId`.

### STEP 4 — Value

For each event without a `usdValue`:
1. If the trade is against a USD stablecoin (USDT/USDC/BUSD/FDUSD/TUSD/USDP/DAI/PYUSD), take the quote quantity as USD.
2. Otherwise, call the market-data MCP tool to fetch the **daily-close** price of `<asset>/USDT` (or `<asset>/USDC` as fallback) on the event's UTC date.
3. If neither works, leave `usdValue` unset and add the event to the Tax Inbox with reason `MISSING_VALUATION`. **Never invent.**

Record the valuation source (`event-time`, `daily-close-usdt`, `daily-close-usdc`, or `stablecoin-quote`) on every valued event.

### STEP 5 — Compute the report

Follow `references/tax-methodology.md`. Emit:
- `disposals[]` — Form 8949 rows, split into short-term and long-term by holding period
- `income[]` — ordinary income from rewards, staking, airdrops
- `transfers[]` — non-taxable self-transfers, with a note if the fee itself may be a disposition
- `unresolved[]` — the Tax Inbox
- `totals` — proceeds, basis, gains, losses, short-term net, long-term net, ordinary income
- `form8949` — `{ shortTerm[], longTerm[] }` with the exact column layout in `references/output-format.md`

### STEP 6 — Present and offer next actions

Show the user:
1. **Headline number** — net capital result and ordinary income.
2. **Confidence** — `resolved / total` events (100% only when Tax Inbox is empty).
3. **Tax Inbox** — one row per unresolved event with a suggested action verb (see `references/decision-verbs.md`).
4. **Downloads** — offer `form-8949.csv` and a full `audit-package.json`.
5. **Standing disclaimer** — the read-only + not-tax-advice line from Hard Rule 4.

If the user resolves an inbox item (e.g. "that BTC withdrawal was to my own hardware wallet"), record the decision using the verbs in `references/decision-verbs.md` and re-run STEP 5. Never re-run STEPS 2–4 for a decision change; only run them again if the tax year, account, or method changes, or on explicit user request.

## Refusal Templates

**Tax advice request:**
> "I can compute your numbers, but I'm not a licensed advisor. For anything beyond the mechanical FIFO calculation — the right lot method for your situation, whether an event is a wash sale, whether a hard fork is income — please ask a CPA or enrolled agent."

**Non-US jurisdiction:**
> "TaxPilot v1 encodes US Rev. Proc. 2024-28 and the Form 8949 layout. I can't produce an accurate report for other jurisdictions yet."

**Trade / transfer request:**
> "This skill is strictly read-only. To place a trade or move funds, use a trading skill and confirm each transaction explicitly."

## References

Read these before you compute:

- `references/tool-registry.md` — the exact Binance MCP tools to call
- `references/normalization.md` — raw-record → event field mapping
- `references/tax-methodology.md` — FIFO, holding period, wash-sale-out-of-scope, Rev. Proc. 2024-28
- `references/decision-verbs.md` — how to record user resolutions
- `references/output-format.md` — Form 8949 CSV column layout + audit package schema
