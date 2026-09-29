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
| `PORT` | Webhook HTTP listener port | `3000` |
| `PUBLIC_BASE_URL` | Public HTTPS base URL for webhooks | `https://example.com` |
| `ENCRYPTION_KEY` | 32-byte secret key for AES-256-GCM token encryption | 64 hex characters or 32 raw bytes string |
| `ADMIN_ID` | Telegram User ID of system administrator | Integer string (e.g. `123456789`) |
| `INTERNAL_ALERT_SECRET` | Shared secret header key (`X-Internal-Secret`) for `/internal/security-alert` | String secret |
| `AI_AUTO_FIX_FEE_TOMAN` | Wallet fee in Toman charged for optional AI auto-fix requests | `20000` |
| `CUSTOM_SOURCE_FEE_TOMAN` | Wallet fee in Toman charged for custom source submissions from non-subscribers | `50000` |
| `MAX_BOTS_PER_USER` | Maximum bots allowed per Telegram user | `3` |
| `MOCK_TELEGRAM` | Enable mock mode for Telegram API calls | `false` |
| `DB_PATH` | Path to SQLite database file | `./data/botmaker.sqlite` |

---

## 3. Database Specification (`src/db.js`)

### Schema Overview:
- `users`: `(telegram_id INTEGER PRIMARY KEY, role TEXT DEFAULT 'user', wallet_balance REAL DEFAULT 0, plan_id TEXT DEFAULT 'free', plan_expires_at TEXT, created_at TEXT)`
- `bots`: `(id TEXT PRIMARY KEY, owner_id INTEGER, token_encrypted TEXT, secret_token TEXT, username TEXT, template_id TEXT, status TEXT DEFAULT 'active', config JSON, created_at TEXT, updated_at TEXT)`
- `custom_projects`: `(id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, source_dir TEXT NOT NULL, token_encrypted TEXT, runtime TEXT, start_command TEXT, status TEXT NOT NULL, report TEXT NOT NULL, created_at TEXT NOT NULL)`
- `bot_kv`: `(bot_id TEXT, key TEXT, value TEXT, updated_at TEXT, PRIMARY KEY (bot_id, key))`
- `bot_collections`: `(id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, collection TEXT, data JSON, created_at TEXT)`

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

- `POST /webhook/:secretToken`: Receives incoming Telegram updates.
- `POST /internal/security-alert`: Internal security alert hook for runtime container violations.
  - Header: `X-Internal-Secret: <INTERNAL_ALERT_SECRET>`
  - Body: `{ containerId, botId, ruleName, details }`
  - Action: Immediately stops container, sets status to `killed_security_violation`, cleans up source directory, notifies admin, and alerts user.
