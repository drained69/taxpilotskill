// Deterministic, pure tax engine.
//
// One function, `calculateTaxReport`, consumes an array of normalized events
// and emits a full jurisdictional report: matched disposals with FIFO basis,
// ordinary income, non-taxable self-transfers, unresolved events, per-form
// rows, and a jurisdiction-specific summary with estimated tax owed.
//
// No I/O. No pricing. No mutation of inputs. Same inputs → identical output.

const EPSILON = 1e-10;

// ─── Policies ──────────────────────────────────────────────────────────────

export const US_2025_POLICY = {
  jurisdiction: 'US',
  taxYear: 2025,
  version: '2025.1',
  defaultMethod: 'FIFO',
  currency: 'USD',
  filingForm: 'Form 8949 + Schedule D',
  hasHoldingPeriod: true,
  capitalGainsRate: null, // varies by bracket + holding period
  ordinaryIncomeRate: null, // varies by bracket
  sources: [
    { rule: 'Digital assets are property; sales and exchanges create gain or loss.', url: 'https://www.irs.gov/filing/digital-assets' },
    { rule: 'Self-transfers are not dispositions; digital-asset-paid network fees may be.', url: 'https://www.irs.gov/filing/digital-assets' },
    { rule: 'Rewards and staking are ordinary income at fair market value when received.', url: 'https://www.irs.gov/filing/digital-assets' },
    { rule: 'Capital dispositions are reported on Form 8949 and Schedule D.', url: 'https://www.irs.gov/forms-pubs/about-form-8949' },
    { rule: '2025 basis allocation is wallet/account specific under Rev. Proc. 2024-28.', url: 'https://www.irs.gov/pub/irs-drop/rp-24-28.pdf' },
  ],
};

export const NG_2025_POLICY = {
  jurisdiction: 'NG',
  taxYear: 2025,
  version: '2025.1',
  defaultMethod: 'FIFO',
  currency: 'USD',              // valuations are USD; NGN conversion is a downstream display concern
  displayCurrencies: ['USD', 'NGN'],
  filingForm: 'FIRS Capital Gains Tax return',
  hasHoldingPeriod: false,      // NG applies one flat CGT rate regardless of holding period
  capitalGainsRate: 0.10,       // 10 % — Finance Act 2023
  ordinaryIncomeRate: null,     // depends on PIT bracket (7 – 24 %) — user's accountant applies
  sources: [
    { rule: 'Digital assets are chargeable assets; disposals attract 10% Capital Gains Tax.', url: 'https://firs.gov.ng/finance-act-2023/' },
    { rule: 'The Finance Act 2023 introduced Capital Gains Tax on the disposal of digital assets.', url: 'https://www.pwc.com/ng/en/publications/finance-act-2023.html' },
    { rule: 'Companies are also subject to CGT on digital asset gains under the Capital Gains Tax Act (Cap. C1 LFN 2004).', url: 'https://firs.gov.ng/' },
    { rule: 'Staking, airdrops, and other rewards are typically Personal Income Tax at the user\'s applicable PIT rate.', url: 'https://firs.gov.ng/' },
  ],
};

export const POLICIES = { US: US_2025_POLICY, NG: NG_2025_POLICY };

// ─── Main entry point ──────────────────────────────────────────────────────

/**
 * @param {object[]} events        normalized tax events
 * @param {object}   options
 * @param {number}   [options.taxYear=2025]
 * @param {string}   [options.jurisdiction='US'] — 'US' or 'NG'
 * @param {string}   [options.method='FIFO']
 * @param {number}   [options.usdToLocalRate] — optional FX rate for display (1 USD → local units, e.g. 1500 NGN)
 * @returns full report
 */
