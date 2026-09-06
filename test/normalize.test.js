import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecord, normalizeRecords, extractRecords, isUsdStable } from '../src/normalize.js';

test('normalize: a USDT-quoted sell fill carries its USD value', () => {
  const { event } = normalizeRecord({
    tradeId: 991,
    side: 'SELL',
    baseAsset: 'BTC',
    executedQty: '0.5',
    quoteAsset: 'USDT',
    cummulativeQuoteQty: '30000',
    commission: '15',
    commissionAsset: 'USDT',
    time: Date.UTC(2025, 7, 21, 10, 0, 0),
    subAccountId: 'agentic-001',
  });
  assert.equal(event.type, 'sell');
  assert.equal(event.asset, 'BTC');
  assert.equal(event.quantity, 0.5);
  assert.equal(event.usdValue, 30000);
  assert.equal(event.feeUsd, 15);
  assert.equal(event.accountId, 'agentic-001');
  assert.equal(event.timestamp, '2025-08-21T10:00:00.000Z');
});

test('normalize: a convert record disposes the source leg', () => {
  const { event } = normalizeRecord({
    tranId: 5,
    type: 'convert',
    fromAsset: 'ETH',
    fromAmount: '1.2',
    toAsset: 'USDC',
    toAmount: '3840.6',
    createTime: 1_720_087_200_000,
  });
  assert.equal(event.type, 'convert');
  assert.equal(event.asset, 'ETH');
  assert.equal(event.quantity, 1.2);
  assert.equal(event.usdValue, 3840.6); // valued off the USDC leg
});

test('normalize: staking reward maps to income type without USD leg', () => {
  const { event } = normalizeRecord({ id: 'r1', type: 'staking-reward', asset: 'BNB', amount: '0.08', time: 1_744_711_200_000 });
  assert.equal(event.type, 'staking');
  assert.equal(event.usdValue, undefined); // needs pricing enrichment
});

test('normalize: epoch seconds and internal transfer flag', () => {
  const { event } = normalizeRecord({ id: 'w1', type: 'withdrawal', coin: 'USDC', amount: '2000', timestamp: Math.floor(Date.UTC(2024, 5, 2, 10, 0, 0) / 1000), transferType: 'internal' });
  assert.equal(event.type, 'withdrawal');
  assert.equal(event.isSelfTransfer, true);
  assert.equal(event.timestamp, '2024-06-02T10:00:00.000Z');
});

test('normalize: non-object records are skipped, not thrown', () => {
  const { events, skipped } = normalizeRecords([null, 'x', { id: 'ok', type: 'buy', asset: 'BTC', amount: 1, usdValue: 100, time: 1 }]);
  assert.equal(events.length, 1);
  assert.equal(skipped.length, 2);
});

test('extractRecords unwraps common envelope keys', () => {
  assert.equal(extractRecords({ transactions: [1, 2] }).length, 2);
  assert.equal(extractRecords({ data: [1] }).length, 1);
  assert.equal(extractRecords([9]).length, 1);
  assert.equal(extractRecords({ single: 'record' }).length, 1);
  assert.equal(isUsdStable('usdc'), true);
  assert.equal(isUsdStable('BTC'), false);
});
