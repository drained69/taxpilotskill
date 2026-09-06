// TaxPilot server: static host + Binance Agent OS integration + persistence.
//
// Endpoints
//   GET  /api/health                     liveness + configured endpoint
//   GET  /api/csrf                       issue a CSRF token for state-changing routes
//   GET  /api/auth/binance/start         begin OAuth (PKCE)
//   GET  /api/auth/binance/callback      OAuth callback
//   GET  /api/connections/binance        connection status
//   POST /api/connections/binance/disconnect   revoke and delete stored tokens
//   GET  /api/tax-report                 deterministic demo report (no credentials)
//   POST /api/agent-os/report            run pipeline, persist snapshot, return report
//   GET  /api/reports                    list persisted report snapshots
//   GET  /api/reports/:id                fetch a single persisted snapshot
//   POST /api/reports/recompute          apply new decisions/lots, recompute + persist
//   GET  /api/decisions                  list user's tax-inbox decisions
//   POST /api/decisions                  upsert a decision on an unresolved event
//   GET  /api/historical-lots            list user's imported historical lots
//   POST /api/historical-lots            import historical lots
//   DELETE /api/historical-lots/:id      remove one lot
//   GET  /api/audit-log                  read the append-only audit log
//   POST /api/user/export                export all data for the caller
//   POST /api/user/delete                delete all data for the caller
//   GET  /api/reports/form-8949.csv      Form 8949 export for the demo report
//   POST /api/reports/form-8949.csv      Form 8949 export for a posted or persisted report
//   POST /api/mcp                        thin MCP proxy (dev-only, off in production)
//
// No Binance API keys are stored. OAuth tokens are AES-256-GCM encrypted at
// rest and never written to logs.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateTaxReport, demoEvents } from './src/tax-engine.js';
import { buildTaxReportFromAgentOS } from './src/agent-os.js';
import { McpError, DEFAULT_MCP_URL } from './src/mcp-client.js';
import { BinanceOAuth, OAuthError } from './src/auth/binance-oauth.js';
import { EncryptedTokenStore, SessionStore } from './src/auth/session.js';
import { Storage } from './src/storage.js';
import { CsrfProtection, RateLimiter, KeyedLock, safeLog, redact } from './src/security.js';
import { saveReport, getReport, listReports, applyDecisions, historicalLotsToEvents } from './src/reports.js';
import { csvToRecords } from './src/csv-import.js';
import { normalizeRecords } from './src/normalize.js';
import { enrichWithPrices, KlinesPriceProvider, NullPriceProvider } from './src/pricing.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const MCP_URL = process.env.AGENT_OS_MCP_URL || DEFAULT_MCP_URL;
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 256 * 1024;
const ALLOW_MCP_PROXY = process.env.NODE_ENV !== 'production' && process.env.ENABLE_MCP_PROXY === 'true';
const IS_PROD = process.env.NODE_ENV === 'production';

const CONTENT_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const CORS = { 'access-control-allow-headers': 'content-type, x-csrf-token', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS' };

// Baseline security headers applied to every response. CSP is strict: only
// same-origin scripts, styles, and images. `object-src 'none'` blocks the
// classic Flash/PDF injection surface; `frame-ancestors 'none'` prevents any
// origin from framing TaxPilot (clickjacking).
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), camera=(), microphone=(), payment=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
};
// HSTS only in production over HTTPS; otherwise browsers ignore it, but sending
// it in dev would pin localhost to HTTPS after one accidental visit.
if (process.env.NODE_ENV === 'production') {
  SECURITY_HEADERS['strict-transport-security'] = 'max-age=63072000; includeSubDomains; preload';
}

