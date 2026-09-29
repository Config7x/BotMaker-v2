# BotMaker v2 — Base44 Dev Environment

## What this is
Node.js 20 + Express + SQLite backend for building/managing Telegram bots. No frontend UI — it's a webhook server with a `/health` endpoint. A minimal landing page was added at `GET /` so the preview shows the server is alive.

## Running
```bash
docker compose -f docker-compose.base44.yml up -d
curl http://localhost:3000/health   # {"status":"ok",...}
```

## Key setup details
- **Mock mode**: `MOCK_TELEGRAM=true` lets the app boot without a real Telegram bot token. Without mock mode, `CONTROL_BOT_TOKEN` (from @BotFather), a valid HTTPS `PUBLIC_BASE_URL`, `ADMIN_ID`, and `ENCRYPTION_KEY` (≥32 chars) are all required.
- **`HOST=0.0.0.0`** is required in Docker so the port mapping works (code defaults to `127.0.0.1`).
- **`PORT=3000`** maps to the preview's required port.
- `better-sqlite3` is a native addon; `node:20` (full Debian image) is used so build tools are available if prebuilds don't match.
- Dependencies install on container startup via `npm ci` (lockfile-preserving). Source is bind-mounted so edits hot-reload after a container restart.

## Secrets (all optional — app boots in mock mode without them)
- `CONTROL_BOT_TOKEN` — real Telegram control bot token from @BotFather; needed for live bot operation.
- `TELETHON_API_ID` / `TELETHON_API_HASH` — from https://my.telegram.org; only for template #11 (Config Auto-Scraper).
- `INTERNAL_ALERT_SECRET` — shared secret for the `/internal/security-alert` endpoint.

## Tests
```bash
docker compose -f docker-compose.base44.yml exec -T app npm test
```

## Architecture
- Entry point: `src/index.js` → loads config, inits DB, registers control bot webhook, starts lifecycle job, starts Express server.
- Webhook dispatch: `src/webhook.js` — routes Telegram updates to template handlers by secret token.
- Templates: 11 in-process templates in `src/templates/`, 2 containerized (Docker + gVisor) for Pro/VIP plans.
- Config: env vars override `config.json` (see `loadConfig()` in `src/index.js`).
