# Changelog

## Unreleased

- **Fix:** `.env.example` default `PORT` changed 8443 → 3000 to match the code default, README Caddy/health examples and install.sh (a README-following install would have proxied to the wrong port).
- **Docs:** `.env.example` now lists all 12 previously undocumented env vars (HOST, PROJECTS_DIR, MOCK_TELEGRAM, fee vars, AI_*, GVISOR_AVAILABLE, lab switches).

- Reverted PR #7 (Base44 dev environment): removed `docker-compose.base44.yml`, `.env.base44-defaults`, `.base44/`, `AGENTS.md`, the `GET /` landing page, and the related README section.

## v2.1.2 (2026-09-29)

- **Fix:** `AI_AUTO_FIX_FEE_TOMAN` / `CUSTOM_SOURCE_FEE_TOMAN` env vars were documented but never wired — now loaded via `loadConfig` (env > config.json > default).
- **Docs:** `INTERFACE.md` env table completed (CONTROL_BOT_TOKEN, ADMIN_ONLY, HOST, PROJECTS_DIR, lab switches, Telethon, gVisor, AI service vars), DB schema overview now lists all 12 tables (plans, demo_usage, update_receipts, wallet_transactions, support tickets, custom_templates, containers), endpoints section updated (GET /, GET /health, containerized skip).
- **Docs:** `SECURITY-REVIEW.md` stale `/api/v2/webhook/*` paths corrected to actual endpoints (`/health`, `/webhook/:secretToken`).

## v2.1.1 (2026-09-29)

- **Fix:** `.env` is now loaded via `dotenv` at startup — previously `install.sh` wrote `.env` but the service never read it (systemd installs ran on defaults).
- **Fix:** `install.sh` health-check line corrected to the real endpoint (`/health`, port read from `.env`).
- **Docs:** `README_FA.md` refreshed for GitHub (install paths, 97 tests, full template list). `CHANGELOG.md` added.

## v2.1.0 (2026-09-29)

- Adopted the modular "block" architecture (`src/custom/`, 11 files) as the primary base.
- Containerized templates #10 (VPN Shop) and #11 (Config Auto-Scraper) as Pro/VIP-only, dedicated gVisor container per bot.
- New core modules: `provisioner`, `telethon` driver, `cryptoutil`, `monitoring`, `clock`, `containerTemplates`.
- `templateManager` with dynamic ZIP template installation (admin).
- `containers` table + CRUD; dedicated containerized-bot panel with colored buttons.
- Webhook skips containerized bots; free-plan users refused at template selection.
- AES-256-GCM encryption for Telethon sessions and panel passwords.
- `install.sh` / `.env.example` aligned with v2.1.0 env keys.
- Test suite expanded 28 → 97, all passing.

## v2.0.0

- Multi-tenant Telegram bot builder platform: control bot, webhook dispatch, SQLite storage, AES-256-GCM token encryption, in-process templates, wallet/plans/lifecycle, custom-source lab (gVisor, fail-closed), Falco alert endpoint, systemd installer.
