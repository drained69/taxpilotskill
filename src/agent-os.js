// High-level Agent OS pipeline: connect -> discover -> pull read-only history
// -> normalize -> value -> compute the tax report.
//
// This is the "deep integration" seam. It drives the MCP client through the
// real protocol lifecycle, calls the discovered read-only tools, and turns
// their output into a deterministic, explainable tax report via the existing
// engine. Tool *selection* is heuristic (matched by name/description) because
// Agent OS tool names are resolved at runtime from `tools/list`; the matchers
// live here in one place.

import { McpClient } from './mcp-client.js';
import { normalizeRecords, extractRecords } from './normalize.js';
import { enrichWithPrices, KlinesPriceProvider, NullPriceProvider } from './pricing.js';
import { calculateTaxReport } from './tax-engine.js';

// Ordered keyword matchers used to classify discovered tools by purpose.
export const TOOL_MATCHERS = {
  transactions: [/transaction.*histor/i, /trade.*histor/i, /account.*histor/i, /\bhistory\b/i, /convert.*histor/i, /deposit|withdraw/i],
  balances: [/balance/i, /portfolio/i, /holdings?/i, /asset.*list/i],
};

// Explicit registry of Binance Agent OS tools needed for a complete tax import.
// `typeHint` is written onto records that carry no type field of their own so
// normalize.js can map them to the correct tax-engine event type.
export const BINANCE_HISTORY_TOOLS = [
  // Spot
  { name: 'spot_myTrades',                            category: 'spot_trades',       typeHint: undefined    }, // isBuyer field on records
  // Wallet movement
  { name: 'wallet_depositHistory',                    category: 'deposits',          typeHint: 'deposit'    },
  { name: 'wallet_withdrawHistory',                   category: 'withdrawals',       typeHint: 'withdrawal' },
  { name: 'wallet_queryUserUniversalTransferHistory', category: 'transfers',         typeHint: 'transfer'   },
  // Convert
  { name: 'convert_getConvertTradeHistory',           category: 'converts',          typeHint: 'convert'    },
  // Futures
  { name: 'futures_usds_queryOrder',                  category: 'futures_usds',      typeHint: undefined    }, // side field
  { name: 'futures_coin_queryOrder',                  category: 'futures_coin',      typeHint: undefined    }, // side field
  // Margin (documented tools; adapters may vary in the live schema)
  { name: 'margin_queryMarginAccountsTradeList',      category: 'margin_trades',     typeHint: undefined    }, // isBuyer field
  { name: 'margin_marginAccountBorrowRepay',          category: 'margin_borrow_repay', typeHint: 'transfer' },
  // Sub-account
  { name: 'sub_account_getMainAccountAsset',          category: 'subaccount_assets', typeHint: undefined    },
];

/**
 * Return the subset of BINANCE_HISTORY_TOOLS that are present in `discoveredTools`,
 * each augmented with the full tool object (for schema introspection in pullHistory).
 */
export function selectBinanceHistoryTools(discoveredTools) {
  const byName = new Map(discoveredTools.map((t) => [t.name, t]));
  return BINANCE_HISTORY_TOOLS
    .filter(({ name }) => byName.has(name))
    .map((entry) => ({ ...entry, tool: byName.get(entry.name) }));
}

const READ_ONLY_TOOL_PATTERNS = [
  /balance|portfolio|holding|asset.*list/i,
  /transaction|trade.*histor|account.*histor|deposit.*histor|withdraw.*histor|convert.*histor/i,
  /price|ticker|kline|market.*data/i,
];
const WRITE_TOOL_PATTERNS = [
  /order|withdraw|transfer|swap|sign|approve|contract|stake|unstake|borrow|repay|pay|payment/i,
];

export function isReadOnlyTool(tool) {
  const text = `${tool?.name || ''} ${tool?.description || ''}`;
  const historyRead = /(history|historical|transactions?)/i.test(text) && /(deposit|withdraw|trade|convert)/i.test(text);
  return (historyRead || !WRITE_TOOL_PATTERNS.some((pattern) => pattern.test(text)))
    && READ_ONLY_TOOL_PATTERNS.some((pattern) => pattern.test(text));
}

function deduplicateRecords(records) {
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const record of records) {
    const key = record && typeof record === 'object'
      ? [record.id, record.txId, record.tranId, record.transactionId, record.tradeId, record.orderId].find(Boolean)
        || JSON.stringify([record.type, record.asset || record.coin, record.amount || record.quantity, record.timestamp || record.time])
      : String(record);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(record);
  }
  return { records: unique, duplicates };
}

