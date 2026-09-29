# BotMaker v2 Core Interface Contract & System Specification

This document defines the interface contract between the core runner/webhook engine and template/extension modules in `botmaker-v2`.

---

## 1. System Architecture Overview

`botmaker-v2` is a multi-tenant Telegram Bot Builder framework running on Node.js 20 and SQLite (`better-sqlite3`).

### Core Responsibilities:
- **Control Bot & Admin Handler (`src/admin.js`, `src/index.js`)**: Persian-localized Telegram bot interface for users to create, manage, configure template, and delete Telegram bots.
- **Custom Source Manager (`src/custom/controller.js`)**: Public-facing paid custom Node.js/Python project hosting pipeline with payment gates, gVisor container isolation, and AI security/bug review passes.
- **Database Layer (`src/db.js`)**: Schema initialization, bot metadata storage, encrypted token storage, user quota tracking, wallet transactions, and per-bot state/document persistence.
- **Telegram Client & Mocking Layer (`src/telegram.js`)**: Unified HTTP request handler for Telegram Bot API with mock capabilities for offline unit testing.
- **Central Webhook Dispatcher (`src/webhook.js`)**: Express-based HTTPS webhook server routing updates to template handlers with secret token validation and internal security alert hooks.

---

## 2. Configuration & Environment Contract

| Variable | Description | Default / Format |
|----------|-------------|------------------|
| `CONTROL_BOT_TOKEN` | Control bot token from @BotFather (required unless mock) | `<token>` |
| `ENCRYPTION_KEY` | 32-byte secret key for AES-256-GCM token encryption | 64 hex characters or 32 raw bytes string |
| `PUBLIC_BASE_URL` | Public HTTPS base URL for webhooks | `https://example.com` |
| `PORT` / `HOST` | Webhook HTTP listener port / bind host | `3000` / `127.0.0.1` |
| `ADMIN_ID` | Telegram User ID of system administrator | Integer string (e.g. `123456789`) |
| `ADMIN_ONLY` | When `false`, regular users can use the platform (multi-tenant) | `true` (admin-only) |
| `MAX_BOTS_PER_USER` | Maximum bots allowed per Telegram user | `3` |
| `DB_PATH` | Path to SQLite database file | `./data/botmaker.sqlite` |
| `PROJECTS_DIR` | Directory for custom-source project files | `./data/projects` |
| `MOCK_TELEGRAM` | Enable mock mode for Telegram API calls | `false` |
| `INTERNAL_ALERT_SECRET` | Shared secret header key (`X-Internal-Secret`) for `/internal/security-alert` | String secret |
| `AI_AUTO_FIX_FEE_TOMAN` | Wallet fee (Toman) for optional AI auto-fix requests | `20000` |
| `CUSTOM_SOURCE_FEE_TOMAN` | Wallet fee (Toman) for custom source submissions from non-subscribers | `50000` |
| `AI_API_KEY` / `AI_ENDPOINT` | External AI review service credentials (custom-source rewrite flow) | — |
| `TELETHON_API_ID` / `TELETHON_API_HASH` | Telethon credentials (my.telegram.org) for template #11 | `0` / — |
| `GVISOR_AVAILABLE` | Marks gVisor runtime as installed (set by install.sh) | `false` |
| `LAB_MODE` / `TEST_LAB_MODE` / `REVIEWED` / `LAB_ALLOW_NETWORK` | Custom-source lab opt-in switches (see README_FA.md) | `false` |

`.env` is loaded via `dotenv` at startup (real environment variables take precedence); `config.json` is the file-based alternative and `.env.example` documents all keys.

---

## 3. Database Specification (`src/db.js`)

### Schema Overview:
- `users`: `(telegram_id INTEGER PRIMARY KEY, role TEXT DEFAULT 'user', wallet_balance REAL DEFAULT 0, plan_id TEXT DEFAULT 'free', plan_expires_at TEXT, created_at TEXT)`
- `plans`: subscription plan definitions (free/pro/vip) with quota and feature flags
- `bots`: `(id TEXT PRIMARY KEY, owner_id INTEGER, token_encrypted TEXT, secret_token TEXT, username TEXT, template_id TEXT, status TEXT DEFAULT 'active', config JSON, created_at TEXT, updated_at TEXT)`
- `demo_usage`: per-demo expiry tracking (warn at minute 50, grace at 60, expire at 360)
- `update_receipts`: dedup of processed Telegram update_ids per bot
- `bot_kv`: `(bot_id TEXT, key TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (bot_id, key))`
- `bot_collections`: `(id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, collection TEXT, data JSON, created_at TEXT)`
- `wallet_transactions`: wallet charge/topup ledger (Toman amounts + reason)
- `support_tickets` / `ticket_messages`: support ticketing with per-ticket message threads
- `custom_projects`: `(id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, source_dir TEXT NOT NULL, token_encrypted TEXT, runtime TEXT, start_command TEXT, status TEXT NOT NULL, report TEXT NOT NULL, created_at TEXT NOT NULL)`
- `custom_templates`: admin-installed ZIP templates (`source_dir`, `enabled`) loaded by `templateManager`
- `containers`: `(bot_id, container_name, image, status, created_at, updated_at)` — one dedicated gVisor container per containerized bot

### Custom Project Statuses:
- `ready`: Zip uploaded, validated, and awaiting token/start.
- `pending_admin_approval`: Passed automated security & bug reviews, waiting for admin approval.
- `approved`: Approved by system administrator and ready for execution.
- `rejected`: Rejected by system administrator.
- `running`: Active container execution under gVisor (`runsc`).
- `stopped`: Execution paused or stopped manually.
- `killed_security_violation`: Container killed, source deleted due to internal security alert.

---

## 4. Telegram API Client Contract (`src/telegram.js`)

`src/telegram.js` provides both direct Telegram API calling functions and template-scoped `api` wrappers.

---

## 5. Central Webhook & Internal Endpoints (`src/webhook.js`)

- `GET /`: Minimal landing page (Base44 dev preview).
- `GET /health`: Health check.
- `POST /webhook/:secretToken`: Receives incoming Telegram updates (updates for containerized bots are skipped — they run in their own container).
- `POST /internal/security-alert`: Internal security alert hook for runtime container violations.
  - Header: `X-Internal-Secret: <INTERNAL_ALERT_SECRET>`
  - Body: `{ containerId, botId, ruleName, details }`
  - Action: Immediately stops container, sets status to `killed_security_violation`, cleans up source directory, notifies admin, and alerts user.
