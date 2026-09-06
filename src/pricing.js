// Historical USD valuation for events that arrive without a USD value.
//
// A disposal cannot be taxed without a fair-market USD value at the moment it
// happened. Agent OS trade/convert legs against a USD stablecoin already carry
// that value (resolved in normalize.js); everything else needs a price lookup.
//
// This module provides a pluggable `PriceProvider` interface. The default
// `KlinesPriceProvider` reads daily closes from Binance public market data
// (klines) — the same figures an Agent OS market-data tool would surface — and
// caches per asset/day. When no price can be sourced, the event is left WITHOUT
// a usdValue so the tax engine flags it as unresolved. TaxPilot never invents a
// valuation.

import { isUsdStable } from './normalize.js';

export const BINANCE_MARKET_DATA_URL = 'https://api.binance.com';

const dayKey = (iso) => new Date(iso).toISOString().slice(0, 10);

export class KlinesPriceProvider {
  /**
   * @param {object} opts
   * @param {Function} [opts.fetchImpl] fetch implementation (defaults to global fetch)
   * @param {string}   [opts.baseUrl]   market-data base URL
   * @param {string[]} [opts.quotes]    stablecoin symbols to try, in order
   */
  constructor({ fetchImpl, baseUrl = BINANCE_MARKET_DATA_URL, quotes = ['USDT', 'USDC', 'FDUSD'] } = {}) {
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.baseUrl = baseUrl;
    this.quotes = quotes;
    this.cache = new Map(); // `${asset}:${day}` -> number | null
  }

  /** Daily-close USD price for `asset` on the day of `iso`, or null if unknown. */
  async priceOn(asset, iso) {
    const symbolAsset = String(asset || '').toUpperCase();
    if (isUsdStable(symbolAsset)) return 1;
    if (typeof this.fetchImpl !== 'function') return null;

    const key = `${symbolAsset}:${dayKey(iso)}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const dayStart = new Date(`${dayKey(iso)}T00:00:00Z`).getTime();
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;

    for (const quote of this.quotes) {
      try {
        const url = `${this.baseUrl}/api/v3/klines?symbol=${symbolAsset}${quote}&interval=1d&startTime=${dayStart}&endTime=${dayEnd}&limit=1`;
        const res = await this.fetchImpl(url);
        if (!res.ok) continue;
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length) {
          const close = Number(rows[0][4]); // kline close price, quoted in a USD stablecoin
          if (Number.isFinite(close)) {
            this.cache.set(key, close);
            return close;
          }
        }
      } catch {
        // try the next quote symbol
      }
    }
    this.cache.set(key, null);
    return null;
  }
}

/** A provider that never has prices — used to keep the pipeline honest offline. */
export class NullPriceProvider {
  async priceOn() {
    return null;
  }
}

/**
 * Enrich events missing a usdValue by valuing quantity at the historical price.
 * Events that cannot be valued are returned unchanged (no usdValue) and listed
 * in `unpriced` so the caller and UI can surface them as needing review.
 *
 * @returns {{ events: object[], priced: number, unpriced: object[] }}
 */
export async function enrichWithPrices(events, provider) {
  const out = [];
  const unpriced = [];
  let priced = 0;

  for (const event of events) {
    if (event.usdValue !== undefined || !needsValuation(event)) {
      out.push(event);
      continue;
    }
    let price = null;
    if (event.asset && event.timestamp && Number.isFinite(event.quantity)) {
      price = await provider.priceOn(event.asset, event.timestamp);
    }
    if (price != null) {
      const usdValue = round2(price * event.quantity);
      const enriched = { ...event, usdValue, valuation: { source: 'historical-close', price } };
      // Value the fee too when it is denominated in a crypto asset.
      if (enriched.feeUsd === undefined && enriched.feeAsset && Number.isFinite(enriched.feeQuantity)) {
        const feePrice = await provider.priceOn(enriched.feeAsset, enriched.timestamp);
        if (feePrice != null) enriched.feeUsd = round2(feePrice * enriched.feeQuantity);
      }
      out.push(enriched);
      priced += 1;
    } else {
      out.push(event);
      unpriced.push({ id: event.id, asset: event.asset, timestamp: event.timestamp, type: event.type });
    }
  }
  return { events: out, priced, unpriced };
}

const ACQUISITION_OR_DISPOSAL = new Set(['buy', 'sell', 'convert', 'spend', 'reward', 'staking', 'airdrop', 'income']);
function needsValuation(event) {
  return ACQUISITION_OR_DISPOSAL.has(event.type);
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