export function calculateTaxReport(events, options = {}) {
  const taxYear = Number(options.taxYear || 2025);
  const method = options.method || 'FIFO';
  if (method !== 'FIFO') throw new Error(`Unsupported lot method: ${method}`);
  const jurisdiction = String(options.jurisdiction || 'US').toUpperCase();
  const policy = POLICIES[jurisdiction] || US_2025_POLICY;

  const lots = new Map();
  const disposals = [];
  const income = [];
  const transfers = [];
  const unresolved = [];
  const audit = [];

  const ordered = [...events].sort((a, b) => timestampValue(a.timestamp) - timestampValue(b.timestamp));

  for (const raw of ordered) {
    const event = normalize(raw);
    const eventYear = new Date(event.timestamp).getUTCFullYear();

    if (!event.id || !event.asset || !validTimestamp(event.timestamp)
        || !Number.isFinite(event.quantity) || event.quantity <= 0
        || !Number.isFinite(event.usdValue)) {
      unresolved.push(issue(event, 'INVALID_EVENT',
        'Event is missing a valid id, asset, quantity, timestamp, or USD value.'));
      continue;
    }

    const account = event.accountId || 'agentic-default';
    const key = `${account}:${event.asset}`;
    const queue = lots.get(key) || [];

    // Acquisition events.
    if (['buy', 'reward', 'staking', 'airdrop', 'income'].includes(event.type)) {
      const basis = event.usdValue + (event.type === 'buy' ? event.feeUsd : 0);
      queue.push({
        id: event.id, accountId: account, asset: event.asset,
        quantity: event.quantity, originalQuantity: event.quantity,
        unitCost: basis / event.quantity,
        acquiredAt: event.timestamp, basis,
      });
      lots.set(key, queue);
      if (event.type !== 'buy' && eventYear === taxYear) {
        income.push({
          id: event.id,
          asset: event.asset,
          quantity: event.quantity,
          receivedAt: event.timestamp,
          category: incomeCategory(event.type),
          type: event.type,
          ordinaryIncome: event.usdValue,
          basis,
        });
      }
      audit.push({
        eventId: event.id,
        action: 'LOT_CREATED',
        rule: event.type === 'buy'
          ? 'Acquisition cost plus fees entered basis.'
          : 'Ordinary income FMV entered basis.',
      });
      continue;
    }

    // Transfers / deposits / withdrawals.
    if (['transfer', 'deposit', 'withdrawal'].includes(event.type)) {
      if (event.isSelfTransfer === true) {
        transfers.push({
          ...event,
          treatment: 'Non-taxable self-transfer',
          note: event.feeAsset && event.feeQuantity ? 'Transfer fee may be a separate disposition.' : '',
        });
        audit.push({
          eventId: event.id,
          action: 'EXCLUDED',
          rule: 'Transfer between accounts owned by the same taxpayer.',
        });
      } else {
        unresolved.push(issue(event, 'OWNERSHIP_UNKNOWN',
          'Confirm ownership of the sending and receiving account before classifying this transfer.'));
      }
      continue;
    }

    if (!['sell', 'convert', 'spend', 'fee'].includes(event.type)) {
      unresolved.push(issue(event, 'UNSUPPORTED_TYPE', `Unsupported event type: ${event.type}.`));
      continue;
    }

    // Disposals: FIFO consume from the (account, asset) queue.
    let remaining = event.quantity;
    let basis = 0;
    const matchedLots = [];
    while (remaining > EPSILON && queue.length) {
      const lot = queue[0];
      const used = Math.min(remaining, lot.quantity);
      const usedBasis = used * lot.unitCost;
      basis += usedBasis;
      matchedLots.push({
        lotId: lot.id, quantity: used, basis: usedBasis,
        acquiredAt: lot.acquiredAt,
      });
      lot.quantity -= used;
      remaining -= used;
      if (lot.quantity < EPSILON) queue.shift();
    }
    if (remaining > EPSILON) {
      unresolved.push(issue(event, 'MISSING_BASIS',
        `Missing basis for ${remaining.toFixed(8)} ${event.asset}. Event excluded from totals.`));
      continue;
    }
    if (eventYear !== taxYear) continue;

    const proceeds = Math.max(0, event.usdValue - event.feeUsd);
    const gain = proceeds - basis;
    const terms = matchedLots.map((lot) => holdingTerm(lot.acquiredAt, event.timestamp));
    // If ANY consumed lot is short-term, the whole disposal reports short-term
    // (the conservative side — matches Rev. Proc. 2024-28 practice).
    const term = terms.every((t) => t === 'long-term') ? 'long-term' : 'short-term';

    disposals.push({
      id: event.id,
      description: `${event.quantity} ${event.asset}`,
      asset: event.asset,
      accountId: account,
      disposedAt: event.timestamp,
      proceeds, basis,
      adjustmentCode: '', adjustmentAmount: 0,
      gain, term,
      matchedLots,
      sourceType: event.type,
    });
    audit.push({
      eventId: event.id,
      action: 'DISPOSAL_CALCULATED',
      rule: `${event.type} is a disposition; FIFO lots matched within ${account}.`,
    });
  }

  const short = disposals.filter((d) => d.term === 'short-term');
  const long = disposals.filter((d) => d.term === 'long-term');
  const incomeByCategory = income.reduce((acc, item) => {
    acc[item.category] = round((acc[item.category] || 0) + Number(item.ordinaryIncome || 0));
    return acc;
  }, {});

  const totals = {
    proceeds:       sum(disposals, 'proceeds'),
    basis:          sum(disposals, 'basis'),
    gains:          sum(disposals, 'gain'),
    capitalGains:   positive(disposals, 'gain'),
    capitalLosses:  Math.abs(negative(disposals, 'gain')),
    shortTermNet:   sum(short, 'gain'),
    longTermNet:    sum(long, 'gain'),
    ordinaryIncome: sum(income, 'ordinaryIncome'),
  };

  const summary = jurisdictionSummary(policy, totals, incomeByCategory, options);

  return {
    policy,
    settings: {
      taxYear, method, jurisdiction,
      accountScopedLots: true,
      usdToLocalRate: options.usdToLocalRate || null,
    },
    dispositions: disposals,
    disposals,
    income,
    incomeByCategory,
    transfers,
    unresolved,
    audit,
    form8949: {
      shortTerm: short.map(form8949Row),
      longTerm:  long.map(form8949Row),
    },
    totals,
    summary,
  };
}

