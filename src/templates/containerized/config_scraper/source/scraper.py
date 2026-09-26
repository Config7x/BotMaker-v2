# -*- coding: utf-8 -*-
"""
Scraper — یوزربات Telethon (اکانت رصد، شماره دوم)
کانال‌های منبع رو ۲۴/۷ مواظبه، به محض انتشار کانفیگ →
ذخیره در pending + اطلاع به ادمین با دکمه تایید/رد (از طریق Bot API).
اجرا:  python3 scraper.py   (بعد از ساخت سشن با login.py)
"""
import json
import time

import requests
from telethon import TelegramClient, events

import config
import db
import parser
import poster


def _bot_api(method: str, payload: dict):
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{config.BOT_TOKEN}/{method}",
            json=payload, timeout=15)
        if not r.json().get("ok"):
            print(f"[bot-api] {method} failed: {r.text[:200]}")
    except Exception as e:
        print(f"[bot-api] {method} error: {e}")


def _notify_admins(pid: int, source_title: str, msg_link: str, configs: list):
    text = poster.preview_text(source_title, msg_link, configs)
    kb = {"inline_keyboard": [
        [{"text": "✅ تایید و ارسال", "callback_data": f"ap:{pid}"},
         {"text": "❌ رد", "callback_data": f"dn:{pid}"}]
    ]}
    targets = [config.ADMIN_ID]
    try:
        targets += [a["user_id"] for a in db.list_admins() if a["user_id"] != config.ADMIN_ID]
    except Exception as e:
        print(f"[notify] list_admins error: {e}")
    for uid in dict.fromkeys(targets):   # بدون تکرار
        _bot_api("sendMessage", {
            "chat_id": uid, "text": text,
            "parse_mode": "HTML", "reply_markup": kb, "disable_web_page_preview": True,
        })


def _identifiers_of_chat(chat) -> list:
    ids = []
    if chat is None:
        return ids
    if getattr(chat, "username", None):
        ids.append("@" + chat.username)
        ids.append(f"t.me/{chat.username}")
        ids.append(f"https://t.me/{chat.username}")
    ids.append(str(getattr(chat, "id", "")))
    # کانال‌ها در Telethon id منفی -100xxxx دارند؛ حالت با/بدون -100 هم ذخیره می‌شود
    cid = getattr(chat, "id", None)
    if cid:
        s = str(cid)
        if s.startswith("-100"):
            ids.append("-" + s[4:])  # -xxxx قدیمی
        else:
            ids.append("-100" + s.lstrip("-"))
    return ids


def _notify_started():
    targets = [config.ADMIN_ID]
    try:
        targets += [a["user_id"] for a in db.list_admins() if a["user_id"] != config.ADMIN_ID]
    except Exception:
        pass
    for uid in dict.fromkeys(targets):
        _bot_api("sendMessage", {
            "chat_id": uid,
            "text": "🟢 یوزربات رصد آنلاین شد و کانال‌های منبع رو مواظبه می‌کنه.",
        })


client = TelegramClient(config.SESSION_NAME, config.API_ID, config.API_HASH,
                        catch_up=True)   # بازیابی پیام‌های ازدست‌رفته هنگام قطعی


@client.on(events.NewMessage())
async def on_new_message(event):
    try:
        chat = await event.get_chat()
        identifiers = _identifiers_of_chat(chat)
        if not db.is_source(identifiers):
            return

        text = event.message.message or ""
        configs = parser.parse_configs(text)
        if not configs:
            return

        # فیلتر کانفیگ‌های تکراری (قبلاً پست شده)
        fresh = [c for c in configs if not db.already_posted(c["raw"])]
        if not fresh:
            print(f"[skip] {len(configs)} کانفیگ تکراری از {getattr(chat, 'title', '?')}")
            return

        db.set_setting("last_activity", str(int(time.time())))
        title = getattr(chat, "title", None) or getattr(chat, "username", None) or str(event.chat_id)
        msg_link = f"https://t.me/{getattr(chat, 'username', 'c/' + str(event.chat_id).replace('-100', ''))}/{event.message.id}"
        pid = db.add_pending(title, msg_link, fresh)
        _notify_admins(pid, title, msg_link, fresh)
        print(f"[new] {len(fresh)} کانفیگ از «{title}» → pending #{pid}")
    except Exception as e:
        print(f"[error] on_new_message: {e}")


if __name__ == "__main__":
    print("🤖 Auto-Scraper userbot starting...")
    # پاکسازی صف تایید قدیمی‌تر از ۱۴ روز
    purged = db.purge_old_pending(14)
    if purged:
        print(f"[purge] {purged} pending قدیمی حذف شد")
    while True:
        try:
            with client:
                me = client.loop.run_until_complete(client.get_me())
                print(f"✅ Logged in as {getattr(me, 'first_name', '?')} (@{getattr(me, 'username', '-')})")
                db.set_setting("scraper_started_at", str(int(time.time())))
                _notify_started()
                print("👀 Watching source channels...")
                client.run_until_disconnected()
            print("[watchdog] disconnected — reconnecting in 10s...")
        except Exception as e:
            print(f"[watchdog] error: {e} — reconnecting in 30s...")
            time.sleep(30)
            continue
        time.sleep(10)