// Persistence backbone shared across the process. Tests can pass their own via `createServer()`.
export function createServer({ storage = new Storage(), oauth = new BinanceOAuth(), sessionStore, tokenStore, csrf, limiter, logger = console } = {}) {
  const sessions = sessionStore || new SessionStore({ sessions: sessionMapFromStorage(storage) });
  const tokens = tokenStore || new EncryptedTokenStore({ records: recordMapFromStorage(storage) });
  const csrfProtection = csrf || new CsrfProtection();
  const rateLimiter = limiter || new RateLimiter({ windowMs: 60_000, max: 120 });
  const syncLock = new KeyedLock();
  let shuttingDown = false;
  let inFlight = 0;

  function log(level, message, context) { safeLog(logger, level, message, context); }
  async function audit(action, sessionId, extra = {}) {
    // Spread `extra` FIRST so the outer `action`/`sessionId` always win — some
    // callers include an `action` field in extra (e.g. the user's decision verb).
    await storage.audit.append({ ...redact(extra), action, sessionId: sessionId || null });
  }

  // Merge security headers into every response. API responses also get
  // `cache-control: no-store` so browsers and intermediaries never cache
  // account data.
  function baseHeaders(extra = {}, { isApi = false } = {}) {
    const headers = { ...SECURITY_HEADERS, ...CORS, ...extra };
    if (isApi) headers['cache-control'] = 'no-store';
    return headers;
  }

  function send(res, status, body, type = 'application/json') {
    const isApi = type === 'application/json' || type === 'text/csv';
    res.writeHead(status, baseHeaders({ 'content-type': type }, { isApi }));
    res.end(type === 'application/json' ? JSON.stringify(body) : body);
  }

  function readBody(req, { maxBytes = MAX_BODY, parse = 'json' } = {}) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
        if (data.length > maxBytes) {
          reject(new Error('Request body too large'));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (parse === 'text') return resolve(data);
        try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON body')); }
      });
      req.on('error', reject);
    });
  }

  function sessionId(req) { return sessions.parseCookie(req.headers.cookie); }

  // Returns the session id only if the session record still exists AND hasn't
  // expired. Use this whenever a route treats a missing session as unauthorized —
  // never trust the cookie value alone, since a destroyed session leaves the
  // cookie intact until the browser clears it.
  function activeSessionId(req) {
    const id = sessionId(req);
    return sessions.get(id) ? id : '';
  }

  function appendCookie(res, cookie) {
    const existing = res.getHeader('set-cookie');
    if (!existing) res.setHeader('set-cookie', [cookie]);
    else if (Array.isArray(existing)) res.setHeader('set-cookie', [...existing, cookie]);
    else res.setHeader('set-cookie', [existing, cookie]);
  }

  function getOrCreateSession(req, res) {
    let id = sessionId(req);
    if (!sessions.get(id)) {
      id = sessions.create({});
      appendCookie(res, sessions.cookie(id));
    }
    return id;
  }

  async function validBinanceToken(userId) {
    const record = tokens.get(userId);
    if (!record) return null;
    if (record.expiresAt > Date.now() + 30_000 || !record.refreshToken) return record.accessToken;
    try {
      const refreshed = await oauth.refresh(record.refreshToken);
      tokens.set(userId, refreshed);
      await audit('binance_token_refreshed', userId);
      return tokens.get(userId)?.accessToken || null;
    } catch (error) {
      log('warn', 'Binance token refresh failed', { userId, error: error.message });
      tokens.delete(userId);
      await audit('binance_token_refresh_failed', userId, { error: error.message });
      return null;
    }
  }

  function requireCsrf(req, res, id) {
    if (!csrfProtection.validate(req, id)) {
      send(res, 403, { error: 'Invalid or missing CSRF token.', code: 'CSRF_INVALID' });
      return false;
    }
    return true;
  }

  function clientKey(req, id) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    return id || ip;
  }

  async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const route = url.pathname;
    inFlight += 1;
    res.on('close', () => { inFlight = Math.max(0, inFlight - 1); });

    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, baseHeaders()); return res.end(); }

      // Refuse new work once a shutdown signal has arrived. Health check stays
      // available so orchestrators (k8s, systemd) see us drain cleanly.
      if (shuttingDown && route !== '/api/health') {
        res.writeHead(503, baseHeaders({ 'content-type': 'application/json', 'retry-after': '10' }, { isApi: true }));
        return res.end(JSON.stringify({ error: 'Server is shutting down.', code: 'SHUTTING_DOWN' }));
      }

      // Rate-limit anything under /api. Static assets stay cheap.
      if (route.startsWith('/api/')) {
        const id = sessionId(req);
        const { allowed, retryAfter } = rateLimiter.hit(clientKey(req, id));
        if (!allowed) {
          res.writeHead(429, baseHeaders({ 'content-type': 'application/json', 'retry-after': String(retryAfter) }, { isApi: true }));
          return res.end(JSON.stringify({ error: 'Rate limit exceeded.', code: 'RATE_LIMITED', retryAfter }));
        }
      }

      if (route === '/api/health') {
        // Verify the data dir is actually writable — a common production
        // failure mode is a volume that mounted read-only. Cheap enough to
        // do on every health probe.
        let storageOk = true;
        let storageError = null;
        try {
          const probe = path.join(storage.dataDir, `.health-probe-${process.pid}`);
          fs.writeFileSync(probe, '');
          fs.unlinkSync(probe);
        } catch (error) { storageOk = false; storageError = error.message; }
        const ok = storageOk && !shuttingDown;
        return send(res, ok ? 200 : 503, {
          ok, service: 'taxpilot', mcp: MCP_URL,
          oauthConfigured: oauth.isConfigured(),
          storage: { ok: storageOk, error: storageError },
          shuttingDown, inFlight,
          uptimeSeconds: Math.floor(process.uptime()),
          time: new Date().toISOString(),
        });
      }

      if (route === '/api/metrics' && req.method === 'GET') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        const auditEntries = storage.audit.read({ limit: 10_000, filter: (e) => e.sessionId === id });
        const counts = auditEntries.reduce((acc, e) => { acc[e.action] = (acc[e.action] || 0) + 1; return acc; }, {});
        const reports = listReports(storage.collection('reports'), id);
        const latest = reports[0] || null;
        return send(res, 200, {
          reportsGenerated:    counts.report_generated || 0,
          reportsRecomputed:   counts.report_recomputed || 0,
          reportsFailed:       counts.report_failed || 0,
          decisionsSaved:      counts.decision_saved || 0,
          historicalLotsImported: counts.historical_lots_imported || 0,
          tokenRefreshes:      counts.binance_token_refreshed || 0,
          tokenRefreshFailures:counts.binance_token_refresh_failed || 0,
          latestSnapshotId:    latest?.id || null,
          latestUnresolved:    latest ? latest.totals?.ordinaryIncome !== undefined && Array.isArray(latest.unresolved) ? latest.unresolved.length : null : null,
        });
      }

      if (route === '/api/csrf' && req.method === 'GET') {
        const id = getOrCreateSession(req, res);
        const token = csrfProtection.issue(id);
        appendCookie(res, csrfProtection.cookieFor(token));
        return send(res, 200, { csrfToken: token });
      }

      if (route === '/api/auth/binance/start' && req.method === 'GET') {
        const id = getOrCreateSession(req, res);
        try {
          const location = oauth.begin({ userId: id });
          await audit('binance_oauth_started', id);
          res.writeHead(302, baseHeaders({ location }, { isApi: true }));
          return res.end();
        } catch (error) {
          return send(res, error.code === 'OAUTH_NOT_CONFIGURED' ? 503 : 500, { error: error.message, code: error.code });
        }
      }

      if (route === '/api/auth/binance/callback' && req.method === 'GET') {
        const id = sessionId(req);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!id || !code || !state) return send(res, 400, { error: 'Invalid Binance OAuth callback.' });
        try {
          const verifier = oauth.consumeState(state, id);
          const tokenPayload = await oauth.exchangeCode({ code, verifier });
          tokens.set(id, tokenPayload);
          await audit('binance_oauth_completed', id, { scope: tokenPayload.scope || '' });
          res.writeHead(302, baseHeaders({ location: '/?connected=1' }, { isApi: true }));
          return res.end();
        } catch (error) {
          await audit('binance_oauth_failed', id, { error: error.message });
          return send(res, error instanceof OAuthError ? 400 : 502, { error: error.message, code: error.code || 'OAUTH_CALLBACK_FAILED' });
        }
      }

      if (route === '/api/connections/binance' && req.method === 'GET') {
        const id = sessionId(req);
        const record = id ? tokens.get(id) : null;
        return send(res, 200, { connected: Boolean(record), provider: 'binance', status: record ? 'active' : 'disconnected', expiresAt: record?.expiresAt || null, scope: record?.scope || '' });
      }

      if (route === '/api/connections/binance/disconnect' && req.method === 'POST') {
        const id = sessionId(req);
        if (!requireCsrf(req, res, id)) return;
        const record = id ? tokens.get(id) : null;
        if (record?.accessToken) await oauth.revoke(record.accessToken).catch(() => {});
        if (id) tokens.delete(id);
        await audit('binance_disconnected', id);
        return send(res, 200, { connected: false });
      }

      if (route === '/api/tax-report' && req.method === 'GET') {
        const taxYear = Number(url.searchParams.get('taxYear')) || 2025;
        return send(res, 200, calculateTaxReport(demoEvents, { taxYear }));
      }

      // LIVE pipeline: run Agent OS, persist the snapshot, return the report.
      if (route === '/api/agent-os/report' && req.method === 'POST') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        if (!requireCsrf(req, res, id)) return;
        const token = await validBinanceToken(id);
        if (!token) return send(res, 401, { error: 'Connect Binance with read-only OAuth access first.', code: 'BINANCE_NOT_CONNECTED' });
        const body = await readBody(req);
        try {
          // Serialize per-user syncs. A rapid double-click won't race two
          // pipelines against the same storage collection, and the second
          // call sees the first snapshot rather than duplicating work.
          const jurisdiction = String(body.jurisdiction || 'US').toUpperCase();
          const usdToLocalRate = Number(body.usdToLocalRate) || null;
          const result = await syncLock.run(`sync:${id}`, async () => {
            const pipe = await buildTaxReportFromAgentOS({
              token, url: MCP_URL,
              taxYear: Number(body.taxYear) || 2025,
              accountId: body.accountId || undefined,
            });
            const decisions = decisionsFor(storage, id);
            const historicalLots = lotsFor(storage, id);
            const snapshot = await saveReport(storage.collection('reports'), id, {
              events: pipe.events, decisions, historicalLots,
              taxYear: Number(body.taxYear) || 2025, jurisdiction, usdToLocalRate,
              provenance: { ...pipe.provenance, jurisdiction },
            });
            return { snapshot, provenance: pipe.provenance };
          });
          await audit('report_generated', id, { snapshotId: result.snapshot.id, recordCount: result.provenance.recordCount });
          return send(res, 200, { report: result.snapshot.report, provenance: result.provenance, snapshotId: result.snapshot.id });
        } catch (error) {
          log('error', 'Agent OS pipeline failed', { userId: id, error: error.message });
          await audit('report_failed', id, { error: error.message });
          if (error instanceof McpError && error.code === 'UNAUTHORIZED') {
            res.writeHead(error.httpStatus || 401, baseHeaders({ 'content-type': 'application/json', 'www-authenticate': error.wwwAuthenticate || 'Bearer realm="Agent OS"' }, { isApi: true }));
            return res.end(JSON.stringify({ error: error.message, code: error.code }));
          }
          return send(res, 502, { error: error.message, code: error instanceof McpError ? error.code : 'PIPELINE_ERROR' });
        }
      }

      // CSV import: the offline / partnership-free path. A user downloads their
      // Binance transaction history CSV(s) from Wallet → Transaction History
      // and uploads them here. We treat each CSV as another source in the same
      // pipeline that MCP records go through, so decisions, recompute, and
      // Form 8949 export work identically.
      if (route === '/api/import/csv' && req.method === 'POST') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        if (!requireCsrf(req, res, id)) return;
        const body = await readBody(req, { maxBytes: 8 * 1024 * 1024 }); // 8 MB
        const files = Array.isArray(body.files) ? body.files : (body.csv ? [{ name: body.name || 'upload.csv', content: body.csv }] : []);
        if (!files.length) return send(res, 400, { error: 'Provide files: [{ name, content }] or csv: <string>.' });
        const taxYear = Number(body.taxYear) || 2025;

        // Parse every uploaded CSV; merge; dedupe.
        const allRecords = [];
        const parseReport = [];
        for (const file of files) {
          const category = String(file.name || 'csv').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'csv';
          const parsed = csvToRecords(String(file.content || ''), { category });
          for (const record of parsed.records) {
            record._csvFile = file.name || 'upload.csv';
            allRecords.push(record);
          }
          parseReport.push({ file: file.name || 'upload.csv', rows: parsed.totalRows, imported: parsed.records.length, skipped: parsed.skipped.length });
        }

        const { events, skipped } = normalizeRecords(allRecords, {});
        // Value anything the CSV didn't already carry a USD leg for. Uses the
        // public Binance market-data API — no auth, no partnership.
        const provider = globalThis.fetch ? new KlinesPriceProvider({ fetchImpl: globalThis.fetch }) : new NullPriceProvider();
        const { events: valued, priced, unpriced } = await enrichWithPrices(events, provider);

        const decisions = decisionsFor(storage, id);
        const historicalLots = lotsFor(storage, id);
        const jurisdiction = String(body.jurisdiction || 'US').toUpperCase();
        const usdToLocalRate = Number(body.usdToLocalRate) || null;
        const snapshot = await saveReport(storage.collection('reports'), id, {
          events: valued, decisions, historicalLots, taxYear, jurisdiction, usdToLocalRate,
          provenance: {
            source: 'csv-import',
            jurisdiction,
            files: parseReport,
            recordCount: allRecords.length,
            normalized: events.length,
            skippedByParser: parseReport.reduce((n, f) => n + f.skipped, 0),
            skippedByNormalizer: skipped.length,
            priced,
            unpriced: unpriced.length,
            valuedAt: new Date().toISOString(),
          },
        });
        await audit('report_generated_csv', id, { snapshotId: snapshot.id, files: files.length, records: allRecords.length });
        return send(res, 200, {
          report: snapshot.report,
          provenance: snapshot.provenance,
          snapshotId: snapshot.id,
          parseReport,
          unpricedCount: unpriced.length,
        });
      }

      if (route === '/api/reports' && req.method === 'GET') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        return send(res, 200, { reports: listReports(storage.collection('reports'), id) });
      }

      const reportMatch = route.match(/^\/api\/reports\/([A-Za-z0-9_-]{6,32})$/);
      if (reportMatch && req.method === 'GET') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        const record = getReport(storage.collection('reports'), id, reportMatch[1]);
        if (!record) return send(res, 404, { error: 'Report not found.' });
        return send(res, 200, record);
      }

      if (route === '/api/reports/recompute' && req.method === 'POST') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        if (!requireCsrf(req, res, id)) return;
        const body = await readBody(req);
        const previousId = String(body.baseSnapshotId || '');
        const base = getReport(storage.collection('reports'), id, previousId);
        if (!base) return send(res, 404, { error: 'Base snapshot not found. Sync a fresh report first.', code: 'NO_BASE_SNAPSHOT' });
        // Recompute against the persisted event stream, applying the latest decisions and lots.
        const events = base.report.dispositions ? reconstructEventsFromReport(base.report) : [];
        const decisions = decisionsFor(storage, id);
        const historicalLots = lotsFor(storage, id);
        const jurisdiction = String(body.jurisdiction || base.jurisdiction || 'US').toUpperCase();
        const usdToLocalRate = Number(body.usdToLocalRate) || null;
        const snapshot = await saveReport(storage.collection('reports'), id, {
          events, decisions, historicalLots, taxYear: base.taxYear, jurisdiction, usdToLocalRate,
          provenance: base.provenance,
        });
        await audit('report_recomputed', id, { baseSnapshotId: previousId, newSnapshotId: snapshot.id });
        return send(res, 200, { report: snapshot.report, snapshotId: snapshot.id });
      }

      if (route === '/api/decisions' && req.method === 'GET') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        return send(res, 200, { decisions: decisionsFor(storage, id) });
      }

      if (route === '/api/decisions' && req.method === 'POST') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        if (!requireCsrf(req, res, id)) return;
        const body = await readBody(req);
        const decision = validateDecision(body);
        if (!decision) return send(res, 400, { error: 'Invalid decision payload.' });
        const store = storage.collection('decisions');
        const existing = store.get(id) || { userId: id, items: [] };
        existing.items = existing.items.filter((d) => d.eventId !== decision.eventId).concat([{ ...decision, updatedAt: new Date().toISOString() }]);
        await store.set(id, existing);
        await audit('decision_saved', id, { eventId: decision.eventId, action: decision.action });
        return send(res, 200, { decision });
      }

      if (route === '/api/historical-lots' && req.method === 'GET') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        return send(res, 200, { lots: lotsFor(storage, id) });
      }

      if (route === '/api/historical-lots' && req.method === 'POST') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        if (!requireCsrf(req, res, id)) return;
        const body = await readBody(req);
        const incoming = Array.isArray(body.lots) ? body.lots : [body];
        const validated = incoming.map(validateLot).filter(Boolean);
        if (!validated.length) return send(res, 400, { error: 'No valid lots provided.' });
        const store = storage.collection('historical_lots');
        const current = store.get(id) || { userId: id, items: [] };
        current.items = current.items.concat(validated);
        await store.set(id, current);
        await audit('historical_lots_imported', id, { count: validated.length });
        return send(res, 200, { imported: validated.length, lots: current.items });
      }

      const lotMatch = route.match(/^\/api\/historical-lots\/([A-Za-z0-9_-]+)$/);
      if (lotMatch && req.method === 'DELETE') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        if (!requireCsrf(req, res, id)) return;
        const store = storage.collection('historical_lots');
        const current = store.get(id) || { userId: id, items: [] };
        const before = current.items.length;
        current.items = current.items.filter((lot) => lot.id !== lotMatch[1]);
        await store.set(id, current);
        await audit('historical_lot_deleted', id, { lotId: lotMatch[1] });
        return send(res, 200, { removed: before - current.items.length, lots: current.items });
      }

      if (route === '/api/audit-log' && req.method === 'GET') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
        const entries = storage.audit.read({ limit, filter: (e) => e.sessionId === id });
        return send(res, 200, { entries });
      }

      if (route === '/api/user/export' && req.method === 'POST') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        if (!requireCsrf(req, res, id)) return;
        const payload = {
          exportedAt: new Date().toISOString(),
          userId: id,
          decisions: decisionsFor(storage, id),
          historicalLots: lotsFor(storage, id),
          reports: listReports(storage.collection('reports'), id).map((meta) => getReport(storage.collection('reports'), id, meta.id)),
          auditLog: storage.audit.read({ limit: 5000, filter: (e) => e.sessionId === id }),
        };
        await audit('user_data_exported', id);
        return send(res, 200, payload);
      }

      if (route === '/api/user/delete' && req.method === 'POST') {
        const id = activeSessionId(req);
        if (!id) return send(res, 401, { error: 'No session.' });
        if (!requireCsrf(req, res, id)) return;
        const record = tokens.get(id);
        if (record?.accessToken) await oauth.revoke(record.accessToken).catch(() => {});
        tokens.delete(id);
        await storage.collection('decisions').delete(id);
        await storage.collection('historical_lots').delete(id);
        // Delete every report keyed to this user.
        for (const [key] of storage.collection('reports').entries()) {
          if (key.startsWith(`${id}:`)) await storage.collection('reports').delete(key);
        }
        csrfProtection.discard(id);
        sessions.destroy(id);
        await audit('user_data_deleted', id);
        return send(res, 200, { deleted: true });
      }

      // Faithful MCP proxy (dev-only, off by default).
      if (route === '/api/mcp' && req.method === 'POST') {
        if (!ALLOW_MCP_PROXY) return send(res, 404, { error: 'The generic MCP proxy is disabled.' });
        const body = await readBody(req);
        const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
        if (req.headers.authorization) headers.authorization = req.headers.authorization;
        if (req.headers['mcp-session-id']) headers['mcp-session-id'] = req.headers['mcp-session-id'];
        if (req.headers['mcp-protocol-version']) headers['mcp-protocol-version'] = req.headers['mcp-protocol-version'];

        const upstream = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
        const text = await upstream.text();
        const responseHeaders = baseHeaders({ 'content-type': upstream.headers.get('content-type') || 'application/json' }, { isApi: true });
        for (const h of ['mcp-session-id', 'www-authenticate']) {
          if (upstream.headers.get(h)) responseHeaders[h] = upstream.headers.get(h);
        }
        res.writeHead(upstream.status, responseHeaders);
        return res.end(text);
      }

      if (route === '/api/reports/form-8949.csv') {
        if (req.method === 'POST') {
          const body = await readBody(req);
          const report = body.report && body.report.form8949
            ? body.report
            : body.snapshotId
              ? (getReport(storage.collection('reports'), sessionId(req), body.snapshotId)?.report || null)
              : calculateTaxReport(body.events || demoEvents, { taxYear: Number(body.taxYear) || 2025 });
          if (!report) return send(res, 404, { error: 'Report not found.' });
          return send(res, 200, form8949Csv(report), 'text/csv');
        }
        const report = calculateTaxReport(demoEvents, { taxYear: Number(url.searchParams.get('taxYear')) || 2025 });
        res.writeHead(200, baseHeaders({ 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="taxpilot-form-8949.csv"' }, { isApi: true }));
        return res.end(form8949Csv(report));
      }

      // Static files.
      const file = route === '/' ? '/index.html' : route;
      const filePath = path.join(publicDir, path.normalize(file));
      if (!filePath.startsWith(publicDir)) return send(res, 403, { error: 'Forbidden' });
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return send(res, 404, { error: 'Not found' });
      const ext = path.extname(filePath);
      // Static assets get a short cache; HTML gets no-cache so app updates roll out cleanly.
      const staticCache = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
      res.writeHead(200, baseHeaders({ 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream', 'cache-control': staticCache }));
      return res.end(fs.readFileSync(filePath));
    } catch (error) {
      log('error', 'Unhandled request error', { error: error.message, route });
      return send(res, 500, { error: 'Internal error.' });
    }
  }

  const server = http.createServer(handler);
  server.storage = storage;
  server.sessions = sessions;
  server.tokens = tokens;
  server.csrf = csrfProtection;

  /**
   * Stop accepting new connections, wait for in-flight requests to finish
   * (bounded by `timeoutMs`), flush queued storage writes, then resolve.
   * Idempotent — calling twice returns the same promise.
   */
  let shutdownPromise = null;
  server.shutdown = async function shutdown({ timeoutMs = 30_000 } = {}) {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      shuttingDown = true;
      log('info', 'graceful shutdown initiated', { inFlight });
      // Stop accepting new connections.
      await new Promise((resolve) => server.close(() => resolve()));
      // Wait up to timeoutMs for in-flight handlers to complete.
      const start = Date.now();
      while (inFlight > 0 && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Flush storage: the queues resolve when their most recent write lands.
      for (const col of storage.collections.values()) await col.queue.catch(() => {});
      await storage.audit.queue.catch(() => {});
      log('info', 'graceful shutdown complete', { drainedInMs: Date.now() - start });
    })();
    return shutdownPromise;
  };

  return server;
}

function decisionsFor(storage, userId) {
  const record = storage.collection('decisions').get(userId);
  return record?.items || [];
}

function lotsFor(storage, userId) {
  const record = storage.collection('historical_lots').get(userId);
  return record?.items || [];
}

function validateDecision(body = {}) {
  const eventId = String(body.eventId || '').trim();
  const action = String(body.action || '').trim();
  const allowed = new Set(['confirm_self_transfer', 'confirm_external_transfer', 'set_basis', 'set_income', 'ignore']);
  if (!eventId || !allowed.has(action)) return null;
  const out = { eventId, action };
  if (action === 'set_basis') {
    const usdValue = Number(body.usdValue);
    if (!Number.isFinite(usdValue) || usdValue < 0) return null;
    out.usdValue = usdValue;
    if (body.feeUsd !== undefined) out.feeUsd = Number(body.feeUsd) || 0;
  }
  if (action === 'set_income') {
    const usdValue = Number(body.usdValue);
    if (!Number.isFinite(usdValue) || usdValue < 0) return null;
    out.usdValue = usdValue;
    out.incomeType = String(body.incomeType || 'income');
  }
  if (action === 'confirm_external_transfer' && body.usdValue !== undefined) {
    out.usdValue = Number(body.usdValue);
  }
  if (body.note) out.note = String(body.note).slice(0, 500);
  return out;
}

function validateLot(raw = {}) {
  const asset = String(raw.asset || '').toUpperCase();
  const quantity = Number(raw.quantity);
  const usdValue = Number(raw.usdValue);
  const acquiredAt = raw.acquiredAt || raw.timestamp;
  if (!asset || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(usdValue) || usdValue < 0) return null;
  if (!acquiredAt || Number.isNaN(new Date(acquiredAt).getTime())) return null;
  return {
    id: raw.id || `lot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    asset, quantity, usdValue,
    feeUsd: Number(raw.feeUsd || 0),
    acquiredAt: new Date(acquiredAt).toISOString(),
    accountId: raw.accountId ? String(raw.accountId) : undefined,
    note: raw.note ? String(raw.note).slice(0, 500) : undefined,
    createdAt: new Date().toISOString(),
  };
}

// Reconstruct a minimal event stream from a previously calculated report so we
// can rerun the engine with updated decisions/lots without re-hitting Agent OS.
// We only reproduce the disposals; the FIFO basis they consumed comes from the
// existing historical lots. This lets a user tweak decisions and see the impact.
function reconstructEventsFromReport(report) {
  const out = [];
  for (const d of report.dispositions || report.disposals || []) {
    out.push({
      id: d.id,
      type: d.sourceType || 'sell',
      accountId: d.accountId || 'agentic-default',
      asset: d.asset,
      quantity: Number(String(d.description || '').split(' ')[0]) || 0,
      usdValue: d.proceeds,
      feeUsd: 0,
      timestamp: d.disposedAt,
    });
  }
  for (const i of report.income || []) {
    out.push({
      id: i.id,
      type: i.category?.toLowerCase().includes('staking') ? 'staking' : i.category?.toLowerCase().includes('airdrop') ? 'airdrop' : 'income',
      asset: i.asset,
      quantity: i.quantity,
      usdValue: i.ordinaryIncome,
      timestamp: i.receivedAt,
    });
  }
  return out;
}

function sessionMapFromStorage(storage) {
  // Rehydrate persisted sessions into the map SessionStore uses in memory.
  const col = storage.collection('sessions');
  const map = new Map();
  for (const [id, record] of col.entries()) map.set(id, record);
  return proxyPersistedMap(map, col);
}

function recordMapFromStorage(storage) {
  const col = storage.collection('tokens');
  const map = new Map();
  for (const [id, record] of col.entries()) map.set(id, record);
  return proxyPersistedMap(map, col);
}

// A minimal proxy that mirrors set/delete/clear onto the persistent collection
// while keeping the fast in-memory Map for reads. This lets the existing
// SessionStore/EncryptedTokenStore keep their sync API untouched.
function proxyPersistedMap(memory, collection) {
  return {
    get: (k) => memory.get(k),
    has: (k) => memory.has(k),
    set: (k, v) => { memory.set(k, v); collection.set(k, v).catch(() => {}); return memory; },
    delete: (k) => { const existed = memory.delete(k); collection.delete(k).catch(() => {}); return existed; },
    clear: () => { memory.clear(); collection.clear().catch(() => {}); },
    entries: () => memory.entries(),
    keys: () => memory.keys(),
    values: () => memory.values(),
    get size() { return memory.size; },
    [Symbol.iterator]: () => memory[Symbol.iterator](),
  };
}

const FORM_8949_HEADER = 'Description,Date Acquired,Date Sold,Proceeds,Cost Basis,Adjustment Code,Adjustment Amount,Gain or Loss,Source Event ID';
export function form8949Csv(report) {
  const rows = [...report.form8949.shortTerm, ...report.form8949.longTerm].map((row) =>
    [row.description, row.dateAcquired, row.dateSold, row.proceeds, row.costBasis, row.adjustmentCode, row.adjustmentAmount, row.gainOrLoss, row.sourceEventId]
      .map(csvValue)
      .join(','),
  );
  return `${FORM_8949_HEADER}\n${rows.join('\n')}\n`;
}
const csvValue = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;

const server = createServer();
if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, () => console.log(`TaxPilot running at http://localhost:${PORT}  ·  Agent OS: ${MCP_URL}`));

  // Graceful shutdown: catch the two signals a container runtime sends
  // (SIGTERM from k8s/systemd, SIGINT from Ctrl+C in dev). Return the exit
  // code the caller expects so log tailers can distinguish clean stops.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      try {
        await server.shutdown({ timeoutMs: 30_000 });
        process.exit(0);
      } catch (error) {
        console.error('Shutdown error:', error);
        process.exit(1);
      }
    });
  }
}

export { server };
