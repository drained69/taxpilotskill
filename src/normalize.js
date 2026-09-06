// Normalization adapter: Binance Agent OS records -> tax-engine events.
//
// Agent OS exposes read-only account data (balances, portfolio, transaction
// history of a designated subaccount). The exact JSON field names are resolved
// at runtime against the candidate lists below, so this adapter tolerates the
// common shapes Binance surfaces (transaction history, convert history, trade
// fills) and is easy to pin down once the live schema is confirmed.
//
// Every mapping table lives in THIS file. To correct the adapter against the
// real schema, edit FIELD_CANDIDATES / TYPE_MAP / SELF_TRANSFER_HINTS only.

// Candidate keys for each logical field, checked in order (first present wins).
export const FIELD_CANDIDATES = {
  id: ['id', 'txId', 'tranId', 'transactionId', 'orderId', 'tradeId', 'uid'],
  // _typeHint is a sentinel set by the pipeline on records from type-specific
  // tools (e.g. wallet_depositHistory) that carry no explicit type field.
  type: ['type', 'txType', 'transactionType', 'category', 'side', 'operation', 'flow', '_typeHint'],
  asset: ['asset', 'coin', 'currency', 'symbolAsset', 'baseAsset', 'token'],
  quantity: ['amount', 'qty', 'quantity', 'volume', 'executedQty', 'baseQty', 'change'],
  usdValue: ['usdValue', 'valueUsd', 'quoteValueUsd', 'notionalUsd', 'usdtValue', 'fiatValue'],
  quoteAsset: ['quoteAsset', 'quoteCoin', 'counterAsset', 'toAsset'],
  quoteQuantity: ['quoteQty', 'quoteAmount', 'cummulativeQuoteQty', 'quoteVolume', 'toAmount'],
  price: ['price', 'avgPrice', 'unitPrice', 'fillPrice'],
  feeAsset: ['feeAsset', 'feeCoin', 'commissionAsset'],
  feeQuantity: ['fee', 'feeAmount', 'commission', 'feeQty', 'transactionFee'],
  feeUsd: ['feeUsd', 'feeValueUsd', 'commissionUsd'],
  timestamp: ['timestamp', 'time', 'createTime', 'updateTime', 'insertTime', 'transactTime', 'applyTime', 'completeTime', 'date'],
  accountId: ['accountId', 'subAccountId', 'subaccount', 'walletId', 'account'],
  fromAsset: ['fromAsset', 'sourceAsset'],
  fromAmount: ['fromAmount', 'sourceAmount'],
  toAsset: ['toAsset', 'targetAsset'],
  toAmount: ['toAmount', 'targetAmount'],
  address: ['address', 'toAddress', 'destAddress'],
  isInternal: ['isInternal', 'internal', 'transferType'],
};

// Raw Agent OS type/side tokens -> tax-engine event types.
export const TYPE_MAP = {
  buy: 'buy',
  purchase: 'buy',
  sell: 'sell',
  sale: 'sell',
  convert: 'convert',
  conversion: 'convert',
  swap: 'convert',
  trade: 'trade', // resolved to buy/sell by side elsewhere
  deposit: 'deposit',
  withdraw: 'withdrawal',
  withdrawal: 'withdrawal',
  transfer: 'transfer',
  'transfer-in': 'deposit',
  'transfer-out': 'withdrawal',
  reward: 'reward',
  rewards: 'reward',
  staking: 'staking',
  'staking-reward': 'staking',
  'simple-earn': 'staking',
  interest: 'staking',
  airdrop: 'airdrop',
  distribution: 'airdrop',
  commission: 'income',
  income: 'income',
  spend: 'spend',
  payment: 'spend',
  fee: 'fee',
};

// Values (case-insensitive) that indicate a same-owner internal transfer.
export const SELF_TRANSFER_HINTS = ['internal', 'internal_transfer', 'sub_account', 'main_to_sub', 'sub_to_main', 'self', 'true', '1'];

function pick(record, field) {
  for (const key of FIELD_CANDIDATES[field] || []) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') return record[key];
  }
  return undefined;
}

function toNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '')) : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toIso(value) {
  if (value === undefined || value === null || value === '') return undefined;
  // Binance timestamps are commonly epoch milliseconds (or seconds).
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    let ms = Number(value);
    if (ms < 1e12) ms *= 1000; // seconds -> ms
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function mapType(rawType, record) {
  const key = String(rawType ?? '').toLowerCase().replace(/\s+/g, '-');
  let type = TYPE_MAP[key] || key;
  if (type === 'trade') {
    const side = String(pick(record, 'type') ?? record.side ?? '').toLowerCase();
    type = side.includes('sell') ? 'sell' : 'buy';
  }
  return type;
}

// Common Binance quote assets, ordered longest-first to avoid false prefix matches.
const KNOWN_QUOTE_ASSETS = ['FDUSD', 'USDC', 'USDT', 'BUSD', 'TUSD', 'USDP', 'PYUSD', 'DAI', 'BTC', 'ETH', 'BNB', 'TRY', 'EUR', 'GBP', 'AUD', 'BRL', 'RUB'];
function extractBaseAsset(symbol) {
  if (!symbol || typeof symbol !== 'string') return undefined;
  const s = symbol.toUpperCase();
  for (const quote of KNOWN_QUOTE_ASSETS) {
    if (s.endsWith(quote) && s.length > quote.length) return s.slice(0, s.length - quote.length);
  }
  return undefined;
}

function isSelfTransfer(record) {
  const flag = pick(record, 'isInternal');
  if (typeof flag === 'boolean') return flag;
  if (flag !== undefined) return SELF_TRANSFER_HINTS.includes(String(flag).toLowerCase());
  return undefined; // unknown -> let the engine flag it for review
}

/**
 * Normalize one Agent OS record into a tax-engine event.
 * Returns `{ event }` on success or `{ error }` describing why it could not map.
 */
export function normalizeRecord(record, { index = 0, accountId } = {}) {
  if (!record || typeof record !== 'object') return { error: { code: 'NOT_AN_OBJECT', index } };

  // isBuyer is the Binance spot-trade type signal when no explicit type field exists.
  const isBuyerRaw = record.isBuyer;
  const rawType = pick(record, 'type') ?? (isBuyerRaw !== undefined ? (isBuyerRaw ? 'buy' : 'sell') : undefined);
  const type = mapType(rawType, record);
  const id = String(pick(record, 'id') ?? `agentos-${index}`);
  const timestamp = toIso(pick(record, 'timestamp'));
  const account = String(pick(record, 'accountId') ?? accountId ?? 'agentic-default');

  // A "convert" record carries from/to legs; model it as a disposal of the
  // source asset (the engine treats convert as a taxable disposition).
  const fromAsset = pick(record, 'fromAsset');
  const toAsset = pick(record, 'toAsset');
  let asset = pick(record, 'asset');
  let quantity = toNumber(pick(record, 'quantity'));
  if (type === 'convert' && fromAsset) {
    asset = fromAsset;
    quantity = toNumber(pick(record, 'fromAmount')) ?? quantity;
  }
  // Fallback: derive base asset from a trading-pair symbol (e.g. "BTCUSDT" → "BTC").
  if (asset == null && record.symbol) asset = extractBaseAsset(record.symbol);

  const event = {
    id,
    type,
    accountId: account,
    asset: asset != null ? String(asset).toUpperCase() : undefined,
    quantity,
    timestamp,
    raw: record,
  };

  // USD value: prefer an explicit USD field; otherwise derive from a
  // USD-stablecoin quote leg or a unit price. If none is available the event
  // is left without usdValue so pricing enrichment / the engine can flag it,
  // rather than inventing a valuation.
  const explicitUsd = toNumber(pick(record, 'usdValue'));
  if (explicitUsd !== undefined) {
    event.usdValue = explicitUsd;
  } else {
    const quoteAsset = String(pick(record, 'quoteAsset') ?? toAsset ?? '').toUpperCase();
    const quoteQty = toNumber(pick(record, 'quoteQuantity')) ?? toNumber(pick(record, 'toAmount'));
    if (isUsdStable(quoteAsset) && quoteQty !== undefined) {
      event.usdValue = quoteQty;
    } else {
      const price = toNumber(pick(record, 'price'));
      if (price !== undefined && quantity !== undefined && isUsdStable(quoteAsset)) {
        event.usdValue = price * quantity;
      }
    }
  }

  const feeUsd = toNumber(pick(record, 'feeUsd'));
  if (feeUsd !== undefined) event.feeUsd = feeUsd;
  const feeAsset = pick(record, 'feeAsset');
  const feeQuantity = toNumber(pick(record, 'feeQuantity'));
  if (feeAsset) event.feeAsset = String(feeAsset).toUpperCase();
  if (feeQuantity !== undefined) event.feeQuantity = feeQuantity;
  if (event.feeUsd === undefined && event.feeAsset && isUsdStable(event.feeAsset) && feeQuantity !== undefined) {
    event.feeUsd = feeQuantity;
  }

  if (type === 'transfer' || type === 'deposit' || type === 'withdrawal') {
    const self = isSelfTransfer(record);
    if (self !== undefined) event.isSelfTransfer = self;
  }

  return { event };
}

/**
 * Normalize an array of Agent OS records.
 * @returns {{ events: object[], skipped: object[] }}
 */
export function normalizeRecords(records, options = {}) {
  const events = [];
  const skipped = [];
  const list = Array.isArray(records) ? records : [];
  list.forEach((record, index) => {
    const { event, error } = normalizeRecord(record, { ...options, index });
    if (error) skipped.push(error);
    else events.push(event);
  });
  return { events, skipped };
}

const USD_STABLES = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'PYUSD']);
export function isUsdStable(asset) {
  return USD_STABLES.has(String(asset || '').toUpperCase());
}

/**
 * Extract a record array from a tool result of unknown shape.
 * Agent OS tools may return an array directly, or wrap it under a common key.
 */
export function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of ['transactions', 'data', 'rows', 'items', 'results', 'history', 'records', 'list', 'trades', 'fills']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  // Single record object -> wrap it.
  return Object.keys(payload).length ? [payload] : [];
}
