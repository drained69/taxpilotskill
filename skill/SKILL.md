---
name: taxpilot
description: |
  Compute an explainable, audit-ready crypto tax report from Binance activity.
  Read-only: no trades, no transfers, no withdrawals. Currently supports the
  United States (Form 8949 + Schedule D, per-wallet FIFO, Rev. Proc. 2024-28)
  and Nigeria (FIRS Capital Gains Tax return, 10% flat CGT, Finance Act 2023).
  Use for: "compute my crypto taxes", "generate my Form 8949 for 2025", "what
  is my Nigerian CGT on my Binance trades", "show my unresolved tax events",
  "export a tax package for my accountant", "reconcile my Binance history for
  tax season". Never invents a valuation; flags anything it cannot value.
  Not tax advice.
metadata:
  author: taxpilot
  version: "1.1"
license: MIT
---

# TaxPilot Skill

Compute a jurisdiction-specific crypto tax report from a user's Binance
activity. The user supplies a CSV export from Binance (or, where the Binance
Agent OS MCP server is authenticated, the skill can pull history directly
through the read-only tools listed in `references/tool-registry.md`).

## When to Use This Skill

| User intent                                          | This skill?                            |
| ---------------------------------------------------- | -------------------------------------- |
| "What are my capital gains from Binance in 2025"     | Yes                                    |
| "Generate my Form 8949"                              | Yes — US jurisdiction                  |
| "Compute my Nigerian CGT on my Binance trades"       | Yes — NG jurisdiction                  |
| "Give me an audit-ready tax package"                 | Yes                                    |
| "Which of my trades don't have cost basis"           | Yes — surface the Tax Inbox            |
| "Give me tax advice"                                 | No — refuse and recommend a CPA        |
| "File my taxes for me"                               | No — refuse                            |
| "Sell some of my BTC"                                | No — this skill is read-only           |

## Hard Rules

1. **Read-only.** Only call the MCP tools listed in `references/tool-registry.md`. Never call any tool whose name starts with `create_`, `delete_`, `send_`, `place_`, `cancel_`, `borrow_`, or `withdraw_`.
2. **Never invent a valuation.** If an event has no USD value and no way to derive one (see `references/normalization.md` §Valuation), leave it out of totals and put it in the Tax Inbox with reason `MISSING_VALUATION`.
3. **Never guess ownership.** If a transfer/withdrawal/deposit has no `isInternal` signal, put it in the Tax Inbox with reason `OWNERSHIP_UNKNOWN` and ask the user before treating it as taxable or non-taxable.
4. **Never file or advise.** State clearly in the final output: *"TaxPilot provides estimates for educational purposes and is not tax or legal advice. Have a licensed professional review before filing."*
5. **Never store credentials.** Any authenticated MCP session already holds them. Do not print, log, or copy access tokens or session identifiers.
6. **Jurisdictional accuracy.** Every report carries a `policy` block naming the jurisdiction, tax year, policy version, and every rule source used. Users must be able to trace a number back to its rule.

## The Six-Step Workflow

Follow these steps in order. Each step names an artifact to produce so the workflow is resumable.

### STEP 1 — Confirm scope

Ask the user (once) for:
- **Tax year** (default 2025).
- **Jurisdiction.** Accept `US` or `NG`. Refuse any other value:
  > "TaxPilot currently supports United States (Form 8949 + Schedule D) and Nigeria (FIRS Capital Gains Tax). For other jurisdictions I cannot produce an accurate report yet."
- **Lot method** (default FIFO; refuse anything else in this version).
- **Sub-account id** if the user has more than one (otherwise leave unset).
- **NGN/USD rate** — for `NG` only. If the user provides a per-disposal-date rate table, prefer it; otherwise a single annual average is acceptable for a rough estimate but must be disclosed as an approximation in the final summary.

Confirm the read-only scope before pulling anything:
> "I will read your Binance trade, deposit, withdrawal, convert, transfer, futures, and margin history — either from a CSV you upload or through the read-only Binance Agent OS MCP tools. I will not place trades or move funds. Continue?"

### STEP 2 — Ingest history

Choose one path based on what the user provides:

