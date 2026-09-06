import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Storage, JsonCollection, AppendLog } from '../src/storage.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taxpilot-store-'));
}

test('JsonCollection persists entries across instances', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'reports.json');
  const first = new JsonCollection(file);
  await first.set('u1', { value: 1 });
  await first.set('u2', { value: 2 });

  const second = new JsonCollection(file);
  assert.deepEqual(second.get('u1'), { value: 1 });
  assert.deepEqual(second.get('u2'), { value: 2 });

  await second.delete('u1');
  const third = new JsonCollection(file);
  assert.equal(third.get('u1'), null);
  assert.deepEqual(third.get('u2'), { value: 2 });

  fs.rmSync(dir, { recursive: true, force: true });
});

test('JsonCollection returns cloned values so callers cannot mutate storage', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'items.json');
  const store = new JsonCollection(file);
  await store.set('k', { nested: { count: 1 } });
  const returned = store.get('k');
  returned.nested.count = 999;
  assert.equal(store.get('k').nested.count, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('JsonCollection recovers from a corrupt file by moving it aside', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{not json');
  const store = new JsonCollection(file);
  assert.equal(store.get('anything'), null);
  const backup = fs.readdirSync(dir).find((name) => name.startsWith('bad.json.corrupt.'));
  assert.ok(backup, 'expected a corrupt backup');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('AppendLog serializes writes and reads back a filtered tail', async () => {
  const dir = tmpDir();
  const log = new AppendLog(path.join(dir, 'audit.jsonl'));
  await Promise.all([
    log.append({ action: 'a', userId: 'u1' }),
    log.append({ action: 'b', userId: 'u2' }),
    log.append({ action: 'c', userId: 'u1' }),
  ]);
  const all = log.read();
  assert.equal(all.length, 3);
  assert.ok(all[0].ts, 'entries carry a timestamp');
  const u1 = log.read({ filter: (e) => e.userId === 'u1' });
  assert.equal(u1.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Storage lazily materializes named collections and shares an audit log', async () => {
  const dir = tmpDir();
  const storage = new Storage({ dataDir: dir });
  const reports = storage.collection('reports');
  assert.ok(reports instanceof JsonCollection);
  assert.equal(storage.collection('reports'), reports, 'same instance on repeat access');
  await storage.audit.append({ action: 'test' });
  assert.equal(storage.audit.read().length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
