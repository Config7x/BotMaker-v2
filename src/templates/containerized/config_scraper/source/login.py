# -*- coding: utf-8 -*-
"""
ساخت سشن اکانت رصد (شماره دوم) — فقط یک بار اجرا می‌شود:
    python3 login.py
شماره اکانت رصد را می‌پرسد، کد تلگرام را می‌پرسد، سشن ذخیره می‌شود.
"""
import config
from telethon import TelegramClient

client = TelegramClient(config.SESSION_NAME, config.API_ID, config.API_HASH)
client.start()  # شماره + کد را تعاملی می‌پرسد
me = client.get_me()
print(f"\n✅ سشن ساخته شد: {config.SESSION_NAME}.session")
print(f"اکانت: {getattr(me, 'first_name', '')} (@{getattr(me, 'username', '-')})")
print("حالا می‌توانی scraper.py را اجرا کنی.")
client.disconnect()

# ==== BotMaker v2: session string from SESSION_STRING env (non-interactive mode) ====
if __name__ == "__main__" and os.environ.get("TELETHON_SESSION_STRING"):
    from telethon.sessions import StringSession
    client = TelegramClient(StringSession(os.environ["TELETHON_SESSION_STRING"]),
                            API_ID, API_HASH)
    client.connect()
    me = client.get_me()
    print(f"✅ session valid: {getattr(me, 'first_name', '')} (@{getattr(me, 'username', '-')})")
    client.disconnect()
