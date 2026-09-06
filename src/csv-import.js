// CSV import for Binance history exports.
//
// A user can download their transaction history from binance.com (Wallet →
// Transaction History → Export) as CSV. This module parses those files into
// the same raw-record shape the MCP pipeline produces, so imported records
// flow through the exact same normalize → price → tax-engine path.
//
// Binance ships several CSV shapes; the two most common are:
//   1. **Universal transaction history** (long-form): columns include
//      `User_ID`, `UTC_Time`, `Account`, `Operation`, `Coin`, `Change`.
//   2. **Spot trade history** (fill-level): columns include `Date(UTC)`,
//      `Pair`, `Side`, `Price`, `Executed`, `Amount`, `Fee`.
//
// The parser is format-agnostic: it detects which shape a row uses from the
// header and emits records that the existing normalizer already understands
// (via `_typeHint`, `symbol`, `isBuyer`, etc.).

const HEADER_ALIASES = {
  utc_time: 'time',
  'date(utc)': 'time',
  date: 'time',
  time_utc: 'time',
  operation: 'operation',
  account: 'account',
  coin: 'coin',
  asset: 'coin',
  currency: 'coin',
  change: 'amount',
  amount: 'amount',
  quantity: 'amount',
  executed: 'executed',
  price: 'price',
  pair: 'symbol',
  symbol: 'symbol',
  side: 'side',
  fee: 'fee',
  fee_coin: 'feeCoin',
  fee_asset: 'feeCoin',
  txid: 'txId',
  'transaction id': 'txId',
  order_id: 'orderId',
  status: 'status',
  network: 'network',
  address: 'address',
  user_id: 'userId',
  remark: 'remark',
};

const OPERATION_MAP = {
  'buy': 'buy',
  'sell': 'sell',
  'transaction buy': 'buy',
  'transaction sold': 'sell',
  'transaction spend': 'spend',
  'transaction fee': 'fee',
  'transaction related': 'trade',
  'deposit': 'deposit',
  'crypto deposit': 'deposit',
  'fiat deposit': 'deposit',
  'withdraw': 'withdrawal',
  'crypto withdrawal': 'withdrawal',
  'fiat withdrawal': 'withdrawal',
  'transfer_in': 'deposit',
  'transfer_out': 'withdrawal',
  'transfer between main and sub account': 'transfer',
  'transfer between sub accounts': 'transfer',
  'main and funding transfer': 'transfer',
  'sub-account transfer': 'transfer',
  'commission history': 'income',
  'commission rebate': 'income',
  'distribution': 'airdrop',
  'airdrop assets': 'airdrop',
  'staking rewards': 'staking',
  'simple earn flexible interest': 'staking',
  'simple earn locked rewards': 'staking',
  'launchpool interest': 'staking',
  'savings interest': 'staking',
  'referral kickback': 'income',
  'referral commission': 'income',
  'convert': 'convert',
  'small assets exchange bnb': 'convert',
};

/**
 * Split one CSV line, respecting quoted values. Handles the escaped-quote form
 * ("") that RFC 4180 mandates.
 */
export function splitCsvLine(line) {
  const out = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      field += ch;
    } else {
      if (ch === ',') { out.push(field); field = ''; continue; }
      if (ch === '"' && field === '') { inQuotes = true; continue; }
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * Parse a full CSV file body into an array of {header: value} rows.
 * Handles CRLF, BOM, and quoted fields with embedded commas.
 */
export function parseCsv(text) {
  const cleaned = String(text || '').replace(/^﻿/, '');
  const lines = cleaned.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return { headers: [], rows: [] };
  const rawHeaders = splitCsvLine(lines[0]).map((h) => h.trim());
  const headers = rawHeaders.map((h) => HEADER_ALIASES[h.toLowerCase()] || h.replace(/\s+/g, '_').toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const row = {};
    for (let c = 0; c < headers.length; c += 1) row[headers[c]] = cells[c] !== undefined ? cells[c].trim() : '';
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Convert parsed CSV rows into raw records shaped like the MCP tool output.
 * The normalizer already understands `_typeHint`, `symbol`, `isBuyer`, etc.
 * so the downstream pipeline stays identical.
 */
export function csvRowsToRecords(rows, { category = 'csv_import' } = {}) {
  const records = [];
  const skipped = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const record = { _csvSource: category, _rowIndex: i };

    // Universal transaction rows carry Operation + Coin + Change.
    if (row.operation || row.coin) {
      const op = String(row.operation || '').toLowerCase().trim();
      const mapped = OPERATION_MAP[op];
      if (!mapped) { skipped.push({ row: i, reason: `Unknown Operation "${row.operation}"` }); continue; }
      record._typeHint = mapped;
      record.coin = row.coin;
      record.amount = row.amount || row.change;
      record.time = row.time;
      if (row.account) record.accountId = row.account;
      if (row.remark) record.remark = row.remark;
      // Some universal rows contain negative amounts for outflow; keep the sign
      // and let normalize.js decide. Preserve raw string too.
      if (mapped === 'transfer' || mapped === 'deposit' || mapped === 'withdrawal') {
        record.isInternal = mapped === 'transfer';
      }
      records.push(record);
      continue;
    }

    // Spot trade rows: Pair + Side + Price + Executed + Amount + Fee.
    if (row.symbol && (row.side || row.executed)) {
      record._typeHint = undefined; // side/isBuyer carries it
      record.symbol = row.symbol;
      record.side = row.side ? String(row.side).toUpperCase() : undefined;
      record.qty = row.executed || row.amount;
      record.price = row.price;
      record.time = row.time;
      record.commission = row.fee;
      record.commissionAsset = row.feeCoin;
      // Executed = base qty. Amount usually = quote qty. Preserve both.
      if (row.amount) record.cummulativeQuoteQty = row.amount;
      records.push(record);
      continue;
    }

    // Deposit / withdrawal CSVs (Wallet → Deposit history export):
    if (row.txId || row.address || row.network) {
      record._typeHint = category.includes('withdraw') ? 'withdrawal' : 'deposit';
      record.txId = row.txId;
      record.coin = row.coin;
      record.amount = row.amount;
      record.time = row.time;
      record.address = row.address;
      record.network = row.network;
      record.status = row.status;
      records.push(record);
      continue;
    }

    skipped.push({ row: i, reason: 'Unrecognized row shape — need Operation+Coin, Pair+Side, or TxId+Coin.' });
  }
  return { records, skipped };
}

/**
 * End-to-end: parse a raw CSV text blob into records + a report of what was skipped.
 */
export function csvToRecords(text, options = {}) {
  const { headers, rows } = parseCsv(text);
  const { records, skipped } = csvRowsToRecords(rows, options);
  return { headers, records, skipped, totalRows: rows.length };
}
