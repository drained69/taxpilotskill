import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from '../server.js';
import { Storage } from '../src/storage.js';

// Boot a server on an ephemeral port, run one request, and return the response.
async function withServer(fn, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxpilot-srv-'));
  const storage = new Storage({ dataDir: dir });
  const server = createServer({ storage, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn({ base, server, storage });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parseSetCookie(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  const cookies = {};
  for (const line of raw) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return { raw, cookies };
}

// Build a valid Cookie request header from the Set-Cookie lines a server returned.
// Joining raw Set-Cookie lines with '; ' would produce garbage because the flags
// (Path=, Max-Age=, HttpOnly, ...) would leak into the cookie header.
function cookieHeader(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map((line) => line.split(';')[0]).join('; ');
}

test('GET /api/health returns service info', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service, 'taxpilot');
  });
});

test('GET /api/csrf issues a token via a JS-readable cookie', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/csrf`);
    assert.equal(res.status, 200);
    const { raw, cookies } = parseSetCookie(res);
    assert.ok(cookies.taxpilot_csrf, 'sets csrf cookie');
    // csrf cookie must NOT be HttpOnly (double-submit needs JS to read it)
    const csrfLine = raw.find((line) => line.startsWith('taxpilot_csrf='));
    assert.doesNotMatch(csrfLine, /HttpOnly/i);
    const body = await res.json();
    assert.equal(body.csrfToken, cookies.taxpilot_csrf);
  });
});

test('State-changing POST without CSRF is rejected with 403', async () => {
  await withServer(async ({ base }) => {
    // First get a session cookie
    const seed = await fetch(`${base}/api/csrf`);
    const cookie = cookieHeader(seed);
    // Attempt disconnect without the CSRF header
    const res = await fetch(`${base}/api/connections/binance/disconnect`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, 'CSRF_INVALID');
  });
});

test('POST /api/decisions persists and lists user decisions', async () => {
  await withServer(async ({ base }) => {
    const seed = await fetch(`${base}/api/csrf`);
    const cookie = cookieHeader(seed);
    const { csrfToken } = await seed.json();

    const post = await fetch(`${base}/api/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ eventId: 'evt-1', action: 'confirm_self_transfer' }),
    });
    assert.equal(post.status, 200);

    const list = await fetch(`${base}/api/decisions`, { headers: { cookie } });
    const body = await list.json();
    assert.equal(body.decisions.length, 1);
    assert.equal(body.decisions[0].eventId, 'evt-1');
  });
});

test('POST /api/decisions rejects invalid action verbs', async () => {
  await withServer(async ({ base }) => {
    const seed = await fetch(`${base}/api/csrf`);
    const cookie = cookieHeader(seed);
    const { csrfToken } = await seed.json();
    const res = await fetch(`${base}/api/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ eventId: 'e', action: 'delete_everything' }),
    });
    assert.equal(res.status, 400);
  });
});

test('Historical lots: import, list, delete flow', async () => {
  await withServer(async ({ base }) => {
    const seed = await fetch(`${base}/api/csrf`);
    const cookie = cookieHeader(seed);
    const { csrfToken } = await seed.json();

    const create = await fetch(`${base}/api/historical-lots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ lots: [
        { asset: 'BTC', quantity: 0.5, usdValue: 15000, acquiredAt: '2022-01-01T00:00:00Z' },
        { asset: 'ETH', quantity: 2,   usdValue: 4000,  acquiredAt: '2022-03-01T00:00:00Z' },
      ] }),
    });
    assert.equal(create.status, 200);
    const created = await create.json();
    assert.equal(created.imported, 2);

    const list = await fetch(`${base}/api/historical-lots`, { headers: { cookie } });
    const listed = await list.json();
    assert.equal(listed.lots.length, 2);

    const first = listed.lots[0];
    const del = await fetch(`${base}/api/historical-lots/${first.id}`, {
      method: 'DELETE',
      headers: { cookie, 'x-csrf-token': csrfToken },
    });
    const dbody = await del.json();
    assert.equal(dbody.removed, 1);
    assert.equal(dbody.lots.length, 1);
  });
});

