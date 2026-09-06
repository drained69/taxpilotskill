# Normalization

Convert every raw Binance MCP record into the canonical tax event shape.

## Event shape

```json
{
  "id":            "<stable id, prefer txId/tradeId/orderId>",
  "type":          "buy | sell | convert | spend | fee | deposit | withdrawal | transfer | reward | staking | airdrop | income",
  "accountId":     "<subaccount or 'agentic-default'>",
  "asset":         "<uppercase symbol, e.g. BTC>",
  "quantity":      0.0,
  "usdValue":      0.0,
  "feeUsd":        0.0,
  "feeAsset":      "<uppercase, if paid in a coin>",
  "feeQuantity":   0.0,
  "timestamp":     "<ISO 8601 UTC>",
  "isSelfTransfer": true|false|null,
  "valuationSource": "event-time | daily-close-usdt | daily-close-usdc | stablecoin-quote | user-supplied",
  "raw":           { ... original record ... }
}
```

## Field-alias table

The Binance MCP surfaces slightly different field names per tool. Resolve each canonical field by trying these candidates in order — first present wins.

| Canonical      | Candidates (first present wins)                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`           | `id`, `txId`, `tranId`, `transactionId`, `orderId`, `tradeId`, `uid`                                        |
| `type`         | `type`, `txType`, `transactionType`, `category`, `side`, `operation`, `flow` — else the tool's `typeHint`   |
| `asset`        | `asset`, `coin`, `currency`, `symbolAsset`, `baseAsset`, `token` — else derive from `symbol` (see below)    |
| `quantity`     | `amount`, `qty`, `quantity`, `volume`, `executedQty`, `baseQty`, `change`                                   |
| `usdValue`     | `usdValue`, `valueUsd`, `quoteValueUsd`, `notionalUsd`, `usdtValue`, `fiatValue` — else valuation fallback  |
| `quoteAsset`   | `quoteAsset`, `quoteCoin`, `counterAsset`, `toAsset`                                                        |
| `quoteQty`     | `quoteQty`, `quoteAmount`, `cummulativeQuoteQty`, `quoteVolume`, `toAmount`                                 |
| `price`        | `price`, `avgPrice`, `unitPrice`, `fillPrice`                                                               |
| `feeAsset`     | `feeAsset`, `feeCoin`, `commissionAsset`                                                                    |
| `feeQuantity`  | `fee`, `feeAmount`, `commission`, `feeQty`, `transactionFee`                                                |
| `feeUsd`       | `feeUsd`, `feeValueUsd`, `commissionUsd`                                                                    |
| `timestamp`    | `timestamp`, `time`, `createTime`, `updateTime`, `insertTime`, `transactTime`, `applyTime`, `completeTime`, `date` |
| `accountId`    | `accountId`, `subAccountId`, `subaccount`, `walletId`, `account`                                            |
| `isSelfTransfer` | `isInternal`, `internal`, `transferType`                                                                  |

## Type inference rules

Apply these in order:

1. Explicit `type` field wins.
2. `isBuyer: true` → `buy`. `isBuyer: false` → `sell`.
3. `side` in `{BUY, SELL}` → `buy`/`sell`.
4. Tool `typeHint` from `tool-registry.md` (e.g. records from `wallet_depositHistory` all become `deposit`).
5. If still ambiguous, skip the record and add to `skipped[]` with reason `UNKNOWN_TYPE`.

## Type map

| Raw                                              | Canonical    |
| ------------------------------------------------ | ------------ |
| `buy`, `purchase`                                | `buy`        |
| `sell`, `sale`                                   | `sell`       |
| `convert`, `conversion`, `swap`                  | `convert`    |
| `deposit`, `transfer-in`                         | `deposit`    |
| `withdraw`, `withdrawal`, `transfer-out`         | `withdrawal` |
| `transfer`                                       | `transfer`   |
| `reward`, `rewards`                              | `reward`     |
| `staking`, `staking-reward`, `simple-earn`, `interest` | `staking` |
| `airdrop`, `distribution`                        | `airdrop`    |
| `commission`, `income`                           | `income`     |
| `spend`, `payment`                               | `spend`      |
| `fee`                                            | `fee`        |

## Deriving `asset` from `symbol`

Binance spot trade rows carry a pair symbol like `BTCUSDT`. Split it by trying these quote suffixes in **longest-first** order (to avoid `USDT` false-matching before `FDUSD`): `FDUSD, USDC, USDT, BUSD, TUSD, USDP, PYUSD, DAI, BTC, ETH, BNB, TRY, EUR, GBP, AUD, BRL, RUB`.

Everything before the matched suffix is the base asset. If no suffix matches, skip and log `UNKNOWN_SYMBOL`.

## Convert legs

A `convert` record carries `fromAsset` + `fromAmount` (disposed) and `toAsset` + `toAmount` (acquired). Emit **one event** for the disposal (`asset=fromAsset, quantity=fromAmount, type=convert`). The acquired leg becomes a `buy` event with the same USD value and timestamp — this creates a fresh basis lot for the received asset.

## Timestamps

- Numeric → epoch milliseconds if ≥ 1e12, else epoch seconds → convert to ISO 8601 UTC.
- String → parse; if invalid, skip and log `INVALID_TIMESTAMP`.
- Always store in UTC. Tax year boundaries use UTC dates.

## Fees

- If the fee is paid in a USD stablecoin, `feeUsd = feeQuantity`.
- If the fee is paid in a non-USD coin, price it the same way as the disposal quantity (see valuation).
- Fee subtracts from proceeds on a disposal; adds to basis on an acquisition.

## Self-transfer detection

Set `isSelfTransfer`:
- **true** if `isInternal` is truthy, or `transferType` matches one of `internal, internal_transfer, sub_account, main_to_sub, sub_to_main, self`.
- **false** if `isInternal` is explicitly `false` or `0`.
- **null** (unknown) otherwise → forces the event into the Tax Inbox with reason `OWNERSHIP_UNKNOWN`.

Never guess. The correctness of the whole report depends on this.

## Deduplication

Deduplicate by the first present of: `id`, `txId`, `tranId`, `transactionId`, `tradeId`, `orderId`. Fallback key when none exist: `JSON.stringify([type, asset, quantity, timestamp])`. Report duplicate count in provenance.

## Valuation fallback (referenced from SKILL.md STEP 4)

1. **stablecoin quote** — if the trade is against a USD stablecoin, `usdValue = quoteQty`. Tag `valuationSource: stablecoin-quote`.
2. **daily close** — call `spot_klines` for `<asset>USDT` (fallback `<asset>USDC`, `<asset>FDUSD`) with `interval=1d` and the event's UTC date. Take the close. Tag `valuationSource: daily-close-<quote>`.
3. **give up** — leave `usdValue` unset. Add to Tax Inbox `MISSING_VALUATION`. Never invent a number.
