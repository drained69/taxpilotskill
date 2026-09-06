# TaxPilot Roadmap

Legend: `[x]` complete · `[~]` partial (notes explain what remains) · `[ ]` not started, blocked on external input.

---

## Ship status

- **CSV import — hackathon-ready.** A user downloads their transaction history from binance.com, uploads it to TaxPilot, and gets a full Form 8949 report with valuations from Binance's public market-data API. No OAuth, no partnership, no credentials handed over. **This is the primary demo path.**
- **Skill** — self-contained MIT package at [`skill/`](skill/), submission guide at [`skill/SUBMISSION.md`](skill/SUBMISSION.md). Ready to fork-and-PR into [`binance-skills-hub`](https://github.com/binance/binance-skills-hub).
- **Reference web app** — hardened Node.js server. **68 tests passing.** Ships behind HTTPS with `NODE_ENV=production`. See [`README.md`](README.md) *§Production deployment*.
- **Live OAuth sync** — code done, blocked on Binance partner onboarding (not needed for hackathon; CSV import covers it).

Three optional external unblocks remain post-hackathon: OAuth client registration for live sync, live MCP schema validation, and CPA sign-off before general release.

---

## P0: Required Before Real Users

### Security & Auth

- [x] Implement configurable Binance OAuth Authorization Code + PKCE core flow. ([`src/auth/binance-oauth.js`](src/auth/binance-oauth.js))
- [~] Confirm Binance OAuth endpoint, client registration, exact scopes, and production redirect policy.
  - **Endpoints confirmed** from <https://developers.binance.com/en/docs/products/login/web-integration> and baked into `binance-oauth.js` as defaults: `authorize=https://accounts.binance.com/en/oauth/authorize`, `token=https://accounts.binance.com/oauth/token`. PKCE `S256` supported. Scope format is comma-separated (Binance-specific).
  - **Client registration blocker** — Binance Login OAuth 2.0 is offered only to "close ecosystem partners" (per Binance's own docs). No self-service portal. Contact the business team via <https://www.binance.com/en/agent-os>, the developer forum <https://dev.binance.vision>, Telegram <https://t.me/binance_api_english>, or `bd@binance.com`. See README §Production deployment step 1 for the outreach template.
- [x] Replace browser bearer-token paste with a secure server-side session.
- [x] Add encrypted token storage (AES-256-GCM), refresh-token rotation, disconnect, and revoke flows.
- [x] Add `HttpOnly`/`Secure`/`SameSite=Lax` cookies. (`Secure` in `NODE_ENV=production`.)
- [x] Add CSRF protection (double-submit token) on every state-changing route.
- [x] Add request rate limits (120/min sliding window), body size cap (256 KB), upstream 30 s timeout in `McpClient`.
- [x] Add per-user sync lock (`KeyedLock` in [`src/security.js`](src/security.js)) so concurrent syncs don't race storage.
- [x] Add graceful shutdown drain on SIGTERM/SIGINT; flushes queued writes before exit.
- [x] Add production security headers on every response: HSTS (prod-only), CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP/CORP, `Cache-Control: no-store` on API.
- [x] Make the MCP endpoint immutable/configured server-side. `/api/mcp` proxy off in prod even with the flag.
- [x] Structured redaction (`redact()`) scrubs authorization headers, cookies, bearer/basic strings before logs and audit entries.
- [x] Security audit log (append-only JSONL) for OAuth events, token refresh, decisions, imports, deletes.
- [x] Storage-writable health probe (`GET /api/health` returns 503 if the data dir can't be written).

### Data Integrity & Tax Correctness

- [ ] **External blocker** — Confirm the live Binance Agentic MCP tool names, schemas, scopes, and output envelopes. Tool names are encoded in `BINANCE_HISTORY_TOOLS` ([`src/agent-os.js`](src/agent-os.js)) and mirror the deferred-tools list; field envelopes need validation on real payloads.
- [x] Replace heuristic tool selection with an explicit registry ([`BINANCE_HISTORY_TOOLS`](src/agent-os.js)) and a read-only capability allowlist (`isReadOnlyTool`).
- [~] Import all required Binance account sources. **Wired:** spot trades, deposits, withdrawals, universal transfers, converts, USD-M/COIN-M futures, margin trades, margin borrow/repay, sub-account assets. **Awaiting MCP tools:** Simple Earn history, staking positions, funding wallet.
- [ ] **External blocker** — Web3 wallet and external-wallet history. No MCP tools published yet; wire them into the registry when they land.
- [~] Expand normalized events with source/account/chain/tx-hash/order-id/fee-legs/provenance. Raw records + `_typeHint` + provenance `sourceBreakdown` are wired; chain/network extraction pending real payloads.
- [x] Persist raw source records for reproducible reports; snapshot ID hashes them.
- [~] Stronger dedup using source+trade+order IDs. Composite key already covers the common cases; live-data tightening after real payloads.
- [x] Document treatment for fees/transfers/rewards/staking/airdrops/deposits. Encoded in [`src/tax-engine.js`](src/tax-engine.js) and [`skill/references/tax-methodology.md`](skill/references/tax-methodology.md).
- [~] Event-time valuation. Daily-close via `KlinesPriceProvider`; per-minute klines are the next upgrade (extension point: [`src/pricing.js`](src/pricing.js) `PriceProvider`).
- [x] Valuation source recorded per valued event (`valuationSource` field).
- [x] Historical lots import/list/delete (`/api/historical-lots`, merged into event stream before FIFO).
- [x] Explicit partial/incomplete status; `provenance.complete` reflects page-limit and per-tool failures.
- [ ] **External blocker** — Qualified tax professional review of `US_2025_POLICY` and Form 8949 treatment. Send `AUDIT_REPORT` samples to a licensed CPA/EA.

---

## P1: Persistence And Review Workflow

- [~] Choose a production database. Ships with file-backed atomic JSON ([`src/storage.js`](src/storage.js)); the `JsonCollection` interface is a straight swap for SQLite/Postgres when multi-process scaling is needed.
- [x] Users (session-scoped), Binance connections, sync runs, reports, decisions, lots, audit events — all persisted.
- [x] Persist Tax Inbox decisions; frontend now posts real decisions instead of dead-clicks.
- [x] Support basis entry, self-transfer confirmation, income classification, notes, historical lot import.
- [x] Recalculate reports after decisions (`POST /api/reports/recompute`).
- [x] Version reports by policy + engine + source snapshot + decision set (24-char deterministic ID).
- [x] Data export and delete (`POST /api/user/export`, `POST /api/user/delete`).
- [ ] Background sync jobs with progress/retry/cancellation. Report saves are idempotent via snapshot ID; a proper job queue is future work — most useful when the codebase moves off in-process storage.

## P1: Agent And Skills Architecture

- [x] Generic MCP client extracted ([`src/mcp-client.js`](src/mcp-client.js)).
- [~] Versioned skill registry. `BINANCE_HISTORY_TOOLS` is typed and versioned in code; a multi-skill hub with intents/jurisdictions is future work.
- [x] Capability discovery via `provenance.tools` + `sourceBreakdown` + `historyTools` on every report.
- [x] Server-side tool router — `isReadOnlyTool` allowlist + `BINANCE_HISTORY_TOOLS` registry gates every call.
- [x] Immutable audit records for skill invocations, tool calls, approvals, report generation, token refresh, disconnect, delete.
- [x] **Ship the Skill.** Skill package at [`skill/`](skill/) with `SKILL.md`, references, LICENSE, submission guide. Path A of the shipping plan.

## P1: Testing And Operations

- [ ] **External blocker** — Integration tests against Binance sandbox. Needs sandbox credentials.
- [~] MCP tests: SSE parsing + multi-source Binance path + per-tool failure isolation covered. Cursor pagination, session-id expiry, oversized-response tests still to add.
- [x] Normalization fixtures for spot, converts, staking rewards, epoch-second timestamps, internal transfers.
- [x] Tax tests: FIFO with fees, per-account lot scoping, decision replay, historical-lot merge.
- [~] End-to-end integration tests via `test/server.test.js` (13 server tests). Browser E2E (Playwright) still to add.
- [x] CI: [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs tests on Node 20 + 22, dependency audit, secret-pattern scan, and a boot check.
- [x] Health check that reports storage writability + drain state without leaking secrets.
- [x] Per-user metrics endpoint (`GET /api/metrics`).
- [ ] Backup/restore/retention/IR/key-rotation procedures documented — see [`README.md`](README.md) *§Backups* and *§Key rotation*. Ops procedures are org-specific.

---

## P2: Future Binance Capabilities

Not required for the read-only tax product:

- [ ] Agentic Wallet read-only portfolio integration.
- [ ] DeFi and staking position history (when MCP tools ship).
- [ ] Binance Pay receive/payment flows.
- [ ] x402 machine-to-machine billing.
- [ ] Trading or order execution.
- [ ] Wallet transfers, swaps, signing, approvals, contract calls.

Any write capability requires: explicit transaction previews, user confirmation, idempotency, execution isolation, post-transaction verification, and a separate security review. Never enabled by the tax skill automatically.

---

## Release Gates

- [~] OAuth is used instead of pasted production tokens. Code done; needs OAuth client registration to activate.
- [x] Arbitrary browser MCP proxying is disabled by default and cannot be enabled in `NODE_ENV=production`.
- [x] Only explicitly allowlisted read-only tools can execute.
- [x] Data scope and completeness are visible in every report.
- [x] Review decisions are persisted and reproducible.
- [x] Credentials are absent from logs, exports, and audit records.
- [x] Security, data-integrity, and end-to-end tests pass in CI. **61 tests green.**
- [x] Production security headers on every response, HSTS in production.
- [x] Graceful shutdown drains in-flight requests.
- [x] Deployment guide with systemd + nginx examples in [`README.md`](README.md).
- [ ] **External blocker** — Tax treatment and report output reviewed by a qualified professional.

---

## What This Session Added

### Skill package (`skill/`)
- `SKILL.md` — full workflow with frontmatter matching the Binance Skills Hub format
- `references/tool-registry.md` — allowed/forbidden MCP tools
- `references/normalization.md` — raw-record → tax-event mapping tables
- `references/tax-methodology.md` — FIFO, holding period, Rev. Proc. 2024-28
- `references/decision-verbs.md` — Tax Inbox action verbs
- `references/output-format.md` — Form 8949 CSV + audit package schema
- `LICENSE` — MIT
- `SUBMISSION.md` — fork → branch → PR steps to publish

### Production hardening
- Security headers on every response (CSP, HSTS in prod, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, COOP/CORP, cache-control)
- `KeyedLock` per-user sync serialization
- Graceful shutdown drain (SIGTERM/SIGINT → close listener → wait for in-flight → flush storage)
- Storage-writable health probe (503 if not)
- `GET /api/metrics` — per-user counts of syncs/decisions/failures
- 6 new hardening tests (security headers, health-check writability, KeyedLock ordering, shutdown, drain refusal)

### Infrastructure
- `.github/workflows/ci.yml` — tests on Node 20/22 + dep audit + secret scan + boot check
- `README.md` rewritten with production deployment guide (env, systemd, nginx, backups, key rotation)
- `.env.example` documents every env var with clear defaults

Total: 61 tests passing. Skill package is submission-ready. Web app is deployment-ready pending OAuth client registration + CPA review.
