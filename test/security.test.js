import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CsrfProtection, RateLimiter, redact, CSRF_HEADER } from '../src/security.js';

test('CsrfProtection issues a token that validates only with matching cookie + header', () => {
  const csrf = new CsrfProtection();
  const token = csrf.issue('session-a');
  const cookie = csrf.cookieFor(token, { secure: false });
  const req = { headers: { cookie, [CSRF_HEADER]: token } };
  assert.equal(csrf.validate(req, 'session-a'), true);
  // Bound to a session: another user's session cannot use the same token.
  assert.equal(csrf.validate(req, 'session-b'), false);
  // Missing header -> invalid.
  const noHeader = { headers: { cookie } };
  assert.equal(csrf.validate(noHeader, 'session-a'), false);
  // Missing cookie -> invalid.
  const noCookie = { headers: { [CSRF_HEADER]: token } };
  assert.equal(csrf.validate(noCookie, 'session-a'), false);
});

test('CsrfProtection cookie is NOT HttpOnly (double-submit needs JS to read it)', () => {
  const csrf = new CsrfProtection();
  const cookie = csrf.cookieFor(csrf.issue('s'), { secure: false });
  assert.doesNotMatch(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/);
});

test('RateLimiter allows up to `max` per window then blocks with retryAfter', () => {
  let now = 1_000_000;
  const limiter = new RateLimiter({ windowMs: 1000, max: 3, now: () => now });
  assert.equal(limiter.hit('a').allowed, true);
  assert.equal(limiter.hit('a').allowed, true);
  const third = limiter.hit('a');
  assert.equal(third.allowed, true);
  assert.equal(third.remaining, 0);
  const blocked = limiter.hit('a');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);
  // After the window elapses, the bucket resets.
  now += 1500;
  assert.equal(limiter.hit('a').allowed, true);
  // Different keys are independent.
  assert.equal(limiter.hit('b').allowed, true);
});

test('redact strips credential-like keys and bearer strings recursively', () => {
  const input = {
    authorization: 'Bearer sk_live_abc',
    cookie: 'session=xxx',
    request: { headers: { authorization: 'Basic Zm9v' }, url: '/api/x' },
    events: [{ id: 1, access_token: 'tok' }],
    body: 'call with Bearer sk_live_xyz please',
    normal: 'kept',
  };
  const out = redact(input);
  assert.equal(out.authorization, '[REDACTED]');
  assert.equal(out.cookie, '[REDACTED]');
  assert.equal(out.request.headers.authorization, '[REDACTED]');
  assert.equal(out.events[0].access_token, '[REDACTED]');
  assert.match(out.body, /\[REDACTED\]/);
  assert.equal(out.normal, 'kept');
});
