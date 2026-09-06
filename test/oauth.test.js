import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BinanceOAuth, OAuthError, createPkcePair } from '../src/auth/binance-oauth.js';
import { EncryptedTokenStore, SessionStore } from '../src/auth/session.js';

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('PKCE uses S256 and produces a verifier/challenge pair', () => {
  const first = createPkcePair();
  const second = createPkcePair();
  assert.equal(first.method, 'S256');
  assert.notEqual(first.verifier, second.verifier);
  assert.match(first.verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(first.challenge, /^[A-Za-z0-9_-]+$/);
});

test('OAuth begin includes PKCE and does not expose the client secret', () => {
  const oauth = new BinanceOAuth({ clientId: 'client', clientSecret: 'secret', authorizationEndpoint: 'https://auth.example/authorize', tokenEndpoint: 'https://auth.example/token', redirectUri: 'http://localhost/callback', scopes: 'read:account' });
  const location = new URL(oauth.begin({ userId: 'user-1' }));
  assert.equal(location.searchParams.get('client_id'), 'client');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('scope'), 'read:account');
  assert.equal(location.searchParams.has('client_secret'), false);
  assert.equal(location.searchParams.has('code_verifier'), false);
});

test('OAuth state is one-time, user-bound, and expires', async () => {
  const oauth = new BinanceOAuth({ clientId: 'c', authorizationEndpoint: 'https://a', tokenEndpoint: 'https://t', redirectUri: 'http://r', ttlMs: 1 });
  const url = new URL(oauth.begin({ userId: 'u' }));
  assert.throws(() => oauth.consumeState(url.searchParams.get('state'), 'other'), (error) => error.code === 'INVALID_STATE');
  assert.equal(typeof oauth.consumeState(url.searchParams.get('state'), 'u'), 'string');
  assert.throws(() => oauth.consumeState(url.searchParams.get('state'), 'u'), (error) => error.code === 'INVALID_STATE');
  const fresh = new URL(oauth.begin({ userId: 'u' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.throws(() => oauth.consumeState(fresh.searchParams.get('state'), 'u'), (error) => error.code === 'INVALID_STATE');
});

test('OAuth exchanges code with verifier and Basic client authentication', async () => {
  let request;
  const oauth = new BinanceOAuth({ clientId: 'client', clientSecret: 'secret', authorizationEndpoint: 'https://a', tokenEndpoint: 'https://token', redirectUri: 'http://r', clientAuth: 'basic', fetchImpl: async (url, init) => { request = { url, init }; return response({ access_token: 'access', refresh_token: 'refresh', expires_in: 60 }); } });
  const token = await oauth.exchangeCode({ code: 'code', verifier: 'verifier' });
  assert.equal(token.access_token, 'access');
  assert.match(request.init.headers.authorization, /^Basic /);
  const body = new URLSearchParams(request.init.body);
  assert.equal(body.get('code_verifier'), 'verifier');
  assert.equal(body.get('client_secret'), null);
});

test('OAuth rejects unsuccessful exchanges', async () => {
  const oauth = new BinanceOAuth({ clientId: 'c', tokenEndpoint: 'https://t', fetchImpl: async () => response({ error: 'denied' }, 400) });
  await assert.rejects(() => oauth.exchangeCode({ code: 'x', verifier: 'y' }), (error) => error instanceof OAuthError && error.code === 'TOKEN_EXCHANGE_FAILED');
});

test('OAuth refresh sends the refresh token and accepts rotation', async () => {
  let request;
  const oauth = new BinanceOAuth({ clientId: 'client', clientSecret: 'secret', tokenEndpoint: 'https://token', fetchImpl: async (url, init) => { request = init; return response({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 120 }); } });
  const token = await oauth.refresh('old-refresh');
  assert.equal(token.refresh_token, 'new-refresh');
  assert.equal(new URLSearchParams(request.body).get('refresh_token'), 'old-refresh');
});

test('encrypted token store does not retain plaintext tokens', () => {
  const records = new Map();
  const store = new EncryptedTokenStore({ secret: 'test-secret', records });
  store.set('u', { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 100, scope: 'read' });
  assert.equal(store.get('u').accessToken, 'access-secret');
  assert.equal(store.get('u').refreshToken, 'refresh-secret');
  assert.doesNotMatch(JSON.stringify([...records.values()]), /access-secret|refresh-secret/);
});

test('session cookies are HttpOnly and sessions expire', async () => {
  const store = new SessionStore({ secret: 'session', ttlMs: 20 });
  const id = store.create({ user: 'u' });
  assert.match(store.cookie(id), /HttpOnly/);
  assert.equal(store.get(id).user, 'u');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.get(id), null);
});
