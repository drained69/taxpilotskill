import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

// Binance Login (OAuth 2.0) production endpoints, confirmed from:
// https://developers.binance.com/en/docs/products/login/web-integration
// These defaults let the code work as soon as Binance issues a client_id +
// client_secret to a partnered project — no need to look up URLs manually.
// Override with env vars if Binance moves them or issues staging endpoints.
export const DEFAULT_AUTHORIZATION_ENDPOINT = 'https://accounts.binance.com/en/oauth/authorize';
export const DEFAULT_TOKEN_ENDPOINT = 'https://accounts.binance.com/oauth/token';
// No public revocation endpoint documented; Binance may provide one on onboarding.
export const DEFAULT_REVOCATION_ENDPOINT = '';

function randomValue(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function createPkcePair() {
  const verifier = randomValue(32);
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export class OAuthError extends Error {
  constructor(message, code = 'OAUTH_ERROR') {
    super(message);
    this.name = 'OAuthError';
    this.code = code;
  }
}

export class BinanceOAuth {
  constructor({
    clientId = process.env.BINANCE_OAUTH_CLIENT_ID,
    clientSecret = process.env.BINANCE_OAUTH_CLIENT_SECRET,
    // Endpoints default to Binance's documented production URLs; env can override.
    authorizationEndpoint = process.env.BINANCE_OAUTH_AUTHORIZATION_ENDPOINT || DEFAULT_AUTHORIZATION_ENDPOINT,
    tokenEndpoint = process.env.BINANCE_OAUTH_TOKEN_ENDPOINT || DEFAULT_TOKEN_ENDPOINT,
    revocationEndpoint = process.env.BINANCE_OAUTH_REVOCATION_ENDPOINT || DEFAULT_REVOCATION_ENDPOINT,
    redirectUri = process.env.BINANCE_OAUTH_REDIRECT_URI,
    scopes = process.env.BINANCE_OAUTH_SCOPES || '',
    clientAuth = process.env.BINANCE_OAUTH_CLIENT_AUTH || 'body',
    fetchImpl = globalThis.fetch,
    pending = new Map(),
    ttlMs = DEFAULT_TTL_MS,
  } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.authorizationEndpoint = authorizationEndpoint;
    this.tokenEndpoint = tokenEndpoint;
    this.revocationEndpoint = revocationEndpoint;
    this.redirectUri = redirectUri;
    this.scopes = scopes;
    this.clientAuth = clientAuth;
    this.fetchImpl = fetchImpl;
    this.pending = pending;
    this.ttlMs = ttlMs;
  }

  isConfigured() {
    return Boolean(this.clientId && this.authorizationEndpoint && this.tokenEndpoint && this.redirectUri);
  }

  begin({ userId }) {
    if (!this.isConfigured()) throw new OAuthError('Binance OAuth is not configured.', 'OAUTH_NOT_CONFIGURED');
    const state = randomValue();
    const pkce = createPkcePair();
    this.pending.set(state, { userId, verifier: pkce.verifier, createdAt: Date.now() });
    const params = new URLSearchParams({
      response_type: 'code', client_id: this.clientId, redirect_uri: this.redirectUri,
      state, code_challenge: pkce.challenge, code_challenge_method: pkce.method,
    });
    if (this.scopes) params.set('scope', this.scopes);
    return `${this.authorizationEndpoint}?${params}`;
  }

  consumeState(state, userId) {
    const entry = this.pending.get(state);
    if (!entry || Date.now() - entry.createdAt > this.ttlMs) throw new OAuthError('OAuth state is invalid or expired.', 'INVALID_STATE');
    if (!constantTimeEqual(entry.userId, userId)) throw new OAuthError('OAuth state does not belong to this user.', 'INVALID_STATE');
    this.pending.delete(state);
    return entry.verifier;
  }

  async exchangeCode({ code, verifier }) {
    if (!this.fetchImpl || !this.tokenEndpoint) throw new OAuthError('Binance OAuth token exchange is unavailable.');
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, client_id: this.clientId, code_verifier: verifier });
    const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
    if (this.clientAuth === 'basic' && this.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
      body.delete('client_id');
    } else if (this.clientSecret) body.set('client_secret', this.clientSecret);
    return this.#tokenRequest(body, headers);
  }

  async refresh(refreshToken) {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.clientId });
    const headers = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
    if (this.clientAuth === 'basic' && this.clientSecret) {
      headers.authorization = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
      body.delete('client_id');
    } else if (this.clientSecret) body.set('client_secret', this.clientSecret);
    return this.#tokenRequest(body, headers);
  }

  async revoke(token) {
    if (!this.revocationEndpoint) return false;
    const body = new URLSearchParams({ token, client_id: this.clientId });
    const response = await this.fetchImpl(this.revocationEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    return response.ok;
  }

  async #tokenRequest(body, headers) {
    const response = await this.fetchImpl(this.tokenEndpoint, { method: 'POST', headers, body });
    let payload = {};
    try { payload = await response.json(); } catch { /* handled below */ }
    if (!response.ok || !payload.access_token) throw new OAuthError('Binance OAuth token request failed.', 'TOKEN_EXCHANGE_FAILED');
    return payload;
  }
}
