// File-backed persistence with atomic writes. Small, dependency-free, and
// easily migrated to SQLite/Postgres later. Each collection lives in one JSON
// file; the append-only audit log lives in a JSONL file that survives crashes.
//
// Concurrency model: single-process, in-memory index for reads, serialized
// writes per collection via a tiny per-key mutex. That is enough for the read-
// only tax workspace; a multi-process deployment must migrate to a real DB.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULT_DATA_DIR = process.env.TAXPILOT_DATA_DIR || path.join(process.cwd(), '.taxpilot-data');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data, { mode: 0o600 });
  await fsp.rename(tmp, filePath);
}

/**
 * A single-file JSON collection with in-memory index and serialized writes.
 * Values must be JSON-serializable objects. Deletes remove the key entirely.
 */
export class JsonCollection {
  constructor(filePath) {
    this.filePath = filePath;
    this.map = new Map();
    this.queue = Promise.resolve();
    ensureDir(path.dirname(filePath));
    if (fs.existsSync(filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          for (const [k, v] of Object.entries(parsed)) this.map.set(k, v);
        }
      } catch {
        // Corrupt file: back it up and start fresh rather than crash-loop.
        const backup = `${filePath}.corrupt.${Date.now()}`;
        try { fs.renameSync(filePath, backup); } catch { /* best effort */ }
      }
    }
  }

  get(key) {
    const value = this.map.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  has(key) { return this.map.has(key); }

  entries() {
    return Array.from(this.map.entries(), ([k, v]) => [k, structuredClone(v)]);
  }

  values() {
    return Array.from(this.map.values(), (v) => structuredClone(v));
  }

  async set(key, value) {
    this.map.set(key, structuredClone(value));
    return this.#flush();
  }

  async delete(key) {
    const existed = this.map.delete(key);
    if (existed) await this.#flush();
    return existed;
  }

  async clear() {
    this.map.clear();
    return this.#flush();
  }

  #flush() {
    // Serialize writes so overlapping updates don't lose data or corrupt the file.
    const snapshot = Object.fromEntries(this.map);
    this.queue = this.queue.then(() => atomicWrite(this.filePath, JSON.stringify(snapshot, null, 2))).catch(() => {});
    return this.queue;
  }
}

/**
 * Append-only JSONL log used for the audit trail. Entries are timestamped
 * and never mutated; readers iterate the file line-by-line.
 */
export class AppendLog {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
    ensureDir(path.dirname(filePath));
  }

  async append(entry) {
    const record = { ts: new Date().toISOString(), ...entry };
    const line = `${JSON.stringify(record)}\n`;
    this.queue = this.queue.then(() => fsp.appendFile(this.filePath, line, { mode: 0o600 })).catch(() => {});
    await this.queue;
    return record;
  }

  read({ limit = 500, filter } = {}) {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, 'utf8').trim().split('\n').filter(Boolean);
    const parsed = [];
    for (const line of raw) {
      try { parsed.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    const filtered = filter ? parsed.filter(filter) : parsed;
    return filtered.slice(-limit);
  }
}

/**
 * Namespaced storage bundle used by the server. Callers pick collections by
 * name; each is materialized once per process.
 */
export class Storage {
  constructor({ dataDir = DEFAULT_DATA_DIR } = {}) {
    this.dataDir = dataDir;
    ensureDir(dataDir);
    this.collections = new Map();
    this.audit = new AppendLog(path.join(dataDir, 'audit.jsonl'));
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new JsonCollection(path.join(this.dataDir, `${name}.json`)));
    }
    return this.collections.get(name);
  }
}