/** Pick the first discovered tool whose name or description matches a matcher. */
export function selectTool(tools, matchers) {
  for (const matcher of matchers) {
    const hit = tools.find((t) => matcher.test(t.name || '') || matcher.test(t.description || ''));
    if (hit) return hit;
  }
  return null;
}

/**
 * Run the full pipeline and return a tax report plus provenance.
 *
 * @param {object} opts
 * @param {string}  opts.token           OAuth bearer (read-only scope)
 * @param {string}  [opts.url]           MCP endpoint
 * @param {Function} [opts.fetchImpl]    transport for the MCP client
 * @param {object}  [opts.priceProvider] price provider (defaults to Klines; NullPriceProvider offline)
 * @param {number}  [opts.taxYear]
 * @param {string}  [opts.accountId]     subaccount id to scope the pull
 * @param {object}  [opts.toolArgs]      extra args merged into the history tool call
 * @returns {Promise<{ report, provenance }>}
 */
export async function buildTaxReportFromAgentOS(opts = {}) {
  const {
    token,
    url,
    fetchImpl,
    priceProvider,
    taxYear = 2025,
    accountId,
    toolArgs = {},
    client: injectedClient,
  } = opts;

  const client = injectedClient || new McpClient({ url, token, fetchImpl });
  const provenance = {
    endpoint: client.url,
    connectedAt: new Date().toISOString(),
    serverInfo: null,
    tools: [],
    historyTool: null,
    historyTools: null,      // set when Binance multi-source path is used
    sourceBreakdown: null,   // record count per tool category (Binance path only)
    balancesTool: null,
    recordCount: 0,
    normalized: 0,
    skipped: [],
    priced: 0,
    unpriced: [],
    balances: null,
    warnings: [],
    pagesFetched: 0,
    pageLimitReached: false,
    paginationSupported: false,
    duplicatesRemoved: 0,
    complete: true,
  };

  provenance.serverInfo = await client.initialize();
  const tools = await client.listTools();
  provenance.tools = tools.map((t) => t.name);

  const safeTools = tools.filter(isReadOnlyTool);
  const balancesTool = selectTool(safeTools, TOOL_MATCHERS.balances);
  provenance.balancesTool = balancesTool?.name || null;

  // When explicit Binance Agent OS tools are present, pull all history sources
  // in parallel and merge. Fall back to heuristic single-tool discovery for
  // generic / unknown endpoints.
  const binanceTools = selectBinanceHistoryTools(tools);
  let rawRecords;

  if (binanceTools.length > 0) {
    const pulled = await pullBinanceHistory(client, binanceTools, { accountId, taxYear, toolArgs });
    rawRecords = pulled.records;
    provenance.historyTool = binanceTools[0].name;
    provenance.historyTools = binanceTools.map((t) => t.name);
    provenance.sourceBreakdown = pulled.sourceBreakdown;
    provenance.recordCount = rawRecords.length;
    provenance.pagesFetched = pulled.pagesFetched;
    provenance.pageLimitReached = pulled.pageLimitReached;
    provenance.paginationSupported = pulled.paginationSupported;
    provenance.duplicatesRemoved = pulled.duplicatesRemoved;
    provenance.complete = !pulled.pageLimitReached;
    for (const w of pulled.warnings) provenance.warnings.push(w);
    if (pulled.pageLimitReached) provenance.warnings.push('History import reached the page safety limit and may be incomplete.');
    if (pulled.duplicatesRemoved) provenance.warnings.push(`${pulled.duplicatesRemoved} duplicate record(s) were excluded.`);
  } else {
    const historyTool = selectTool(safeTools, TOOL_MATCHERS.transactions);
    provenance.historyTool = historyTool?.name || null;
    if (!historyTool) {
      provenance.warnings.push('No transaction-history tool was discovered on this Agent OS connection.');
      return { report: calculateTaxReport([], { taxYear }), provenance };
    }
    const pulled = await pullHistory(client, historyTool, { accountId, taxYear, toolArgs });
    const deduped = deduplicateRecords(pulled.records);
    rawRecords = deduped.records;
    provenance.recordCount = rawRecords.length;
    provenance.pagesFetched = pulled.pagesFetched;
    provenance.pageLimitReached = pulled.pageLimitReached;
    provenance.paginationSupported = pulled.paginationSupported;
    provenance.duplicatesRemoved = deduped.duplicates;
    provenance.complete = !pulled.pageLimitReached;
    if (pulled.pageLimitReached) provenance.warnings.push('History import reached the page safety limit and may be incomplete.');
    if (deduped.duplicates) provenance.warnings.push(`${deduped.duplicates} duplicate record(s) were excluded.`);
  }

  const { events, skipped } = normalizeRecords(rawRecords, { accountId });
  provenance.normalized = events.length;
  provenance.skipped = skipped;

  const provider = priceProvider || (fetchImpl || globalThis.fetch ? new KlinesPriceProvider({ fetchImpl }) : new NullPriceProvider());
  const { events: valued, priced, unpriced } = await enrichWithPrices(events, provider);
  provenance.priced = priced;
  provenance.unpriced = unpriced;
  if (unpriced.length) {
    provenance.warnings.push(`${unpriced.length} event(s) could not be valued and are flagged for review.`);
  }

  // Optional: fetch balances for a portfolio snapshot (non-tax, provenance only).
  if (balancesTool) {
    try {
      const balPayload = await client.callTool(balancesTool.name, accountId ? { accountId } : {});
      provenance.balances = extractRecords(balPayload);
    } catch (error) {
      provenance.warnings.push(`Balance snapshot unavailable: ${error.message}`);
    }
  }

  const report = calculateTaxReport(valued, { taxYear });
  // Return the priced/valued events too so callers can persist the snapshot
  // and re-run the engine after user decisions or historical-lot imports.
  return { report, provenance, events: valued, rawRecords };
}

