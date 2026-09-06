import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Storage } from '../src/storage.js';
import { saveReport, listReports, getReport, applyDecisions, historicalLotsToEvents, snapshotId } from '../src/reports.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxpilot-reports-'));
  return { storage: new Storage({ dataDir: dir }), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const events2025 = [
  { id: 'buy-btc', type: 'buy', accountId: 'a1', asset: 'BTC', quantity: 0.5, usdValue: 20000, timestamp: '2025-01-05T00:00:00Z' },
  { id: 'sell-btc', type: 'sell', accountId: 'a1', asset: 'BTC', quantity: 0.5, usdValue: 25000, timestamp: '2025-06-01T00:00:00Z' },
];

test('snapshotId is deterministic over identical inputs and changes when any input changes', () => {
  const a = snapshotId({ events: events2025, decisions: [], historicalLots: [], taxYear: 2025 });
  const b = snapshotId({ events: events2025, decisions: [], historicalLots: [], taxYear: 2025 });
  assert.equal(a, b);
  const c = snapshotId({ events: events2025, decisions: [{ eventId: 'x', action: 'ignore' }], historicalLots: [], taxYear: 2025 });
  assert.notEqual(a, c);
  const d = snapshotId({ events: events2025, decisions: [], historicalLots: [], taxYear: 2024 });
  assert.notEqual(a, d);
});

test('saveReport is idempotent: saving twice with same inputs returns the same record', async () => {
  const { storage, cleanup } = tmpStore();
  const store = storage.collection('reports');
  const first = await saveReport(store, 'user-1', { events: events2025, taxYear: 2025 });
  const second = await saveReport(store, 'user-1', { events: events2025, taxYear: 2025 });
  assert.equal(first.id, second.id);
  assert.equal(listReports(store, 'user-1').length, 1);
  cleanup();
});

test('applyDecisions replays each action verb on the event stream', () => {
  const events = [
    { id: 'e1', type: 'withdrawal', asset: 'BTC', quantity: 1, timestamp: '2025-01-01' },
    { id: 'e2', type: 'deposit', asset: 'ETH', quantity: 2, timestamp: '2025-01-02' },
    { id: 'e3', type: 'buy', asset: 'BNB', quantity: 3, usdValue: 100, timestamp: '2025-01-03' },
    { id: 'e4', type: 'reward', asset: 'ATOM', quantity: 5, timestamp: '2025-01-04' },
  ];
  const decisions = [
    { eventId: 'e1', action: 'confirm_self_transfer' },
    { eventId: 'e2', action: 'ignore' },
    { eventId: 'e3', action: 'set_basis', usdValue: 250, feeUsd: 1 },
    { eventId: 'e4', action: 'set_income', usdValue: 42, incomeType: 'staking' },
  ];
  const out = applyDecisions(events, decisions);
  assert.equal(out.length, 3); // e2 dropped
  assert.equal(out.find((e) => e.id === 'e1').isSelfTransfer, true);
  const e3 = out.find((e) => e.id === 'e3');
  assert.equal(e3.usdValue, 250);
  assert.equal(e3.feeUsd, 1);
  const e4 = out.find((e) => e.id === 'e4');
  assert.equal(e4.type, 'staking');
  assert.equal(e4.usdValue, 42);
});

test('historicalLotsToEvents produces buy events with the lot metadata preserved', () => {
  const lots = [{ asset: 'BTC', quantity: 0.1, usdValue: 3000, acquiredAt: '2023-05-01T00:00:00Z' }];
  const events = historicalLotsToEvents(lots, { accountId: 'a1' });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'buy');
  assert.equal(events[0].asset, 'BTC');
  assert.equal(events[0].accountId, 'a1');
  assert.equal(events[0]._historicalLot, true);
});

test('saveReport with a historical lot supplies basis for a disposal that would otherwise be unresolved', async () => {
  const { storage, cleanup } = tmpStore();
  const store = storage.collection('reports');
  const disposalOnly = [{ id: 'sell-eth', type: 'sell', accountId: 'a1', asset: 'ETH', quantity: 1, usdValue: 4000, timestamp: '2025-04-01T00:00:00Z' }];
  const noLot = await saveReport(store, 'u', { events: disposalOnly, taxYear: 2025 });
  assert.equal(noLot.report.unresolved.length, 1);
  assert.equal(noLot.report.disposals.length, 0);
  const withLot = await saveReport(store, 'u', {
    events: disposalOnly, taxYear: 2025,
    // Lot must be scoped to the same account as the disposal — the tax engine
    // consumes FIFO lots per (accountId, asset) pair (Rev. Proc. 2024-28).
    historicalLots: [{ asset: 'ETH', quantity: 1, usdValue: 2000, acquiredAt: '2023-01-01T00:00:00Z', accountId: 'a1' }],
  });
  assert.equal(withLot.report.unresolved.length, 0);
  assert.equal(withLot.report.disposals.length, 1);
  assert.equal(withLot.report.disposals[0].basis, 2000);
  assert.equal(withLot.report.disposals[0].gain, 2000);
  cleanup();
});

test('listReports and getReport are user-scoped and never leak across users', async () => {
  const { storage, cleanup } = tmpStore();
  const store = storage.collection('reports');
  const a = await saveReport(store, 'user-a', { events: events2025, taxYear: 2025 });
  const differentEvents = [{ id: 'other-buy', type: 'buy', accountId: 'a1', asset: 'BTC', quantity: 1, usdValue: 30000, timestamp: '2025-02-01T00:00:00Z' }];
  await saveReport(store, 'user-b', { events: differentEvents, taxYear: 2025 });
  assert.equal(listReports(store, 'user-a').length, 1);
  assert.equal(listReports(store, 'user-b').length, 1);
  assert.equal(getReport(store, 'user-a', a.id).userId, 'user-a');
  // user-b's report has a different snapshot id because inputs differ, so
  // querying user-b for user-a's id must miss:
  assert.equal(getReport(store, 'user-b', a.id), null);
  // And listReports never returns another user's records:
  assert.ok(!listReports(store, 'user-b').some((r) => r.id === a.id));
  cleanup();
});
