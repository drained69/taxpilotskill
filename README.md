# TaxPilot

**Explainable, read-only crypto tax intelligence for [Binance Agent OS](https://www.binance.com/en-NG/agent-os).**

TaxPilot turns a user's raw Binance activity into an audit-ready crypto tax
report. Every number on the final report can be traced back to a source
transaction; every ambiguous event surfaces as a human-reviewable decision
rather than a silent assumption.

TaxPilot ships as an **MIT-licensed, MCP-native skill** for the
[Binance Skills Hub](https://www.binance.com/en/skills). It runs inside any
MCP-capable agent (Claude, Cursor, or a custom MCP client) on the Binance
CSV the user drops into the agent's context. No account is connected. No
credentials are shared. No network calls are made from user code to Binance.

The tax methodology lives in a pure, deterministic engine in
[`src/tax-engine.js`](src/tax-engine.js) — same inputs, identical output —
covered end-to-end by an automated test suite.

---

## Jurisdictions supported

| Jurisdiction  | Filing reference                     | Method                             | Rate                                                | Primary legal source                                                                 |
| ------------- | ------------------------------------ | ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| United States | Form 8949 + Schedule D               | Per-wallet FIFO (Rev. Proc. 2024-28) | Short-term vs long-term at user's federal bracket | [IRS Digital Assets](https://www.irs.gov/filing/digital-assets), [Rev. Proc. 2024-28](https://www.irs.gov/pub/irs-drop/rp-24-28.pdf) |
| Nigeria       | FIRS Capital Gains Tax return        | Per-wallet FIFO                      | 10% flat CGT on net gain                            | [Finance Act 2023 (FIRS)](https://firs.gov.ng/finance-act-2023/)                     |

Both jurisdictions share the same normalization, valuation, and FIFO
matching engine — only the reporting layer (holding period split, tax rate,
filing form, disclosure notes) differs. Every generated report includes a
`policy` block that names the jurisdiction, tax year, policy version, and
the rule sources applied.

Additional jurisdictions are gated on written policy sign-off with a
licensed practitioner in that jurisdiction; TaxPilot refuses to compute for
any unsupported region.

---

## How the workflow runs

```
Binance CSV
    │
    ▼
┌──────────────────────────────────────────────────────────────────┐
│  1. Parse         csv-import.js  →  typed records                │
│  2. Normalize     normalize.js   →  canonical tax events         │
│  3. Value         pricing.js     →  USD FMV per event            │
│  4. Compute       tax-engine.js  →  disposals · income · totals  │
│  5. Human review  decision verbs →  resolve unresolved events    │
│  6. Export        reports.js     →  Form 8949 / FIRS summary     │
└──────────────────────────────────────────────────────────────────┘
```

Steps 1 – 6 run inside the user's agent session. The skill exposes only
read verbs to the host MCP client (`parse`, `normalize`, `value`, `match`,
`export`); no write, sign, trade, transfer, or approval tool exists. The
same CSV plus the same set of user decisions is guaranteed to produce the
same report — snapshot IDs are deterministic over the inputs (see
[`src/reports.js`](src/reports.js)).

---

## Repository layout

```
skill/                   MIT-licensed MCP skill package
├── SKILL.md             skill contract, workflow, refusal templates
├── SUBMISSION.md        Binance Skills Hub publishing steps
└── references/
    ├── tool-registry.md         allowlisted Binance MCP tools
    ├── normalization.md         raw record → tax event mapping
    ├── tax-methodology.md       US (§A) and NG (§B) rules
    ├── decision-verbs.md        how user resolutions are recorded
    └── output-format.md         Form 8949 CSV + audit-package schema

src/
├── tax-engine.js        deterministic FIFO engine; US + NG policies
├── normalize.js         Binance record → canonical event adapter
├── csv-import.js        Binance CSV parser (header aliases)
├── pricing.js           historical USD valuation
├── reports.js           snapshot IDs · decision replay · lot merger
└── mcp-client.js        MCP JSON-RPC client (Streamable HTTP)

test/                    automated tests for every module above
```

---

## Installation

**Prerequisites**

- Node.js 22 or higher (developed on Node 22+)
- Git
- An MCP-capable agent — Claude Code, Claude Desktop, Cursor, or a custom
  MCP client

**1. Clone and install**

```bash
git clone https://github.com/<owner>/binance-taxpilot.git
cd binance-taxpilot
npm install
npm test
```

**2. Register the skill with your agent**

The skill lives in `skill/` and is self-contained (SKILL.md + references/).
For Claude Code:

```bash
mkdir -p ~/.claude/skills
ln -s "$(pwd)/skill" ~/.claude/skills/taxpilot
```

Restart the agent. Confirm the skill is discovered (`/skills` in Claude
Code lists `taxpilot`).

For other MCP clients, point the client at the `skill/` directory as its
skill root, or publish to the Binance Skills Hub and install via the hub's
own tooling — see [`skill/SUBMISSION.md`](skill/SUBMISSION.md) for the
fork → branch → PR flow.

---

## Usage

**1. Export activity from Binance**

In the Binance web interface: **Wallet → Transaction History → Export
Statement**. Select the tax year and the categories relevant to the user
(spot trades, converts, universal transfers, deposits, withdrawals,
futures, margin, rewards).

**2. Attach the CSV and ask the agent**

Attach the CSV file to the agent conversation. Then:

```
Run TaxPilot on this. Jurisdiction: US. Tax year: 2025.
```

or, for Nigerian filers:

```
Run TaxPilot on this. Jurisdiction: NG. Tax year: 2025. NGN rate: 1600.
```

**3. Review the Tax Inbox**

TaxPilot flags every event it cannot resolve unambiguously — missing cost
basis, ambiguous transfers, unvalued rewards — and asks the user to decide.
Decisions are recorded via the verbs in
[`skill/references/decision-verbs.md`](skill/references/decision-verbs.md)
and are persisted with the report snapshot.

**4. Re-run and export**

Ask the agent to re-run after resolving inbox items. Because the report is
deterministic, the same CSV plus the same decisions always produces the
same output. Export:

- **US** — `form-8949.csv` and `audit-package.json`
- **NG** — `firs-summary.json` and `audit-package.json`

Both include the policy block, per-disposal lot matching, and provenance
for every valuation.

---

## Methodology

The full per-jurisdiction rule set is documented in
[`skill/references/tax-methodology.md`](skill/references/tax-methodology.md).
Highlights:

**United States**

- Digital assets are property (IRS Notice 2014-21, reaffirmed at
  [IRS Digital Assets](https://www.irs.gov/filing/digital-assets)).
- Per-wallet FIFO lot accounting under
  [Rev. Proc. 2024-28](https://www.irs.gov/pub/irs-drop/rp-24-28.pdf) —
  lots keyed by `(accountId, asset)`; TaxPilot does not pool lots across
  accounts.
- Holding period per IRS Pub 544 "one day after acquisition" rule.
- Ordinary income (staking, airdrops, rewards) recognized at FMV on
  receipt.
- Reported on [Form 8949](https://www.irs.gov/forms-pubs/about-form-8949)
  + Schedule D.

**Nigeria**

- Digital assets are chargeable assets under the
  [Finance Act 2023](https://firs.gov.ng/finance-act-2023/).
- Flat 10% Capital Gains Tax on net disposal gain, effective 1 September
  2023.
- No short-term vs long-term distinction.
- Staking, airdrops, and rewards are Personal Income Tax at the user's
  bracket (7% – 24% under PITA) — TaxPilot reports the ordinary-income
  total but does not compute the PIT owed.
- Losses may offset gains in the same tax year; excess-loss carryforward is
  flagged for the user's advisor rather than assumed.
- All valuations are computed in USD; NGN is a presentation-layer
  conversion using the exchange rate the user supplies.

**Explicitly out of scope** (both jurisdictions)

- Wash-sale rules for digital assets.
- Cost-basis methods other than FIFO.
- Mining income (on-chain rewards outside the exchange).
- Character disputes (staking-as-a-service vs solo, hard fork treatment,
  NFT capital vs ordinary).
- State-level tax (US) and Personal Income Tax computation (NG).

Every out-of-scope item is surfaced to the user, not silently assumed.

---

## Reproducibility and verification

- **Deterministic snapshots.** `snapshotId()` in
  [`src/reports.js`](src/reports.js) hashes `(events, decisions,
  historicalLots, policy version, engine version, jurisdiction, tax year)`.
  Identical inputs produce the same ID; any change produces a new ID.
- **Decision replay.** A snapshot plus a set of decisions is re-computable
  without re-pulling history.
- **Historical-lot merger.** Basis for pre-scope acquisitions can be
  imported and merged into the FIFO queue before matching.
- **Automated tests.** The methodology engine and every supporting adapter
  are covered by an automated test suite (`npm test`).

Verification checklist a user (or an evaluator) can run:

```bash
npm test                                            # methodology + adapters
node --test test/tax-engine.test.js                 # engine only
grep -R "capitalGainsRate" src/tax-engine.js        # inspect policy constants
```

---

## Security posture

The skill is read-only by contract, not by after-the-fact policy:

- **No write verbs are registered.** The MCP surface exposes `parse`,
  `normalize`, `value`, `match`, and `export` only. No tool with a name
  beginning `create_`, `delete_`, `send_`, `place_`, `cancel_`, `borrow_`,
  or `withdraw_` is discoverable to the host agent.
- **No network egress from user code.** All processing happens inside the
  agent session on the CSV in context. TaxPilot does not call Binance from
  user code and does not require an API key.
- **No credential handling.** The skill does not read, print, log, or copy
  any authentication token or session identifier that its host agent may
  hold.
- **Deterministic auditability.** Every disposal in the report names the
  lot(s) consumed with acquisition timestamps and per-lot basis; every
  valuation names its source (`event-time`, `daily-close-usdt`,
  `daily-close-usdc`, or `stablecoin-quote`).

---

## Testing

```bash
npm test                              # full suite
node --test test/tax-engine.test.js   # engine only
node --test test/normalize.test.js    # CSV → event adapter
node --test test/reports.test.js      # snapshots + decision replay
```

The engine tests exercise both US and NG jurisdictions:

- `US report includes a Schedule D summary and income-by-category breakdown`
- `NG report applies 10% CGT and skips holding-period split`
- `NG report converts estimated tax to NGN when usdToLocalRate provided`
- `NG losses do not produce a negative tax owed`

---

## Continuous integration

The [`.github/workflows/ci.yml`](.github/workflows/ci.yml) workflow runs on
every push and pull request:

- test suite on Node 20 and Node 22
- `npm audit --omit=dev` for known-vulnerable dependencies
- a static scan for accidentally-committed secrets

---

## Publishing to the Binance Skills Hub

The `skill/` directory is a self-contained MIT-licensed package that
matches the [Binance Skills Hub](https://github.com/binance/binance-skills-hub)
layout. See [`skill/SUBMISSION.md`](skill/SUBMISSION.md) for the exact
fork → branch → PR steps. Once merged, users install it with:

```bash
npx skills add https://github.com/binance/binance-skills-hub/tree/main/skills/binance/taxpilot
```

---

## Disclaimer

TaxPilot provides mechanical estimates from a user's own Binance history for
educational and workflow purposes. It is **not tax advice, not legal
advice, and not a substitute for a licensed practitioner**. Users must
have a qualified CPA, enrolled agent, chartered accountant, or their
jurisdiction's equivalent review any report before filing. TaxPilot does
not file tax returns and does not communicate with any tax authority on the
user's behalf.

---

## References

- Binance Agent OS — https://www.binance.com/en-NG/agent-os
- Binance Skills Hub — https://www.binance.com/en/skills · https://github.com/binance/binance-skills-hub
- Model Context Protocol — https://modelcontextprotocol.io
- IRS Digital Assets — https://www.irs.gov/filing/digital-assets
- IRS Form 8949 — https://www.irs.gov/forms-pubs/about-form-8949
- Rev. Proc. 2024-28 (US per-wallet basis allocation) — https://www.irs.gov/pub/irs-drop/rp-24-28.pdf
- FIRS Finance Act 2023 (Nigeria 10% CGT on digital assets) — https://firs.gov.ng/finance-act-2023/
- PwC Nigeria — Finance Act 2023 summary — https://www.pwc.com/ng/en/publications/finance-act-2023.html
