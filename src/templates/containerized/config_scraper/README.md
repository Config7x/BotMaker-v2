# Template #11 — Config Auto-Scraper & Poster (containerized)

Pro-VIP only. Python + Telethon; provisioned per bot instance into its own
gVisor container (`--runtime=runsc`, cap-drop=ALL, resource limits, read-only
rootfs + data volume). No AI scan / admin approval (pre-built, code-reviewed).

• `source/` — reference source (§8.1), adapted: env-driven config via
  `shims/platform_config.py` (session string, API credentials, bot token and
  owner id are injected as env by the provisioner — never hardcoded).
• `shims/login_service.py` — one-shot HTTP Telethon login helper used by the
  creation wizard (phone → OTP → optional 2FA); the session string returns
  encrypted-at-rest to the platform and the helper container is destroyed.
• Customer adds/removes source channels from the per-bot panel
  ("مدیریت کانال‌های منبع").

Build: `docker build -t botmaker/config_scraper:latest .` from this directory.
