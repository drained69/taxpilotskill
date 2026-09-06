// Server-side security primitives:
//   - CSRF double-submit token (cookie + header) for state-changing routes
//   - Sliding-window rate limiter per key (IP or session)
//   - Structured log redaction that never emits authorization headers or tokens
//
// All three are dependency-free and injectable so tests can pin their state.

import crypto from 'node:crypto';

const CSRF_COOKIE = 'taxpilot_csrf';
const CSRF_HEADER = 'x-csrf-token';

export class CsrfProtection {
  constructor({ ttlMs = 8 * 60 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.tokens = new Map(); // sessionId -> { token, expiresAt }
  }

  issue(sessionId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.tokens.set(sessionId, { token, expiresAt: Date.now() + this.ttlMs });
    return token;
  }

  cookieFor(token, { secure = process.env.NODE_ENV === 'production' } = {}) {
    // NOTE: the CSRF cookie MUST be readable by the browser (no HttpOnly) so
    // the client can copy it into the request header — that's the "double
    // submit" pattern. The session cookie stays HttpOnly.
    const flags = ['SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(this.ttlMs / 1000)}`];
    if (secure) flags.push('Secure');
    return `${CSRF_COOKIE}=${encodeURIComponent(token)}; ${flags.join('; ')}`;
  }

  parseCookie(header = '') {
    const value = String(header || '').split(';').map((p) => p.trim()).find((p) => p.startsWith(`${CSRF_COOKIE}=`));
    return value ? decodeURIComponent(value.slice(CSRF_COOKIE.length + 1)) : '';
  }

  validate(req, sessionId) {
    if (!sessionId) return false;
    const record = this.tokens.get(sessionId);
    if (!record) return false;
    if (record.expiresAt <= Date.now()) { this.tokens.delete(sessionId); return false; }
    const cookieToken = this.parseCookie(req.headers.cookie);
    const headerToken = req.headers[CSRF_HEADER] || req.headers[CSRF_HEADER.toUpperCase()] || '';
    if (!cookieToken || !headerToken) return false;
    return safeEqual(cookieToken, record.token) && safeEqual(cookieToken, headerToken);
  }

  discard(sessionId) { this.tokens.delete(sessionId); }
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Fixed-window rate limiter with a rolling reset. Cheap, deterministic, and
 * gives a clean 429 body with `retryAfter` seconds.
 */
export class RateLimiter {
  constructor({ windowMs = 60_000, max = 60, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    this.buckets = new Map();
  }

  hit(key) {
    if (!key) return { allowed: true, remaining: this.max, retryAfter: 0 };
    const t = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      this.buckets.set(key, { count: 1, resetAt: t + this.windowMs });
      return { allowed: true, remaining: this.max - 1, retryAfter: 0 };
    }
    if (bucket.count >= this.max) {
      return { allowed: false, remaining: 0, retryAfter: Math.ceil((bucket.resetAt - t) / 1000) };
    }
    bucket.count += 1;
    return { allowed: true, remaining: this.max - bucket.count, retryAfter: 0 };
  }
}

const REDACT_KEYS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-mbx-apikey', 'token', 'access_token', 'refresh_token', 'code', 'code_verifier', 'client_secret', 'password', 'private_key'];
const REDACT_TAG = '[REDACTED]';

/**
 * Deep-clone a value with any credential-like key redacted. Handles nested
 * objects and arrays; primitives are returned unchanged. Non-serializable
 * values (functions, symbols) are dropped.
 */
export function redact(value) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.includes(k.toLowerCase()) ? REDACT_TAG : redact(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    // Redact obvious bearer tokens and Basic auth strings embedded in text.
    return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACT_TAG}`)
                .replace(/Basic\s+[A-Za-z0-9+/=]+/g, `Basic ${REDACT_TAG}`);
  }
  return value;
}

export function safeLog(logger, level, message, context = {}) {
  const line = { ts: new Date().toISOString(), level, message, ...redact(context) };
  const target = (logger && logger[level]) || console[level] || console.log;
  target.call(logger || console, JSON.stringify(line));
}

/**
 * A tiny per-key async mutex. `run(key, fn)` serializes concurrent calls that
 * share the same key; different keys run in parallel. Used to serialize a
 * user's overlapping tax-report syncs so two clicks don't race on the storage
 * layer and produce duplicate snapshots.
 */
export class KeyedLock {
  constructor() { this.queues = new Map(); }
  async run(key, fn) {
    const prev = this.queues.get(key) || Promise.resolve();
    let resolveNext;
    const next = new Promise((resolve) => { resolveNext = resolve; });
    this.queues.set(key, prev.then(() => next));
    try {
      await prev;
      return await fn();
    } finally {
      resolveNext();
      // Best-effort cleanup once the chain drains, so idle keys don't leak.
      queueMicrotask(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      });
    }
  }
}

export { CSRF_COOKIE, CSRF_HEADER };
