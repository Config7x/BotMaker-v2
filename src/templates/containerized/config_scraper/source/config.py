import os

# ==== Telegram API (اکانت رصد - شماره دوم) ====
API_ID = 0  # REDACTED - set your own Telegram API_ID from my.telegram.org
API_HASH = "REDACTED_SET_YOUR_OWN_API_HASH"

# ==== ربات مدیریت (BotFather) ====
# توکن رو اینجا بذار یا از متغیر محیطی بخونه
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN_8", "")  # REDACTED - real token removed, set via env var

# ==== ادمین و کانال ====
ADMIN_ID = 7886358210
CHANNEL_ID = -1003651016772          # @Config7x
CHANNEL_USERNAME = "@Config7x"
CHANNEL_LINK = "https://t.me/Config7x"

# ==== فایل‌ها (داخل data/ تا با ولوم داکر پایدار بمانند) ====
import os as _os
_os.makedirs("data", exist_ok=True)
SESSION_NAME = "data/scraper_session"   # سشن اکانت رصد (userbot)
DB_FILE = "data/autoscraper.db"

# ==== تنظیمات ====
PREVIEW_LIMIT = 5                   # حداکثر کانفیگ نمایشی در پیش‌نمایش ادمین

DEFAULT_SWEEP_MINUTES = 10

# ==== BotMaker v2 platform override (env-driven — see shims/platform_config.py) ====
try:
    from shims.platform_config import *  # noqa: F401,F403  (platform-managed values)
except ImportError:
    pass