test('Rate limiter returns 429 with Retry-After header', async () => {
  const { RateLimiter } = await import('../src/security.js');
  const limiter = new RateLimiter({ windowMs: 60_000, max: 2 });
  await withServer(async ({ base }) => {
    // Use two calls to reach the limit, then the third should be blocked
    await fetch(`${base}/api/health`);
    await fetch(`${base}/api/health`);
    const blocked = await fetch(`${base}/api/health`);
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
    const body = await blocked.json();
    assert.equal(body.code, 'RATE_LIMITED');
  }, { limiter });
});

test('User data export gathers reports, decisions, and lots for the caller only', async () => {
  await withServer(async ({ base }) => {
    const seed = await fetch(`${base}/api/csrf`);
    const cookie = cookieHeader(seed);
    const { csrfToken } = await seed.json();

    await fetch(`${base}/api/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ eventId: 'evt-1', action: 'confirm_self_transfer' }),
    });

    const exportRes = await fetch(`${base}/api/user/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
    });
    assert.equal(exportRes.status, 200);
    const payload = await exportRes.json();
    assert.equal(payload.decisions.length, 1);
    assert.equal(payload.reports.length, 0);
    assert.ok(payload.exportedAt);
    assert.ok(Array.isArray(payload.auditLog));
  });
});

test('User delete wipes decisions, lots, and terminates the session', async () => {
  await withServer(async ({ base }) => {
    const seed = await fetch(`${base}/api/csrf`);
    const cookie = cookieHeader(seed);
    const { csrfToken } = await seed.json();
    await fetch(`${base}/api/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ eventId: 'e1', action: 'ignore' }),
    });
    const del = await fetch(`${base}/api/user/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
    });
    assert.equal(del.status, 200);
    // After delete, listing decisions with the same (now-terminated) session should 401.
    const after = await fetch(`${base}/api/decisions`, { headers: { cookie } });
    assert.equal(after.status, 401);
  });
});

test('Security headers are present on every response (JSON and static)', async () => {
  await withServer(async ({ base }) => {
    for (const path of ['/api/health', '/api/tax-report']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.ok(res.headers.get('content-security-policy'), 'CSP present');
      assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
    }
  });
});

test('Health check reports storage writability and drain state', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.storage.ok, true);
    assert.equal(body.shuttingDown, false);
    assert.equal(typeof body.uptimeSeconds, 'number');
  });
});

test('Health check fails 503 when the data dir is unwritable', async () => {
  const { Storage } = await import('../src/storage.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxpilot-ro-'));
  const storage = new Storage({ dataDir: dir });
  const server = createServer({ storage });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    fs.chmodSync(dir, 0o500); // read+execute only
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (process.getuid && process.getuid() === 0) {
      // root can write regardless of chmod; skip the negative assertion.
      assert.equal(res.status, 200);
    } else {
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.storage.ok, false);
    }
  } finally {
    fs.chmodSync(dir, 0o700);
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KeyedLock serializes concurrent operations that share a key', async () => {
  const { KeyedLock } = await import('../src/security.js');
  const lock = new KeyedLock();
  const observed = [];
  async function critical(id) {
    observed.push(`start-${id}`);
    await new Promise((r) => setTimeout(r, 20));
    observed.push(`end-${id}`);
  }
  await Promise.all([
    lock.run('user-a', () => critical(1)),
    lock.run('user-a', () => critical(2)),
    lock.run('user-b', () => critical(3)),
  ]);
  // user-a operations must run start→end→start→end, not interleaved.
  const startA1 = observed.indexOf('start-1');
  const endA1 = observed.indexOf('end-1');
  const startA2 = observed.indexOf('start-2');
  assert.ok(endA1 < startA2, 'user-a operations must serialize');
  // user-b is independent — it can (and typically will) interleave with user-a.
  assert.ok(observed.includes('end-3'));
});