/**
 * Pull history from all registered Binance tools in parallel, tag each record
 * with `_typeHint` for the normalizer, merge, then deduplicate.
 */
async function pullBinanceHistory(client, binanceTools, { accountId, taxYear, toolArgs }) {
  const results = await Promise.allSettled(
    binanceTools.map(({ name, category, typeHint, tool }) =>
      pullHistory(client, tool, { accountId, taxYear, toolArgs }).then((pulled) => ({ category, typeHint, pulled }))
    )
  );

  const allRecords = [];
  const sourceBreakdown = {};
  let pagesFetched = 0;
  let pageLimitReached = false;
  let paginationSupported = false;
  const warnings = [];

  for (const result of results) {
    if (result.status === 'rejected') {
      warnings.push(`Source pull failed: ${result.reason?.message || 'unknown error'}`);
      continue;
    }
    const { category, typeHint, pulled } = result.value;
    // Tag records from type-specific tools so normalize.js can infer the type
    // from the tool category when the record itself carries no type field.
    if (typeHint) {
      for (const record of pulled.records) {
        if (record && typeof record === 'object' && record._typeHint === undefined) {
          record._typeHint = typeHint;
        }
      }
    }
    sourceBreakdown[category] = pulled.records.length;
    allRecords.push(...pulled.records);
    pagesFetched += pulled.pagesFetched;
    if (pulled.pageLimitReached) pageLimitReached = true;
    if (pulled.paginationSupported) paginationSupported = true;
  }

  const deduped = deduplicateRecords(allRecords);
  return { records: deduped.records, sourceBreakdown, pagesFetched, pageLimitReached, paginationSupported, duplicatesRemoved: deduped.duplicates, warnings };
}

/**
 * Call the history tool and gather records, following simple pagination when
 * the tool accepts it. Falls back to a single call when it does not.
 */
async function pullHistory(client, tool, { accountId, taxYear, toolArgs }) {
  const schema = tool.inputSchema?.properties || {};
  const supports = (name) => Object.prototype.hasOwnProperty.call(schema, name);

  const baseArgs = { ...toolArgs };
  if (accountId && supports('accountId')) baseArgs.accountId = accountId;
  if (taxYear) {
    const start = Date.UTC(taxYear, 0, 1);
    const end = Date.UTC(taxYear + 1, 0, 1) - 1;
    if (supports('startTime')) baseArgs.startTime = start;
    if (supports('endTime')) baseArgs.endTime = end;
    if (supports('year')) baseArgs.year = taxYear;
  }

  const all = [];
  const pageSize = supports('limit') ? 500 : undefined;
  let page = 1;
  let pagesFetched = 0;
  const MAX_PAGES = 40; // hard stop to avoid unbounded loops

  while (page <= MAX_PAGES) {
    const args = { ...baseArgs };
    if (pageSize && supports('limit')) args.limit = pageSize;
    if (supports('page')) args.page = page;
    else if (supports('offset')) args.offset = (page - 1) * (pageSize || 0);

    const payload = await client.callTool(tool.name, args);
    const records = extractRecords(payload);
    all.push(...records);
    pagesFetched += 1;

    // Stop when the tool cannot paginate, or returns a short/empty page.
    if (!supports('page') && !supports('offset')) break;
    if (!pageSize || records.length < pageSize) break;
    page += 1;
  }
  return { records: all, pagesFetched, pageLimitReached: page > MAX_PAGES, paginationSupported: supports('page') || supports('offset') };
}
