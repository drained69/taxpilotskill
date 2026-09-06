import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, splitCsvLine, csvRowsToRecords, csvToRecords } from '../src/csv-import.js';

test('splitCsvLine handles quoted commas and escaped quotes', () => {
  assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvLine('"a,b",c'), ['a,b', 'c']);
  assert.deepEqual(splitCsvLine('"say ""hi""","next"'), ['say "hi"', 'next']);
  assert.deepEqual(splitCsvLine('a,,c'), ['a', '', 'c']);
});

test('parseCsv strips BOM and normalizes headers to internal aliases', () => {
  const csv = '﻿UTC_Time,Account,Operation,Coin,Change\n2025-01-01 12:00:00,Spot,Deposit,BTC,0.5\n';
  const { headers, rows } = parseCsv(csv);
  assert.deepEqual(headers, ['time', 'account', 'operation', 'coin', 'amount']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, '2025-01-01 12:00:00');
  assert.equal(rows[0].coin, 'BTC');
  assert.equal(rows[0].amount, '0.5');
});

test('csvRowsToRecords converts a universal transaction CSV to typed records', () => {
  const csv = [
    'UTC_Time,Account,Operation,Coin,Change',
    '2025-01-01 12:00:00,Spot,Deposit,BTC,0.5',
    '2025-02-15 09:30:00,Spot,Staking Rewards,BNB,0.01',
    '2025-03-20 08:00:00,Spot,Transfer Between Main and Sub Account,USDT,100',
    '2025-04-10 10:15:00,Spot,SomethingWeird,ETH,1',
  ].join('\n');
  const { rows } = parseCsv(csv);
  const { records, skipped } = csvRowsToRecords(rows);
  assert.equal(records.length, 3);
  assert.equal(skipped.length, 1);
  assert.equal(records[0]._typeHint, 'deposit');
  assert.equal(records[1]._typeHint, 'staking');
  assert.equal(records[2]._typeHint, 'transfer');
  assert.equal(records[2].isInternal, true);
  assert.match(skipped[0].reason, /Unknown Operation/);
});

test('csvRowsToRecords converts a spot trade CSV to isBuyer/symbol shape', () => {
  const csv = [
    'Date(UTC),Pair,Side,Price,Executed,Amount,Fee,Fee Coin',
    '2025-06-01 12:00:00,BTCUSDT,BUY,50000,0.1,5000,5,USDT',
    '2025-07-01 12:00:00,BTCUSDT,SELL,60000,0.1,6000,6,USDT',
  ].join('\n');
  const { records } = csvToRecords(csv);
  assert.equal(records.length, 2);
  assert.equal(records[0].symbol, 'BTCUSDT');
  assert.equal(records[0].side, 'BUY');
  assert.equal(records[0].qty, '0.1');
  assert.equal(records[0].price, '50000');
  assert.equal(records[1].side, 'SELL');
});

test('csvToRecords end-to-end produces records the normalizer can consume', async () => {
  const { normalizeRecords } = await import('../src/normalize.js');
  const csv = [
    'UTC_Time,Account,Operation,Coin,Change',
    '2025-01-01 12:00:00,Spot,Buy,BTC,0.5',
    '2025-06-01 12:00:00,Spot,Sell,BTC,0.5',
  ].join('\n');
  const { records } = csvToRecords(csv);
  const { events } = normalizeRecords(records, {});
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'buy');
  assert.equal(events[0].asset, 'BTC');
  assert.equal(events[1].type, 'sell');
});
