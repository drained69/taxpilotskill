# TaxPilot

**An explainable, read-only crypto tax workspace with deep [Binance Agent OS](https://www.binance.com/en/agent-os) integration.**

TaxPilot ships in two forms:

- **Skill** (`skill/`) — an MIT-licensed, MCP-native skill for the [Binance Skills Hub](https://www.binance.com/en/skills). An agent (Claude, Cursor, your own) that has authenticated the Binance MCP server can run TaxPilot's methodology directly. See [`skill/SUBMISSION.md`](skill/SUBMISSION.md).
- **Reference web app** (`server.js` + `public/`) — the same tax engine wrapped in a hardened Node.js server, with OAuth, encrypted token storage, review workflow persistence, audit log, and a browser dashboard.

Both share the same tax methodology in [`src/tax-engine.js`](src/tax-engine.js).

---

## Quick start

Requires Node 18+ (developed on Node 22+).

```bash
npm start          # http://localhost:3000
npm test           # 55 tests
```

## Product intro video

The Remotion composition `TaxPilotIntro` lives in `src/remotion/`. Install the
dependencies, open the timeline in Remotion Studio, or render the 45-second
intro directly:

```bash
npm install
npm run remotion:studio
npm run remotion:render
```

The default render is written to `out/taxpilot-intro.mp4`.

Open the app and choose **Use demo workspace** to explore with synthetic data — no credentials, no Binance permissions.

For a **live** report you must configure OAuth (see *Production deployment* below).

---

## Architecture

```
Browser ──POST /api/agent-os/report (session cookie + CSRF)──▶ server.js
                                                                   │
                                                                   ▼
   src/agent-os.js  buildTaxReportFromAgentOS()
     │
     ├─ src/mcp-client.js   initialize → notifications/initialized → tools/list → tools/call
     │                      (Streamable HTTP: JSON + text/event-stream, Mcp-Session-Id)
     ├─ src/normalize.js    Agent OS records → tax-engine events (field/type adapter)
     ├─ src/pricing.js      historical USD valuation for events with no USD leg
     ├─ src/tax-engine.js   FIFO lots, Form 8949, income, transfers, unresolved
     └─ src/reports.js      deterministic snapshot IDs + decision replay + historical-lot merger
                             │
                             ▼
                         src/storage.js (file-backed JSON collections + audit JSONL)
```

Cross-cutting: [`src/security.js`](src/security.js) provides CSRF double-submit tokens, a sliding-window rate limiter, a keyed sync-lock, and credential-scrubbing logging.

---

## Endpoints

| Method   | Path                                    | Auth | CSRF | Purpose                                              |
| -------- | --------------------------------------- | ---- | ---- | ---------------------------------------------------- |
| `GET`    | `/api/health`                           | -    | -    | Liveness + storage-writable probe + drain state      |
| `GET`    | `/api/csrf`                             | -    | -    | Issue a CSRF token (double-submit cookie)            |
| `GET`    | `/api/tax-report`                       | -    | -    | Deterministic demo report                            |
| `GET`    | `/api/auth/binance/start`               | -    | -    | Begin OAuth (PKCE)                                   |
| `GET`    | `/api/auth/binance/callback`            | -    | -    | OAuth callback                                       |
| `GET`    | `/api/connections/binance`              | -    | -    | Connection status                                    |
| `POST`   | `/api/connections/binance/disconnect`   | ✔    | ✔    | Revoke + delete token                                |
| `POST`   | `/api/agent-os/report`                  | ✔    | ✔    | Run pipeline, persist snapshot                       |
| `GET`    | `/api/reports`                          | ✔    | -    | List snapshots                                       |
| `GET`    | `/api/reports/:id`                      | ✔    | -    | Fetch a snapshot                                     |
| `POST`   | `/api/reports/recompute`                | ✔    | ✔    | Reapply decisions + lots to a base snapshot          |
| `GET`    | `/api/decisions`                        | ✔    | -    | List review decisions                                |
| `POST`   | `/api/decisions`                        | ✔    | ✔    | Save a decision on an unresolved event               |
| `GET`    | `/api/historical-lots`                  | ✔    | -    | List imported lots                                   |
| `POST`   | `/api/historical-lots`                  | ✔    | ✔    | Import lots                                          |
| `DELETE` | `/api/historical-lots/:id`              | ✔    | ✔    | Delete a lot                                         |
| `GET`    | `/api/audit-log`                        | ✔    | -    | Read the user's audit trail                          |
| `GET`    | `/api/metrics`                          | ✔    | -    | Per-user counts (syncs, decisions, failures)         |
| `POST`   | `/api/user/export`                      | ✔    | ✔    | Export all data for the caller                       |
| `POST`   | `/api/user/delete`                      | ✔    | ✔    | Delete all data for the caller                       |
| `GET/POST` | `/api/reports/form-8949.csv`          | -    | -    | Form 8949 CSV (demo or inline report)                |
| `POST`   | `/api/mcp`                              | -    | -    | Dev-only MCP proxy (off by default; off in prod)     |

---

## Security posture

- **Read-only pipeline.** The `BINANCE_HISTORY_TOOLS` allowlist in [`src/agent-os.js`](src/agent-os.js) is enforced before any `tools/call`. Every write verb is on a deny list.
- **CSRF everywhere.** Double-submit token (`taxpilot_csrf` cookie + `x-csrf-token` header) required on every mutating route.
- **Rate-limited.** Sliding window, 120 req/min per session or IP, `Retry-After` header on 429.
- **Session invalidation is honored.** A destroyed session cookie is treated as unauthenticated even if the cookie string is still present.
- **Encrypted at rest.** OAuth tokens use AES-256-GCM (`EncryptedTokenStore`). Files are `0600`.
- **Structured redaction.** `redact()` scrubs authorization headers, cookies, tokens, and inline Bearer/Basic strings before anything hits the audit log or `safeLog`.
- **CSP / HSTS / X-Frame-Options / Referrer-Policy** on every response. HSTS only when `NODE_ENV=production`.
- **Graceful shutdown.** SIGTERM/SIGINT stops accepting new work, drains in-flight requests, and flushes queued writes.
- **Per-user sync lock.** Concurrent syncs from one user are serialized; two clicks won't race the storage layer.

---

## Environment

Copy [`.env.example`](.env.example) to `.env`. Every var is documented there. Required for a live deploy: the eight `BINANCE_OAUTH_*` vars plus `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` (32+ bytes of entropy each).

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

---

## Production deployment

### 1. Get OAuth client credentials from Binance

**Important:** Binance Login (OAuth 2.0) is currently offered only to close ecosystem partners — not a self-service developer portal. See the official notice at <https://developers.binance.com/en/docs/products/login/introduction>:

> "For now, Binance Login (Oauth2.0), is only provided to close ecosystem partners now. Please reach to our business team for more details."

**How to reach them:**

| Channel | Where |
|---------|-------|
| Agent OS partnership page | <https://www.binance.com/en/agent-os> (look for a "Contact" / "Partner with us" section) |
| Developer forum | <https://dev.binance.vision> |
| Developer Telegram | <https://t.me/binance_api_english> |
| General BD email | `bd@binance.com` (typical partnership address; ask them to route) |

Ask specifically for **Binance Login OAuth 2.0 partner onboarding** and describe your use case: read-only access to spot trades, deposits, withdrawals, converts, universal transfers, futures, and margin history for tax reporting.

Binance will issue:
- `client_id`
- `client_secret`
- The exact **scope names** you're approved for (documented examples: `user:openId`, `create:apikey`; tax-specific scopes are assigned per partner)

The **runtime endpoints** are documented and already the code defaults, so you don't need to look them up:

| | URL |
|--|--|
| Authorization | `https://accounts.binance.com/en/oauth/authorize` |
| Token | `https://accounts.binance.com/oauth/token` |
| PKCE | `S256` supported and recommended |
| Scope format | comma-separated (Binance-specific, not the OAuth 2.0 default of space-separated) |

**Your redirect URI** will be `https://<your-domain>/api/auth/binance/callback` — give this to Binance during onboarding.

### 2a. One-click deploy on Railway (fastest)

TaxPilot ships with [`railway.toml`](railway.toml) and [`nixpacks.toml`](nixpacks.toml) so a Railway deploy needs three clicks:

1. Push this repo to GitHub.
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub** → pick the repo.
3. In the service's **Settings**, add a **Volume** and mount it at `/data`.
4. In the service's **Variables**, set:
   - `NODE_ENV=production`
   - `TAXPILOT_DATA_DIR=/data`
   - `SESSION_SECRET=<generate>` (`node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`)
   - `TOKEN_ENCRYPTION_KEY=<generate>` (same command, different value)
5. Deploy. Railway assigns a public URL; add it to your Binance OAuth redirect list once you're onboarded.

Health check at `/api/health` is already wired via `railway.toml`. Graceful shutdown drains in-flight requests before Railway kills the container.

### 2b. Provision a host (any other target)

Any Node 18+ host works. Recommended layout:

- **HTTPS terminator** in front (nginx / Caddy / CloudFlare). TaxPilot expects to receive plain HTTP from the terminator and adds HSTS + Secure cookies when `NODE_ENV=production`.
- **Persistent volume** mounted at `TAXPILOT_DATA_DIR` (default `.taxpilot-data/`). Include this in your backup schedule — it holds sessions, encrypted tokens, reports, decisions, lots, and the audit log.
- **Process supervisor** (systemd, k8s, PM2) that sends SIGTERM on stop and gives at least 30s for the graceful-shutdown drain.

Example systemd unit:

```ini
[Unit]
Description=TaxPilot
After=network.target

[Service]
Environment=NODE_ENV=production
Environment=PORT=8080
Environment=TAXPILOT_DATA_DIR=/var/lib/taxpilot
EnvironmentFile=/etc/taxpilot/env
ExecStart=/usr/bin/node /opt/taxpilot/server.js
Restart=on-failure
TimeoutStopSec=45s
User=taxpilot
ReadWritePaths=/var/lib/taxpilot

[Install]
WantedBy=multi-user.target
```

Example nginx snippet:

```nginx
server {
  listen 443 ssl http2;
  server_name taxpilot.example.com;

  ssl_certificate     /etc/ssl/fullchain.pem;
  ssl_certificate_key /etc/ssl/privkey.pem;

  # TaxPilot sets its own HSTS + CSP in production.
  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### 3. First-run verification

```bash
curl -sf https://taxpilot.example.com/api/health | jq
# Expect { "ok": true, "storage": { "ok": true }, "oauthConfigured": true, ... }
```

Then walk the connect → sync → decision → export flow end-to-end with a test Binance account.

### 4. Backups

Snapshot `TAXPILOT_DATA_DIR` at least daily. The file layout is stable JSON, safe to `cp -r` while the server runs (writes are atomic renames). Restore is `stop → rsync → start`.

### 5. Key rotation

`SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` are read at process start. To rotate:

1. Distribute the new keys.
2. Restart the process — existing sessions and encrypted tokens become unreadable and users must reconnect.
3. To rotate without invalidating stored data, script a decrypt-with-old, re-encrypt-with-new pass over `tokens.json` before deploying the new key.

---

## Publishing the Skill

The `skill/` directory is a self-contained MIT-licensed package that matches the Binance Skills Hub layout. See [`skill/SUBMISSION.md`](skill/SUBMISSION.md) for the fork → branch → PR steps. Once merged, users install it via:

```bash
npx skills add https://github.com/binance/binance-skills-hub/tree/main/skills/binance/taxpilot
```

The skill and the reference web app share the same methodology but ship for different audiences: the skill lives inside an agent session; the web app is a hosted dashboard.

---

## Testing

```bash
npm test            # 55 tests
node --test test/normalize.test.js   # single file
```

CI runs on push and PR via [.github/workflows/ci.yml](.github/workflows/ci.yml): tests on Node 20 + 22, dependency audit, a basic secret pattern scan, and a boot check that hits `/api/health`.

---

## Disclaimer

TaxPilot provides estimates for educational purposes and is **not tax or legal advice**. Have a licensed CPA or enrolled agent review before filing.

---

## References

- Binance Agent OS — <https://www.binance.com/en/agent-os>
- Binance Skills Hub — <https://www.binance.com/en/skills> · <https://github.com/binance/binance-skills-hub>
- Model Context Protocol — <https://modelcontextprotocol.io>
- IRS Digital Assets — <https://www.irs.gov/filing/digital-assets>
- Form 8949 — <https://www.irs.gov/forms-pubs/about-form-8949>
- Rev. Proc. 2024-28 — <https://www.irs.gov/pub/irs-drop/rp-24-28.pdf>
# taxpilotskill
