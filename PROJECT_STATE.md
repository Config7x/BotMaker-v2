# BotMaker v2: Final State Reference

Snapshot date: 2026-09-29 (Asia/Tehran). Repo: `Config7x/BotMaker-v2`, branch `main`, HEAD `d2834cf`, stable release **v2.1.2** (tags: v2.1.0, v2.1.1, v2.1.2).

## 1. What it is
A multi-tenant Telegram "bot maker" platform. A control bot lets users pick a template, submit their own bot token, and get a running bot. Node.js + Express + SQLite (better-sqlite3), one webhook server routing updates by per-bot secret token. Tokens are stored AES-256-GCM encrypted.

Dependencies: better-sqlite3, express, yauzl, dotenv. Size: ~10.9k lines of JS in `src/`, 97 tests.

## 2. Templates (13)
In-process (11): shop, uploader, post_composer, channel_manager, quiz, downloader, multi_downloader, music_downloader, music_bot, universal_poster, video_downloader.
Containerized, Pro/VIP only (2): **#10 vpn_shop** (PHP VPN store, Marzban/PasarGuard/WGDashboard etc.) and **#11 config_scraper** (Telethon). Each instance runs in its own Docker container under gVisor (`runsc`).

## 3. Plans
| Plan | Price (Toman/month) | Bots |
|------|--------------------|------|
| free | 0 | demo only (1 hour, one-time per template) |
| pro | 100,000 | 5 |
| vip | 250,000 | 15 |

Wallet fees: AI auto-fix 20,000 Toman, custom source submission (non-subscribers) 50,000 Toman. Both configurable by env.

## 4. Repo layout
- `src/index.js` entry: config, DB, webhook registration, lifecycle job, server
- `src/webhook.js` Express app: `/health`, `POST /webhook/:secretToken`, `POST /internal/security-alert`
- `src/admin.js` control bot UI and commands
- `src/db.js` SQLite schema (12 tables)
- `src/templateManager.js`, `src/containerized.js`, `src/containerTemplates.js`, `src/provisioner.js`
- `src/lifecycle.js`, `src/clock.js`, `src/monitoring.js`, `src/cryptoutil.js`, `src/telethon.js`, `src/telegram.js`
- `src/custom/` (11 modules): custom-source flow: validator, analyzer, aiReview, rewrite, runtime, container, controller, diagnostics, manifest, constants, index
- `src/templates/<name>/` one folder per template; `containerized/` holds #10 and #11
- `test/` 16 files, 97 tests
- Docs: README.md, README_FA.md, INTERFACE.md, TEMPLATES_INTERFACE.md, SECURITY-REVIEW.md, CHANGELOG.md

## 5. Control bot commands
/start /help /create_bot /my_bots /templates /wallet /support /sources /source_help /cancel. Admin: /admin /admin_stats /admin_users /admin_plans /admin_wallet /admin_tickets /admin_reply /admin_close /admin_run_lifecycle. UI uses colored buttons.

## 6. Configuration (env, loaded via dotenv; env overrides config.json)
Required for live use: `CONTROL_BOT_TOKEN`, `ENCRYPTION_KEY` (32+ chars, `openssl rand -hex 32`), `PUBLIC_BASE_URL` (HTTPS), `ADMIN_ID`.
Common: `PORT` (default 3000), `HOST` (default 127.0.0.1), `DB_PATH`, `PROJECTS_DIR`, `MAX_BOTS_PER_USER` (3), `ADMIN_ONLY` (default true; set false for multi-user), `INTERNAL_ALERT_SECRET`.
Optional: `TELETHON_API_ID/HASH` (template #11), `AI_API_KEY/AI_ENDPOINT`, fee vars, `MOCK_TELEGRAM`, lab switches (`LAB_MODE`, `TEST_LAB_MODE`, `REVIEWED`, `LAB_ALLOW_NETWORK`, `GVISOR_AVAILABLE`). Full list: `.env.example` and INTERFACE.md.

## 7. Install and operate (Ubuntu VPS)
- Run `install.sh` as root: idempotent, copies app to the app dir, creates `.env`, installs deps, sets up systemd service `botmaker-v2` (runs `node src/index.js`), configures gVisor and container images.
- Needs a domain with valid HTTPS. Reverse proxy `/webhook/*` to `127.0.0.1:3000` (Caddy example in README_FA.md). Do not expose port 3000 publicly.
- Health check: `curl http://127.0.0.1:3000/health`
- Logs: `journalctl -u botmaker-v2 -f`
- Update: `git pull`, rerun `install.sh`. Keep `.env` and `data/`.
- If an older server `.env` has `PORT=8443`, either keep it and match the proxy, or change to 3000.

## 8. Security notes
AES-256-GCM token encryption; per-bot webhook secret verified on every update; internal alert endpoint requires `X-Internal-Secret`; custom user sources pass automated review then admin approval, run in gVisor containers, and are killed and deleted on a security alert. `npm audit`: 0 vulnerabilities. No secrets or DB files are tracked. Details: SECURITY-REVIEW.md.

## 9. History
- v2.1.0: merged the modular 11-file `src/custom/` architecture with GitHub's core modules and containerized #10/#11. Tests 33 to 97.
- v2.1.1: fixed `.env` never being loaded (added dotenv), docs audit.
- v2.1.2: wired dead fee env vars, completed INTERFACE.md and SECURITY-REVIEW.md.
- After v2.1.2 (on main, untagged): PR #7 (Base44 dev environment) merged then reverted at owner request; default PORT aligned 8443 to 3000; `.env.example` completed.

## 10. Known gaps and open items
1. **Real VPS install not yet verified.** Tests mock Telegram, Docker and HTTPS. First real install is the true test.
2. The merge dropped GitHub's old `wallet`, `support`, `panel` and `monitoring` test files (~400 lines). Those modules currently have no dedicated tests.
3. The "94 vs 97 tests" difference (3 extra tests in the merge) is not traced to specific tests; the 94-test archive was no longer available to diff.
4. Git history still contains the PR #7 merge commit (content removed, history not rewritten).
5. Unreleased changes after v2.1.2 are not yet tagged (suggest v2.1.3 after the first successful install).

## 11. Suggested next steps
1. Install on the VPS and send back the `/health` output and `journalctl` logs.
2. Restore tests for wallet, support and monitoring.
3. Tag v2.1.3.
4. Build high-value business templates (booking, online course seller, payment-integrated store), the direction identified in the market research.