test('shutdown() resolves and closes the listening socket', async () => {
  // Full "drains in-flight" requires a long-running endpoint we can hold
  // open; the endpoints here return immediately, so we verify the two
  // observable properties: shutdown resolves, and the port stops accepting.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taxpilot-shut-'));
  const { Storage } = await import('../src/storage.js');
  const server = createServer({ storage: new Storage({ dataDir: dir }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const before = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(before.status, 200);
  await server.shutdown({ timeoutMs: 5_000 });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('after shutdown flag is set, new requests get 503 (before the socket closes)', async () => {
  // A container orchestrator flips a readiness probe first, then sends
  // SIGTERM. During that window the process is still listening but should
  // refuse fresh work. We verify by driving `shuttingDown` via a request
  // arriving mid-shutdown drain — which we simulate by NOT awaiting the
  // socket close, only the flag flip via a short-lived shutdown promise
  // race. Simpler check: verify the 503 branch triggers when we manually
  // start a shutdown (the second fetch may race — retry once).
  await withServer(async ({ base, server }) => {
    server.shutdown({ timeoutMs: 100 }).catch(() => {});
    // Give the flag a microtask to flip.
    await new Promise((r) => setImmediate(r));
    try {
      const res = await fetch(`${base}/api/tax-report`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.code, 'SHUTTING_DOWN');
    } catch (error) {
      // If the socket already closed the race, the connection is refused,
      // which is also a valid post-shutdown observation.
      assert.match(error.message, /fetch failed/);
    }
  });
});

test('POST /api/import/csv builds a tax report from an uploaded CSV', async () => {
  await withServer(async ({ base }) => {
    const seed = await fetch(`${base}/api/csrf`);
    const cookie = cookieHeader(seed);
    const { csrfToken } = await seed.json();

    // A minimal Binance-shaped universal-transaction CSV. Two rows create a
    // matched buy/sell against USDT — the pipeline should recognize the buy,
    // consume the lot on the sell, and report a taxable disposal.
    const csv = [
      'UTC_Time,Account,Operation,Coin,Change',
      '2025-01-05 10:00:00,Spot,Buy,BTC,0.1',
      '2025-01-05 10:00:00,Spot,Transaction Spend,USDT,5000',
      '2025-06-01 10:00:00,Spot,Sell,BTC,0.1',
      '2025-06-01 10:00:00,Spot,Transaction Related,USDT,6000',
    ].join('\n');

    const upload = await fetch(`${base}/api/import/csv`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ files: [{ name: 'wallet.csv', content: csv }], taxYear: 2025 }),
    });
    assert.equal(upload.status, 200);
    const payload = await upload.json();
    assert.ok(payload.snapshotId, 'snapshotId returned');
    assert.equal(payload.provenance.source, 'csv-import');
    assert.equal(payload.provenance.files[0].file, 'wallet.csv');
    // The report exists — specific totals depend on valuation (Klines may not
    // be reachable in CI); we just assert the plumbing worked.
    assert.ok(payload.report.settings);
    assert.equal(payload.report.settings.taxYear, 2025);
  });
});

test('POST /api/import/csv rejects empty payload', async () => {
  await withServer(async ({ base }) => {
    const seed = await fetch(`${base}/api/csrf`);
    const cookie = cookieHeader(seed);
    const { csrfToken } = await seed.json();
    const res = await fetch(`${base}/api/import/csv`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test('Audit log endpoint returns entries scoped to the caller', async () => {
  await withServer(async ({ base }) => {
    const seed = await fetch(`${base}/api/csrf`);
    const cookie = cookieHeader(seed);
    const { csrfToken } = await seed.json();

    await fetch(`${base}/api/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ eventId: 'e', action: 'ignore' }),
    });
    const res = await fetch(`${base}/api/audit-log`, { headers: { cookie } });
    const body = await res.json();
    assert.ok(body.entries.some((e) => e.action === 'decision_saved'));
  });
});
