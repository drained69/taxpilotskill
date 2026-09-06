import crypto from 'node:crypto';

function keyFromSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

export class SessionStore {
  constructor({ secret = process.env.SESSION_SECRET || 'development-only-session-secret', ttlMs = 8 * 60 * 60 * 1000, sessions = new Map() } = {}) {
    this.secret = secret;
    this.key = keyFromSecret(secret);
    this.ttlMs = ttlMs;
    this.sessions = sessions;
  }

  create(data = {}) {
    const id = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(id, { ...data, createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  get(id) {
    const record = id && this.sessions.get(id);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) { this.sessions.delete(id); return null; }
    return record;
  }

  destroy(id) { this.sessions.delete(id); }

  cookie(id, { secure = process.env.NODE_ENV === 'production' } = {}) {
    const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(this.ttlMs / 1000)}`];
    if (secure) flags.push('Secure');
    return `taxpilot_session=${encodeURIComponent(id)}; ${flags.join('; ')}`;
  }

  parseCookie(header = '') {
    const value = header.split(';').map((part) => part.trim()).find((part) => part.startsWith('taxpilot_session='));
    return value ? decodeURIComponent(value.slice('taxpilot_session='.length)) : '';
  }
}

export class EncryptedTokenStore {
  constructor({ secret = process.env.TOKEN_ENCRYPTION_KEY || 'development-only-token-key', records = new Map() } = {}) {
    this.key = keyFromSecret(secret);
    this.records = records;
  }

  #encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
  }

  #decrypt(value) {
    const [iv, tag, ciphertext] = value.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  set(userId, tokens) {
    this.records.set(userId, {
      accessToken: this.#encrypt(tokens.access_token),
      refreshToken: tokens.refresh_token ? this.#encrypt(tokens.refresh_token) : null,
      expiresAt: Date.now() + (Number(tokens.expires_in || 3600) * 1000),
      scope: tokens.scope || '', updatedAt: Date.now(),
    });
  }

  get(userId) {
    const record = this.records.get(userId);
    if (!record) return null;
    return { ...record, accessToken: this.#decrypt(record.accessToken), refreshToken: record.refreshToken ? this.#decrypt(record.refreshToken) : null };
  }

  delete(userId) { this.records.delete(userId); }
}