// ─── Jurisdictional summary ────────────────────────────────────────────────

function jurisdictionSummary(policy, totals, incomeByCategory, options) {
  const usdToLocal = Number(options.usdToLocalRate) || null;
  const localCurrency = policy.jurisdiction === 'NG' ? 'NGN' : null;

  if (policy.jurisdiction === 'NG') {
    // Nigeria: 10 % CGT on net gains. Losses can offset gains in the same year.
    // Ordinary income belongs to Personal Income Tax at the user's bracket.
    const netGainUsd = Math.max(0, totals.gains); // NG doesn't refund losses at 10%; excess losses carry per FIRS practice.
    const estimatedTaxOwedUsd = round(netGainUsd * policy.capitalGainsRate);
    return {
      jurisdiction: 'NG',
      filingReference: policy.filingForm,
      currency: policy.currency,
      localCurrency,
      usdToLocalRate: usdToLocal,
      capitalGainsRate: policy.capitalGainsRate,
      taxableCapitalGain: round(netGainUsd),
      estimatedTaxOwed: {
        usd: estimatedTaxOwedUsd,
        local: usdToLocal ? round(estimatedTaxOwedUsd * usdToLocal) : null,
      },
      ordinaryIncome: {
        usd: totals.ordinaryIncome,
        local: usdToLocal ? round(totals.ordinaryIncome * usdToLocal) : null,
        note: 'Ordinary income (staking, airdrops, rewards) is subject to Personal Income Tax at your bracket rate (7% – 24%). TaxPilot does not estimate PIT.',
      },
      notes: [
        'Nigeria applies one flat 10% Capital Gains Tax rate to digital-asset disposals (Finance Act 2023).',
        'No short/long-term distinction — every disposal is taxed at 10%.',
        'Losses within the same tax year may offset gains; unused losses may be carried forward per FIRS practice — confirm with your tax advisor.',
        'FIRS return should be filed in NGN. TaxPilot values events in USD; apply your applicable exchange rate on the disposal date for NGN reporting.',
      ],
    };
  }

  // US default.
  return {
    jurisdiction: 'US',
    filingReference: policy.filingForm,
    currency: policy.currency,
    hasHoldingPeriod: true,
    scheduleD: {
      shortTermTotalProceeds: sum(totals.shortTermNet !== undefined ? [{ proceeds: totals.proceeds }] : [], 'proceeds'), // placeholder — real Schedule D needs per-row math
      shortTermNet: totals.shortTermNet,
      longTermNet:  totals.longTermNet,
      netCapitalGain: totals.gains,
    },
    ordinaryIncome: {
      usd: totals.ordinaryIncome,
      byCategory: incomeByCategory,
      note: 'Ordinary income from staking/airdrops/rewards is taxed at your federal bracket rate. Report on Schedule 1, Line 8v (Other income → Digital assets received as ordinary income).',
    },
    notes: [
      'US federal only. State treatment varies — most conforming states adopt the federal capital-gains character.',
      'Short-term gains (held ≤ 1 year) are taxed as ordinary income; long-term gains (held > 1 year) at 0/15/20 %. TaxPilot reports the numbers; your bracket applies the rate.',
      'Wash-sale rules for digital assets are under active IRS guidance and are OUT OF SCOPE for this v1.',
      'Basis allocation is per-account (Rev. Proc. 2024-28) from 2025 onward. TaxPilot enforces this by keying FIFO lots by (accountId, asset).',
    ],
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function normalize(event) {
  return {
    ...event,
    type: String(event.type || '').toLowerCase(),
    asset: String(event.asset || '').toUpperCase(),
    quantity: Number(event.quantity),
    usdValue: Number(event.usdValue),
    feeUsd: Number(event.feeUsd || 0),
  };
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

function timestampValue(value) {
  return validTimestamp(value) ? new Date(value).getTime() : Number.POSITIVE_INFINITY;
}

function issue(event, code, reason) {
  return {
    id: event.id || 'unknown',
    code,
    asset: event.asset || null,
    timestamp: event.timestamp || null,
    reason,
  };
}

function holdingTerm(acquiredAt, disposedAt) {
  // IRS Pub 544: holding period starts the day AFTER acquisition; long-term is > 1 year.
  const acquisitionDate = new Date(acquiredAt);
  const disposalDate = new Date(disposedAt);
  acquisitionDate.setUTCDate(acquisitionDate.getUTCDate() + 1);
  const anniversary = new Date(acquisitionDate);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1);
  return disposalDate >= anniversary ? 'long-term' : 'short-term';
}

function form8949Row(item) {
  const acquired = item.matchedLots.length === 1
    ? dateOnly(item.matchedLots[0].acquiredAt)
    : 'VARIOUS';
  return {
    description: item.description,
    dateAcquired: acquired,
    dateSold: dateOnly(item.disposedAt),
    proceeds: round(item.proceeds),
    costBasis: round(item.basis),
    adjustmentCode: item.adjustmentCode,
    adjustmentAmount: item.adjustmentAmount,
    gainOrLoss: round(item.gain),
    sourceEventId: item.id,
  };
}

function incomeCategory(type) {
  if (type === 'staking') return 'Staking reward';
  if (type === 'airdrop') return 'Airdrop';
  if (type === 'reward') return 'Reward';
  return 'Other digital asset income';
}

const dateOnly = (value) => new Date(value).toISOString().slice(0, 10);
const round = (value) => Math.round((value + Number.EPSILON) * 100) / 100;
const sum = (items, key) =>
  round(items.reduce((total, item) => total + Number(item[key] || 0), 0));
const positive = (items, key) =>
  round(items.reduce((n, item) => n + Math.max(0, item[key]), 0));
const negative = (items, key) =>
  round(items.reduce((n, item) => n + Math.min(0, item[key]), 0));

// ─── Demo events ───────────────────────────────────────────────────────────

export const demoEvents = [
  { id: 'buy-btc-1', type: 'buy', accountId: 'agentic-001', asset: 'BTC', quantity: .2, usdValue: 5200, feeUsd: 12, timestamp: '2024-03-12T10:00:00Z' },
  { id: 'buy-btc-2', type: 'buy', accountId: 'agentic-001', asset: 'BTC', quantity: .16, usdValue: 7200, feeUsd: 8, timestamp: '2025-02-10T10:00:00Z' },
  { id: 'buy-eth',   type: 'buy', accountId: 'agentic-001', asset: 'ETH', quantity: 1.2, usdValue: 2160, feeUsd: 4, timestamp: '2025-01-10T10:00:00Z' },
  { id: 'staking-bnb',    type: 'staking',    accountId: 'agentic-001', asset: 'BNB',  quantity: .08, usdValue: 52,   timestamp: '2025-04-15T10:00:00Z' },
  { id: 'missing-eth',    type: 'deposit',    accountId: 'agentic-001', asset: 'ETH',  quantity: .35, usdValue: 1124, timestamp: '2025-05-18T10:00:00Z' },
  { id: 'wallet-transfer',type: 'withdrawal', accountId: 'agentic-001', asset: 'USDC', quantity: 2000, usdValue: 2000, timestamp: '2025-06-02T10:00:00Z' },
  { id: 'convert-eth',    type: 'convert',    accountId: 'agentic-001', asset: 'ETH',  quantity: 1.2, usdValue: 3840.6, feeUsd: 2.4, timestamp: '2025-07-04T10:00:00Z' },
  { id: 'sell-btc',       type: 'sell',       accountId: 'agentic-001', asset: 'BTC',  quantity: .18, usdValue: 20412, feeUsd: 20, timestamp: '2025-08-21T10:00:00Z' },
];
