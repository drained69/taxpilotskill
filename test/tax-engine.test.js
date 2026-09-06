import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTaxReport, demoEvents, US_2025_POLICY, NG_2025_POLICY, POLICIES } from '../src/tax-engine.js';

test('tax-engine: FIFO basis, gains, terms, and unresolved', () => {
const report = calculateTaxReport([
  { id: 'a', type: 'buy', asset: 'BTC', quantity: 1, usdValue: 100, timestamp: '2023-01-01T00:00:00Z' },
  { id: 'b', type: 'buy', asset: 'BTC', quantity: 1, usdValue: 300, timestamp: '2024-01-01T00:00:00Z' },
  { id: 'c', type: 'sell', asset: 'BTC', quantity: 1.5, usdValue: 600, timestamp: '2024-06-01T00:00:00Z' },
  { id: 'd', type: 'sell', asset: 'ETH', quantity: 1, usdValue: 10, timestamp: '2024-06-02T00:00:00Z' }
], { taxYear: 2024 });
assert.equal(report.totals.basis, 250);
assert.equal(report.totals.gains, 350);
assert.equal(report.disposals[0].term, 'short-term');
assert.equal(report.unresolved[0].id, 'd');
assert.equal(calculateTaxReport(demoEvents).disposals.length, 2);
assert.equal(calculateTaxReport(demoEvents).income[0].ordinaryIncome, 52);
assert.equal(calculateTaxReport(demoEvents).form8949.longTerm.length, 1);
const longOnly = calculateTaxReport([
  { id: 'buy', type: 'buy', asset: 'BTC', quantity: 1, usdValue: 100, timestamp: '2023-01-01T00:00:00Z' },
  { id: 'sell', type: 'sell', asset: 'BTC', quantity: 1, usdValue: 200, timestamp: '2024-01-03T00:00:00Z' }
], { taxYear: 2024 });
assert.equal(longOnly.disposals[0].term, 'long-term');
});

test('tax-engine flags invalid timestamps without throwing', () => {
  const report = calculateTaxReport([
    { id: 'bad-time', type: 'buy', asset: 'BTC', quantity: 1, usdValue: 100, timestamp: 'not-a-date' },
  ]);
  assert.equal(report.unresolved[0].code, 'INVALID_EVENT');
});

test('POLICIES exposes both US and NG jurisdictions', () => {
  assert.equal(POLICIES.US, US_2025_POLICY);
  assert.equal(POLICIES.NG, NG_2025_POLICY);
  assert.equal(NG_2025_POLICY.capitalGainsRate, 0.10);
  assert.equal(NG_2025_POLICY.hasHoldingPeriod, false);
});

test('US report includes a Schedule D summary and income-by-category breakdown', () => {
  const events = [
    { id: 'buy',  type: 'buy',     asset: 'BTC', quantity: 1, usdValue: 1000, timestamp: '2023-01-01T00:00:00Z' },
    { id: 'sell', type: 'sell',    asset: 'BTC', quantity: 1, usdValue: 3000, timestamp: '2025-06-01T00:00:00Z' },
    { id: 'stk',  type: 'staking', asset: 'BNB', quantity: 1, usdValue: 100,  timestamp: '2025-04-01T00:00:00Z' },
    { id: 'air',  type: 'airdrop', asset: 'FOO', quantity: 5, usdValue: 50,   timestamp: '2025-05-01T00:00:00Z' },
  ];
  const report = calculateTaxReport(events, { taxYear: 2025, jurisdiction: 'US' });
  assert.equal(report.settings.jurisdiction, 'US');
  assert.equal(report.summary.jurisdiction, 'US');
  assert.equal(report.summary.scheduleD.netCapitalGain, 2000);
  assert.equal(report.summary.scheduleD.longTermNet, 2000);
  assert.equal(report.summary.scheduleD.shortTermNet, 0);
  assert.equal(report.incomeByCategory['Staking reward'], 100);
  assert.equal(report.incomeByCategory['Airdrop'], 50);
  assert.equal(report.summary.ordinaryIncome.byCategory['Staking reward'], 100);
});

test('NG report applies 10% CGT and skips holding-period split', () => {
  const events = [
    { id: 'buy',  type: 'buy',  asset: 'BTC', quantity: 1, usdValue: 1000, timestamp: '2023-01-01T00:00:00Z' },
    { id: 'sell', type: 'sell', asset: 'BTC', quantity: 1, usdValue: 3000, timestamp: '2025-06-01T00:00:00Z' },
  ];
  const report = calculateTaxReport(events, { taxYear: 2025, jurisdiction: 'NG' });
  assert.equal(report.settings.jurisdiction, 'NG');
  assert.equal(report.summary.jurisdiction, 'NG');
  assert.equal(report.summary.capitalGainsRate, 0.10);
  assert.equal(report.summary.taxableCapitalGain, 2000);
  assert.equal(report.summary.estimatedTaxOwed.usd, 200); // 10% of $2,000
  assert.equal(report.summary.filingReference, 'FIRS Capital Gains Tax return');
  assert.match(report.summary.notes.join(' '), /Finance Act 2023/);
});

test('NG report converts estimated tax to NGN when usdToLocalRate provided', () => {
  const events = [
    { id: 'buy',  type: 'buy',  asset: 'BTC', quantity: 1, usdValue: 1000, timestamp: '2023-01-01T00:00:00Z' },
    { id: 'sell', type: 'sell', asset: 'BTC', quantity: 1, usdValue: 3000, timestamp: '2025-06-01T00:00:00Z' },
  ];
  const report = calculateTaxReport(events, { taxYear: 2025, jurisdiction: 'NG', usdToLocalRate: 1500 });
  assert.equal(report.summary.estimatedTaxOwed.usd, 200);
  assert.equal(report.summary.estimatedTaxOwed.local, 300_000); // 200 USD × 1500 NGN/USD
});

test('NG losses do not produce a negative tax owed', () => {
  const events = [
    { id: 'buy',  type: 'buy',  asset: 'BTC', quantity: 1, usdValue: 5000, timestamp: '2023-01-01T00:00:00Z' },
    { id: 'sell', type: 'sell', asset: 'BTC', quantity: 1, usdValue: 2000, timestamp: '2025-06-01T00:00:00Z' },
  ];
  const report = calculateTaxReport(events, { taxYear: 2025, jurisdiction: 'NG' });
  assert.equal(report.summary.taxableCapitalGain, 0);
  assert.equal(report.summary.estimatedTaxOwed.usd, 0);
});
