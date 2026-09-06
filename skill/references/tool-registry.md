# Tool Registry

Call **only** these Binance Agent OS MCP tools. Any tool not on this list is out of scope for the tax skill.

## Read-only history tools (call all that the server exposes)

| MCP tool                                           | Category               | typeHint fallback | Notes                                                       |
| -------------------------------------------------- | ---------------------- | ----------------- | ----------------------------------------------------------- |
| `spot_myTrades`                                    | `spot_trades`          | *(from isBuyer)*  | Per-symbol; iterate exchange symbols the user actually holds |
| `wallet_depositHistory`                            | `deposits`             | `deposit`         | External deposits — always Tax Inbox (`OWNERSHIP_UNKNOWN`)  |
| `wallet_withdrawHistory`                           | `withdrawals`          | `withdrawal`      | External withdrawals — always Tax Inbox (`OWNERSHIP_UNKNOWN`) unless the user pre-declares the destination |
| `wallet_queryUserUniversalTransferHistory`         | `transfers`            | `transfer`        | Internal Binance transfers → `isSelfTransfer=true`          |
| `convert_getConvertTradeHistory`                   | `converts`             | `convert`         | From/to legs on one record                                  |
| `futures_usds_queryOrder`                          | `futures_usds`         | *(from side)*     | USD-M orders                                                |
| `futures_coin_queryOrder`                          | `futures_coin`         | *(from side)*     | COIN-M orders                                               |
| `margin_queryMarginAccountsTradeList`              | `margin_trades`        | *(from isBuyer)*  | Cross + isolated                                            |
| `margin_marginAccountBorrowRepay`                  | `margin_borrow_repay`  | `transfer`        | Not itself a disposition; interest is                       |
| `sub_account_getMainAccountAsset`                  | `subaccount_assets`    | *(read-only)*     | Snapshot, not a taxable event                               |

**Call pattern:** parallel, one MCP call per tool. Do NOT retry on failure — record the failure in provenance and continue.

## Market data (valuation fallback)

| MCP tool                                       | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `spot_klines` or `spot_uiKlines`               | Daily-close price for `<asset>/USDT` on the event UTC date  |
| `spot_tickerPrice`                             | Current price (avoid; use only if user asks for present value) |

## Balance / portfolio (non-tax provenance)

| MCP tool                       | Purpose                             |
| ------------------------------ | ----------------------------------- |
| `spot_getAccount`              | Report portfolio snapshot alongside |
| `wallet_queryUserWalletBalance`| Cross-check totals; not for tax     |

## Forbidden

**Never call**, even if the user asks:
- `spot_newOrder`, `spot_deleteOrder`, `spot_deleteOpenOrders`
- `margin_marginAccountNewOrder`, `margin_marginAccountCancelOrder`, `margin_marginAccountCancelAllOpenOrdersOnASymbol`
- `futures_*_newOrder`, `futures_*_cancelOrder`, `futures_*_changeInitialLeverage`, `futures_*_changeMarginType`
- `convert_acceptQuote`, `convert_sendQuoteRequest`, `convert_placeLimitOrder`, `convert_cancelLimitOrder`
- `wallet_userUniversalTransfer` *(this moves funds — the query variant is fine)*
- Anything under Binance Pay or Web3 signing

Refuse with the read-only refusal template in `../SKILL.md`.
