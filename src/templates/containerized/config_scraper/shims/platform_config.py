# -*- coding: utf-8 -*-
"""
BotMaker v2 platform shim — env-driven config override for the
Config Auto-Scraper template (#11).

The reference source's config.py used hardcoded (now-redacted) values.
This shim is imported at the END of config.py so every value can be
supplied fresh via environment variables by the provisioner:

  TELETHON_SESSION_STRING  encrypted-at-rest Telethon user session (injected decrypted)
  TELETHON_API_ID / TELETHON_API_HASH  fresh platform-level API credentials
  BOT_TOKEN                management sub-bot (BotFather)
  OWNER_ID                 BotMaker user id (admin of this instance)
  SCRAPE_SWEEP_MINUTES     channel sweep interval

Reference security note honored: no credentials are ever copied from the
shared reference copy — only env vars.
"""
import os as _os

API_ID = int(_os.environ.get("TELETHON_API_ID", "0") or 0)
API_HASH = _os.environ.get("TELETHON_API_HASH", "") or ""
BOT_TOKEN = _os.environ.get("BOT_TOKEN", "") or ""
SESSION_STRING = _os.environ.get("TELETHON_SESSION_STRING", "") or ""
ADMIN_ID = int(_os.environ.get("OWNER_ID", "0") or 0)
DEFAULT_SWEEP_MINUTES = int(_os.environ.get("SCRAPE_SWEEP_MINUTES", "10") or 10)
# per-instance destination channel (set via the management sub-bot or env)
CHANNEL_ID = int(_os.environ.get("DEST_CHANNEL_ID", "0") or 0)
CHANNEL_USERNAME = _os.environ.get("DEST_CHANNEL_USERNAME", "") or ""