**Path A — CSV upload (primary).** The user drops one or more Binance CSV exports into the agent's context. Parse each file with the header-alias table in `references/normalization.md`. Tag every row with the source filename and category.

**Path B — Binance Agent OS MCP.** Where the Binance MCP server is authenticated in the current agent session, call each tool in `references/tool-registry.md` in parallel with `startTime = Jan 1 of tax year` and `endTime = Dec 31 23:59:59 of tax year`. Also pull the full history for the previous three years if the user has no imported historical lots, so pre-year acquisitions establish basis.

A tool call failure is recorded in provenance and the workflow continues. A missing tool is surfaced to the user as *"I could not read <category>; your report will be incomplete."*

Produce artifact: `raw_records` — one array per category (`spot_trades`, `deposits`, `withdrawals`, `converts`, `transfers`, `futures_usds`, `futures_coin`, `margin_trades`, `margin_borrow_repay`).

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

Follow `references/tax-methodology.md`. The methodology reference has one section per supported jurisdiction; apply the section matching the user's chosen jurisdiction. Emit:

- `disposals[]` — matched disposals with FIFO basis. For **US**, split into short-term and long-term by holding period. For **NG**, a single flat list — Nigerian CGT applies one rate regardless of holding period.
- `income[]` — ordinary income from rewards, staking, airdrops (**US** federal ordinary income; **NG** Personal Income Tax — flagged for the user's PIT bracket, not computed by this skill).
- `transfers[]` — non-taxable self-transfers, with a note if the fee itself may be a disposition.
- `unresolved[]` — the Tax Inbox.
- `totals` — proceeds, basis, gains, losses, short-term net, long-term net, ordinary income.
- `form8949` (US only) — `{ shortTerm[], longTerm[] }` with the exact column layout in `references/output-format.md`.
- `firsSummary` (NG only) — taxable capital gain, estimated 10% CGT owed in USD and (when a rate is provided) NGN, and the PIT-owed disclosure line.

### STEP 6 — Present and offer next actions

Show the user:
1. **Headline** — net capital result and ordinary income (plus estimated CGT owed for NG).
2. **Confidence** — `resolved / total` events (100% only when Tax Inbox is empty).
3. **Tax Inbox** — one row per unresolved event with a suggested action verb (see `references/decision-verbs.md`).
4. **Downloads** — for US, offer `form-8949.csv`. For every jurisdiction, offer a full `audit-package.json` containing the policy block, per-disposal lot matching, and provenance for every valuation.
5. **Standing disclaimer** — the not-tax-advice line from Hard Rule 4.

If the user resolves an inbox item (e.g. *"that BTC withdrawal was to my own hardware wallet"*), record the decision using the verbs in `references/decision-verbs.md` and re-run STEP 5. Do not re-run STEPS 2–4 for a decision change; run them again only if the tax year, account, jurisdiction, or method changes, or on explicit user request.

## Refusal Templates

**Tax advice request:**
> "I can compute your numbers, but I am not a licensed advisor. For anything beyond the mechanical FIFO calculation — the right lot method for your situation, whether an event is a wash sale, whether a hard fork is income, whether a self-transfer to a custodial wallet is a disposition — please consult a CPA, enrolled agent, or your local tax authority."

**Unsupported jurisdiction:**
> "TaxPilot currently supports United States (Form 8949 + Schedule D) and Nigeria (FIRS Capital Gains Tax return). I cannot produce an accurate report for other jurisdictions yet."

**Trade / transfer request:**
> "This skill is strictly read-only. To place a trade or move funds, use a trading skill and confirm each transaction explicitly."

## References

Read these before you compute:

- `references/tool-registry.md` — the exact Binance MCP tools to call
- `references/normalization.md` — raw-record → event field mapping
- `references/tax-methodology.md` — per-jurisdiction rules: US (FIFO, Rev. Proc. 2024-28, holding period, out-of-scope items) and NG (10% CGT, Finance Act 2023, PIT-owed disclosure)
- `references/decision-verbs.md` — how to record user resolutions
- `references/output-format.md` — Form 8949 CSV column layout + audit package schema
