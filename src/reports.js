// Report + review-decision persistence.
//
// Every computed report is versioned by (policy version, engine version,
// source snapshot hash, decisions hash). Two identical inputs produce the same
// snapshot ID, so a re-sync that changes nothing does not spawn a new record.
//
// Decisions on unresolved events are stored per user and re-applied on every
// recalculation. Historical lots imported by the user are stored the same way
// and merged into the event stream before the tax engine runs.

import crypto from 'node:crypto';
import { calculateTaxReport, US_2025_POLICY, POLICIES } from './tax-engine.js';

const ENGINE_VERSION = '1.2.0';

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
}

function stable(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.keys(value).sort().reduce((acc, key) => { acc[key] = stable(value[key]); return acc; }, {});
}

/**
 * Merge user decisions and imported historical lots into the raw event stream
 * before the tax engine runs.
 *
 * Decision shape:
 *   { eventId, action, ... }
 *     action='confirm_self_transfer'    → sets isSelfTransfer=true
 *     action='confirm_external_transfer'→ removes the event from the stream (treated as a normal sale via `sell` type in a follow-up decision)
 *     action='set_basis'                → attaches basis USD to a specific event
 *     action='set_income'               → reclassifies event as reward/staking/airdrop/income
 *     action='ignore'                   → drops the event
 */
export function applyDecisions(events, decisions = []) {
  const byId = new Map(decisions.map((d) => [d.eventId, d]));
  const output = [];
  for (const raw of events) {
    const decision = byId.get(raw.id);
    if (!decision) { output.push(raw); continue; }
    if (decision.action === 'ignore') continue;
    if (decision.action === 'confirm_self_transfer') {
      output.push({ ...raw, isSelfTransfer: true, _decisionApplied: decision.action });
      continue;
    }
    if (decision.action === 'confirm_external_transfer') {
      // A withdrawal that leaves the taxpayer's control is a disposition.
      output.push({ ...raw, type: 'sell', usdValue: decision.usdValue ?? raw.usdValue, _decisionApplied: decision.action });
      continue;
    }
    if (decision.action === 'set_basis') {
      output.push({ ...raw, usdValue: Number(decision.usdValue), feeUsd: Number(decision.feeUsd || raw.feeUsd || 0), _decisionApplied: decision.action });
      continue;
    }
    if (decision.action === 'set_income') {
      const incomeType = ['reward', 'staking', 'airdrop', 'income'].includes(decision.incomeType) ? decision.incomeType : 'income';
      output.push({ ...raw, type: incomeType, usdValue: Number(decision.usdValue ?? raw.usdValue), _decisionApplied: decision.action });
      continue;
    }
    output.push(raw); // unknown action → pass through unchanged
  }
  return output;
}

/**
 * Historical lots are just synthetic `buy` events from before the tax year;
 * they enter the FIFO queue and provide basis for later disposals.
 */
export function historicalLotsToEvents(lots = [], { accountId = 'agentic-default' } = {}) {
  return lots.map((lot, i) => ({
    id: lot.id || `historical-lot-${i}`,
    type: 'buy',
    accountId: lot.accountId || accountId,
    asset: String(lot.asset || '').toUpperCase(),
    quantity: Number(lot.quantity),
    usdValue: Number(lot.usdValue),
    feeUsd: Number(lot.feeUsd || 0),
    timestamp: lot.acquiredAt || lot.timestamp,
    _historicalLot: true,
  }));
}

/**
 * Compute the deterministic snapshot ID for the input triple. Same inputs →
 * same ID. Two reports with the same ID are byte-identical.
 */
export function snapshotId({ events, decisions = [], historicalLots = [], policy = US_2025_POLICY, taxYear, jurisdiction }) {
  return sha256({
    policyVersion: policy.version,
    engineVersion: ENGINE_VERSION,
    jurisdiction: jurisdiction || policy.jurisdiction,
    taxYear,
    events: stable(events),
    decisions: stable(decisions),
    historicalLots: stable(historicalLots),
  }).slice(0, 24);
}

/**
 * Persist a report snapshot. Idempotent: writing the same snapshot twice is a
 * no-op and returns the existing record.
 */
export async function saveReport(store, userId, { events, decisions = [], historicalLots = [], taxYear, jurisdiction = 'US', usdToLocalRate = null, provenance = null }) {
  const juris = String(jurisdiction || 'US').toUpperCase();
  const policy = POLICIES[juris] || US_2025_POLICY;
  const id = snapshotId({ events, decisions, historicalLots, taxYear, jurisdiction: juris });
  const key = `${userId}:${id}`;
  const existing = store.get(key);
  if (existing) return existing;

  const merged = applyDecisions([...historicalLotsToEvents(historicalLots), ...events], decisions);
  const report = calculateTaxReport(merged, { taxYear, jurisdiction: juris, usdToLocalRate });
  const record = {
    id,
    userId,
    taxYear,
    jurisdiction: juris,
    engineVersion: ENGINE_VERSION,
    policyVersion: report.policy.version,
    createdAt: new Date().toISOString(),
    provenance,
    decisionCount: decisions.length,
    historicalLotCount: historicalLots.length,
    report,
  };
  await store.set(key, record);
  return record;
}

export function listReports(store, userId) {
  return store.entries()
    .filter(([key]) => key.startsWith(`${userId}:`))
    .map(([, record]) => ({
      id: record.id, taxYear: record.taxYear, createdAt: record.createdAt,
      jurisdiction: record.jurisdiction || 'US',
      engineVersion: record.engineVersion, policyVersion: record.policyVersion,
      decisionCount: record.decisionCount, historicalLotCount: record.historicalLotCount,
      totals: record.report.totals,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getReport(store, userId, id) {
  return store.get(`${userId}:${id}`);
}

export { ENGINE_VERSION };
