# -*- coding: utf-8 -*-
"""
Bot — داشبورد مدیریت @FreeConfig7xbot
منوی شیشه‌ای کامل: آمار، منابع، صف تایید، کانال هدف (اصلی/تست)،
انتشار خودکار و لینک پنل وب.
اجرا:  python3 bot.py
"""
import json
import re
import secrets
import threading
import time

import telebot
from telebot.types import InlineKeyboardMarkup, InlineKeyboardButton, CopyTextButton

import config
import db
import geo
import poster


def _btn(text, **kwargs):
    try:
        return InlineKeyboardButton(text=text, **kwargs)
    except TypeError:
        kwargs.pop("style", None)
        return InlineKeyboardButton(text=text, **kwargs)


bot = telebot.TeleBot(config.BOT_TOKEN, parse_mode="HTML")


OWNER_ID = config.ADMIN_ID   # فقط ادمین اصلی می‌تواند ادمین اضافه/حذف کند


def _seed_owner():
    try:
        db.add_admin(OWNER_ID, "owner")
    except Exception as e:
        print(f"[admin-seed] {e}")


def admin_only(handler):
    def wrapped(message, *a, **kw):
        if not db.is_admin(message.from_user.id):
            bot.reply_to(message, "⛔️ فقط ادمین مجاز است.")
            return
        return handler(message, *a, **kw)
    return wrapped


def owner_only(handler):
    def wrapped(message, *a, **kw):
        if message.from_user.id != OWNER_ID:
            bot.reply_to(message, "⛔️ فقط ادمین اصلی مجاز است.")
            return
        return handler(message, *a, **kw)
    return wrapped


# ---------- کانال هدف (اصلی/تست) ----------
def current_target() -> dict:
    if db.get_setting("test_mode", "0") == "1":
        raw = db.get_setting("test_channel")
        if raw:
            try:
                j = json.loads(raw)
                return j
            except Exception:
                pass
    return {"id": config.CHANNEL_ID, "username": config.CHANNEL_USERNAME,
            "link": config.CHANNEL_LINK, "label": "اصلی"}


def parse_channel_input(s: str):
    s = s.strip()
    m = re.match(r"(?:https?://)?(?:t\.me|telegram\.me)/([A-Za-z0-9_]+)", s)
    if s.startswith("@"):
        u = s.lstrip("@")
        if not re.fullmatch(r"[A-Za-z0-9_]+", u):
            return None
        return {"id": "@" + u, "username": "@" + u, "link": f"https://t.me/{u}", "label": "تست"}
    if m and not m.group(1).isdigit():
        u = m.group(1)
        return {"id": "@" + u, "username": "@" + u, "link": f"https://t.me/{u}", "label": "تست"}
    if re.fullmatch(r"-?\d{5,}", s):
        cid = s if s.startswith("-") else "-" + s
        return {"id": cid, "username": cid, "link": "", "label": "تست"}
    return None


def web_url() -> str:
    tok = db.get_setting("web_token")
    if not tok:
        tok = secrets.token_hex(8)
        db.set_setting("web_token", tok)
    u = db.get_setting("web_url")
    return u if u else f"http://SERVER_IP:8080/?token={tok}"


# ---------- ارسال به کانال ----------
def publish_pending(pid: int) -> tuple:
    p = db.get_pending(pid)
    if not p or p["status"] not in ("pending",):
        return (False, "پیدا نشد یا قبلاً پردازش شده")
    configs = json.loads(p["configs"])
    text, kb = poster.build_post(configs)
    tt = current_target()
    try:
        bot.send_message(tt["id"], text, reply_markup=kb,
                         disable_web_page_preview=True)
    except Exception as e:
        return (False, f"خطای ارسال به کانال: {e}")
    for c in configs:
        db.mark_posted(c["raw"], c.get("protocol", ""))
        try:
            host = geo.extract_host(c["raw"], c.get("protocol", ""))
            g = geo.resolve_country(host)
            db.add_recent(c.get("name", "")[:40], c.get("protocol", ""),
                          g["country_code"], g["country"], g["city"])
        except Exception as e:
            print(f"[geo] error: {e}")
    db.set_pending_status(pid, "posted")
    return (True, f"✅ پست #{pid} در {tt['username']} منتشر شد")


# ---------- منوها ----------
def _edit(cid, mid, text, kb):
    try:
        bot.edit_message_text(text, cid, mid, reply_markup=kb,
                              disable_web_page_preview=True)
        return
    except Exception:
        pass
    try:
        bot.send_message(cid, text, reply_markup=kb, disable_web_page_preview=True)
    except Exception:
        pass


def main_menu_text() -> str:
    s = db.stats()
    tt = current_target()
    test = db.get_setting("test_mode", "0") == "1"
    auto = db.get_setting("auto", "off")
    return (
        "🎛 <b>داشبورد مدیریت Auto-Scraper</b>\n"
        "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n"
        f"📊 کانفیگ منتشرشده: <b>{s['total']}</b> (۲۴س اخیر: {s['today']})\n"
        f"📡 منابع فعال: <b>{s['sources']}</b>   🕐 در صف تایید: <b>{s['pending']}</b>\n"
        f"🎯 کانال هدف: <b>{tt['username']}</b> "
        f"{'<i>(حالت تست 🧪)</i>' if test else '<i>(اصلی)</i>'}\n"
        f"⚙️ انتشار خودکار: <b>{'✅ روشن' if auto == 'on' else '⛔️ خاموش'}</b>\n"
        "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n"
        "👇 یکی از بخش‌ها را انتخاب کن"
    )


def main_menu_kb():
    kb = InlineKeyboardMarkup(row_width=2)
    kb.row(_btn("📊 آمار", callback_data="m:stats"),
           _btn("📡 منابع", callback_data="m:sources"))
    kb.row(_btn("➕ افزودن منبع", callback_data="m:addsrc"),
           _btn("🕐 صف تایید", callback_data="m:pending"))
    kb.row(_btn("🎯 کانال هدف", callback_data="m:target"),
           _btn("⚙️ انتشار خودکار", callback_data="m:auto"))
    kb.row(_btn("👥 ادمین‌ها", callback_data="m:admins"))
    kb.row(_btn("🩺 وضعیت سرویس‌ها", callback_data="m:services"))
    kb.row(_btn("🌐 پنل وب", callback_data="m:web"))
    return kb


def back_kb(row2=None):
    kb = InlineKeyboardMarkup(row_width=1)
    if row2:
        for r in row2:
            kb.row(*r)
    kb.row(_btn("🔙 بازگشت", callback_data="m:menu"))
    return kb


# ---------- روتر callback منو ----------
@bot.callback_query_handler(func=lambda c: c.data.startswith("m:"))
def cb_menu(cb):
    if not db.is_admin(cb.from_user.id):
        return bot.answer_callback_query(cb.id, "⛔️ فقط ادمین")
    action = cb.data[2:]
    cid, mid = cb.message.chat.id, cb.message.message_id

    if action == "menu":
        _edit(cid, mid, main_menu_text(), main_menu_kb())
        bot.answer_callback_query(cb.id)

    elif action == "stats":
        s = db.stats()
        txt = ("📊 <b>آمار Auto-Scraper</b>\n"
               "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n"
               f"• کل منتشرشده: <b>{s['total']}</b>\n"
               f"• ۲۴ ساعت اخیر: <b>{s['today']}</b>\n"
               f"• منابع: <b>{s['sources']}</b>\n"
               f"• در صف تایید: <b>{s['pending']}</b>")
        _edit(cid, mid, txt, back_kb())
        bot.answer_callback_query(cb.id)

    elif action == "sources":
        rows = db.list_sources()
        kb = InlineKeyboardMarkup(row_width=1)
        txt = "📡 <b>منابع رصد</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n"
        if not rows:
            txt += "\n📭 هنوز منبعی اضافه نشده.\n\n⚠️ اکانت رصد باید عضو کانال منبع باشد."
        for r in rows:
            st = "✅" if r["enabled"] else "⛔️"
            kb.row(_btn(f"{st} {r['identifier'][:30]} 🗑", callback_data=f"sdel:{r['id']}"))
            txt += f"{st} {r['identifier']}\n"
        kb.row(_btn("➕ افزودن منبع", callback_data="m:addsrc"))
        kb.row(_btn("🔙 بازگشت", callback_data="m:menu"))
        _edit(cid, mid, txt, kb)
        bot.answer_callback_query(cb.id)

    elif action == "addsrc":
        bot.answer_callback_query(cb.id, "✍️ منتظر یوزرنیم/لینک...")
        msg = bot.send_message(cid, "📤 یوزرنیم یا لینک کانال منبع را بفرست:\n\n"
                                    "<code>@channel_name</code> یا <code>https://t.me/channel_name</code>\n\n"
                                    "⚠️ اکانت رصد باید عضو آن کانال باشد.")
        bot.register_next_step_handler(msg, _step_add_source)

    elif action == "pending":
        rows = db.list_pending()
        kb = InlineKeyboardMarkup(row_width=1)
        txt = "🕐 <b>صف تایید</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n"
        if not rows:
            txt += "\n📭 صف خالی است."
        for r in rows[:12]:
            n = len(json.loads(r["configs"]))
            kb.row(_btn(f"👁 #{r['id']} • {n} کانفیگ • {r['source_title'][:18]}",
                        callback_data=f"pend:{r['id']}"))
            txt += f"• #{r['id']} — {n} کانفیگ از <b>{r['source_title']}</b>\n"
        kb.row(_btn("🔙 بازگشت", callback_data="m:menu"))
        _edit(cid, mid, txt, kb)
        bot.answer_callback_query(cb.id)

    elif action == "target":
        tt = current_target()
        test = db.get_setting("test_mode", "0") == "1"
        tc = db.get_setting("test_channel")
        txt = "🎯 <b>کانال هدف انتشار</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n"
        txt += f"حالت فعلی: <b>{'🧪 تست' if test else '🎯 اصلی'}</b>\n\n"
        txt += f"• کانال اصلی: <b>{config.CHANNEL_USERNAME}</b>\n"
        if tc:
            t = json.loads(tc)
            txt += f"• کانال تست: <b>{t['username']}</b>\n\n"
        else:
            txt += "• کانال تست: <i>تنظیم نشده</i>\n\n"
        txt += ("روی حالت <b>تست</b> همه پست‌ها به کانال تست می‌روند تا قالب را ببینی؛"
                " بعد از رضایت، روی <b>اصلی</b> برگرد.\n\n"
                "⚠️ ربات باید ادمینِ کانال تست هم باشد.")
        kb = InlineKeyboardMarkup(row_width=1)
        kb.row(_btn("🎯 سوییچ به کانال اصلی", callback_data="t:prod"))
        kb.row(_btn("🧪 سوییچ به کانال تست", callback_data="t:test"))
        kb.row(_btn("✏️ تنظیم/تغییر کانال تست", callback_data="t:settest"))
        kb.row(_btn("🔙 بازگشت", callback_data="m:menu"))
        _edit(cid, mid, txt, kb)
        bot.answer_callback_query(cb.id)

    elif action == "auto":
        cur = db.get_setting("auto", "off")
        txt = ("⚙️ <b>انتشار خودکار</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n"
               f"وضعیت فعلی: <b>{'✅ روشن' if cur == 'on' else '⛔️ خاموش'}</b>\n\n"
               "• روشن: کانفیگ‌های جدید بدون تاییدت مستقیم منتشر می‌شوند\n"
               "• خاموش: هر کانفیگ اول برایت می‌آید و با تاییدت منتشر می‌شود")
        kb = InlineKeyboardMarkup(row_width=1)
        kb.row(_btn("🔄 تغییر وضعیت", callback_data="auto:toggle"))
        kb.row(_btn("🔙 بازگشت", callback_data="m:menu"))
        _edit(cid, mid, txt, kb)
        bot.answer_callback_query(cb.id)

    elif action == "services":
        import subprocess
        def _svc(name):
            try:
                r = subprocess.run(["systemctl", "is-active", name],
                                   capture_output=True, text=True, timeout=5)
                return r.stdout.strip()
            except Exception:
                return "unknown"
        kb = InlineKeyboardMarkup(row_width=1)
        la = db.get_setting("last_activity")
        txt = "🩺 <b>وضعیت سرویس‌ها</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n"
        names = {"autoscraper-bot": "🤖 ربات مدیریت",
                 "autoscraper-scraper": "👀 یوزربات رصد",
                 "autoscraper-web": "🌐 پنل وب"}
        for svc, label in names.items():
            st = _svc(svc)
            icon = "🟢" if st == "active" else "🔴"
            txt += f"{icon} {label}: <b>{st}</b>\n"
            if svc != "autoscraper-bot":   # خودِ ربات از داخل خودش restart نمی‌شود
                kb.row(_btn(f"🔄 ری‌استارت {label}", callback_data=f"svcrst:{svc}"))
        txt += "\n"
        if la:
            ago = int(time.time()) - int(la)
            if ago < 60:
                t = "همین الان"
            elif ago < 3600:
                t = f"{ago // 60} دقیقه پیش"
            elif ago < 86400:
                t = f"{ago // 3600} ساعت پیش"
            else:
                t = f"{ago // 86400} روز پیش"
            txt += f"👁 آخرین کانفیگ رصدشده: <b>{t}</b>\n"
        kb.row(_btn("🔙 بازگشت", callback_data="m:menu"))
        _edit(cid, mid, txt, kb)
        bot.answer_callback_query(cb.id)

    elif action == "admins":
        rows = db.list_admins()
        kb = InlineKeyboardMarkup(row_width=1)
        txt = "👥 <b>ادمین‌های ربات</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n"
        for r in rows:
            mark = "👑" if r["user_id"] == OWNER_ID else "🛡"
            name = f" — {r['name']}" if r["name"] and r["name"] != "owner" else ""
            txt += f"{mark} <code>{r['user_id']}</code>{name}\n"
            if cb.from_user.id == OWNER_ID and r["user_id"] != OWNER_ID:
                kb.row(_btn(f"🗑 {r['user_id']}", callback_data=f"admdel:{r['user_id']}"))
        txt += "\n"
        if cb.from_user.id == OWNER_ID:
            kb.row(_btn("➕ افزودن ادمین", callback_data="adm:add"))
        else:
            txt += "➕ افزودن/حذف ادمین فقط توسط ادمین اصلی انجام می‌شود."
        kb.row(_btn("🔙 بازگشت", callback_data="m:menu"))
        _edit(cid, mid, txt, kb)
        bot.answer_callback_query(cb.id)

    elif action == "web":
        u = web_url()
        kb = InlineKeyboardMarkup(row_width=1)
        kb.row(_btn("🌐 باز کردن پنل", url=u))
        kb.row(_btn("🔙 بازگشت", callback_data="m:menu"))
        _edit(cid, mid, "🌐 <b>پنل وب Auto-Scraper</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n"
                        "وضعیت سرویس‌ها، منابع، صف تایید و آمار — با رفرش خودکار.\n\n"
                        f"<code>{u}</code>", kb)
        bot.answer_callback_query(cb.id)


# ---------- سایر callback ها ----------
@bot.callback_query_handler(func=lambda c: c.data.startswith("sdel:"))
def cb_source_del(cb):
    if not db.is_admin(cb.from_user.id):
        return bot.answer_callback_query(cb.id, "⛔️")
    sid = cb.data.split(":", 1)[1]
    rows = db.list_sources()
    for r in rows:
        if str(r["id"]) == sid:
            db.remove_source(r["identifier"])
            bot.answer_callback_query(cb.id, f"🗑 حذف شد: {r['identifier'][:30]}")
            # بازسازی لیست
            cb.data = "m:sources"
            cb_menu(cb)
            return
    bot.answer_callback_query(cb.id, "پیدا نشد")


@bot.callback_query_handler(func=lambda c: c.data.startswith("pend:"))
def cb_pending_detail(cb):
    if not db.is_admin(cb.from_user.id):
        return bot.answer_callback_query(cb.id, "⛔️")
    pid = int(cb.data.split(":", 1)[1])
    p = db.get_pending(pid)
    if not p or p["status"] != "pending":
        return bot.answer_callback_query(cb.id, "پیدا نشد یا پردازش شده")
    configs = json.loads(p["configs"])
    txt = poster.preview_text(p["source_title"], p["msg_link"], configs, limit=10)
    kb = InlineKeyboardMarkup(row_width=2)
    kb.row(_btn("✅ تایید و ارسال", callback_data=f"ap:{pid}"),
           _btn("❌ رد", callback_data=f"dn:{pid}"))
    kb.row(_btn("🔙 صف تایید", callback_data="m:pending"))
    try:
        bot.edit_message_text(txt, cb.message.chat.id, cb.message.message_id,
                              reply_markup=kb, disable_web_page_preview=True)
    except Exception:
        bot.send_message(cb.message.chat.id, txt, reply_markup=kb,
                         disable_web_page_preview=True)
    bot.answer_callback_query(cb.id)


@bot.callback_query_handler(func=lambda c: c.data.startswith("ap:"))
def cb_approve(cb):
    if not db.is_admin(cb.from_user.id):
        return bot.answer_callback_query(cb.id, "⛔️ فقط ادمین")
    pid = int(cb.data.split(":", 1)[1])
    ok, msg = publish_pending(pid)
    if ok:
        new_kb = InlineKeyboardMarkup()
        new_kb.row(InlineKeyboardButton("✅ منتشر شد", callback_data="noop"))
        try:
            bot.edit_message_reply_markup(cb.message.chat.id, cb.message.message_id, reply_markup=new_kb)
        except Exception:
            pass
    bot.answer_callback_query(cb.id, msg, show_alert=not ok)


@bot.callback_query_handler(func=lambda c: c.data.startswith("dn:"))
def cb_deny(cb):
    if not db.is_admin(cb.from_user.id):
        return bot.answer_callback_query(cb.id, "⛔️ فقط ادمین")
    pid = int(cb.data.split(":", 1)[1])
    db.set_pending_status(pid, "denied")
    bot.answer_callback_query(cb.id, f"🚫 پست #{pid} رد شد")


@bot.callback_query_handler(func=lambda c: c.data.startswith("cp:"))
def cb_copy_all(cb):
    h = cb.data.split(":", 1)[1]
    configs = poster._copy_all_store.get(h)
    if not configs:
        bot.answer_callback_query(cb.id, "⏳ مهلت کپی تمام شده — از پست اصلی کپی کنید", show_alert=True)
        return
    bot.answer_callback_query(cb.id, "📨 در حال ارسال...")
    buf = ""
    for raw in configs:
        if len(buf) + len(raw) + 2 > 3800 and buf:
            bot.send_message(cb.from_user.id, f"<blockquote>{buf}</blockquote>")
            buf = ""
        buf += ("\n\n" if buf else "") + raw
    if buf:
        bot.send_message(cb.from_user.id, f"<blockquote>{buf}</blockquote>")


@bot.callback_query_handler(func=lambda c: c.data == "noop")
def cb_noop(cb):
    bot.answer_callback_query(cb.id)


# ---------- ری‌استارت سرویس‌ها از راه دور ----------
@bot.callback_query_handler(func=lambda c: c.data.startswith("svcrst:"))
def cb_svc_restart(cb):
    if not db.is_admin(cb.from_user.id):
        return bot.answer_callback_query(cb.id, "⛔️ فقط ادمین")
    import subprocess
    svc = cb.data.split(":", 1)[1]
    if svc not in ("autoscraper-scraper", "autoscraper-web"):
        return bot.answer_callback_query(cb.id, "⛔️ مجاز نیست")
    bot.answer_callback_query(cb.id, "🔄 در حال ری‌استارت...")
    try:
        subprocess.run(["systemctl", "restart", svc], timeout=30,
                       check=True, capture_output=True)
        bot.send_message(cb.message.chat.id, f"✅ <b>{svc}</b> با موفقیت ری‌استارت شد.")
    except Exception as e:
        bot.send_message(cb.message.chat.id, f"⚠️ ری‌استارت ناموفق: <code>{e}</code>")
    cb.data = "m:services"
    cb_menu(cb)


# ---------- مدیریت ادمین‌ها (فقط ادمین اصلی) ----------
@bot.callback_query_handler(func=lambda c: c.data in ("adm:add",) or c.data.startswith("admdel:"))
def cb_admin_mgmt(cb):
    if cb.from_user.id != OWNER_ID:
        return bot.answer_callback_query(cb.id, "⛔️ فقط ادمین اصلی", show_alert=True)
    if cb.data == "adm:add":
        bot.answer_callback_query(cb.id, "✍️ منتظر اطلاعات...")
        msg = bot.send_message(cb.message.chat.id,
                               "📤 یکی از این‌ها را بفرست:\n\n"
                               "• آیدی عددی: <code>123456789</code>\n"
                               "• یوزرنیم: <code>@username</code>\n"
                               "• یا یه پیام از طرف خودش را فوروارد کن")
        bot.register_next_step_handler(msg, _step_add_admin)
    else:
        uid = int(cb.data.split(":", 1)[1])
        db.remove_admin(uid)
        bot.answer_callback_query(cb.id, f"🗑 حذف شد: {uid}")
        cb.data = "m:admins"
        cb_menu(cb)


def _step_add_admin(message):
    if message.from_user.id != OWNER_ID:
        return
    uid, name = None, ""
    # 1) فوروارد از طرف خود شخص
    fwd = message.forward_from
    if fwd:
        uid = fwd.id
        name = (getattr(fwd, "first_name", "") or "").strip()
    # 2) آیدی عددی
    elif message.text and message.text.strip().lstrip("-").isdigit():
        uid = int(message.text.strip())
    # 3) یوزرنیم → resolve با Bot API
    elif message.text and message.text.strip().startswith("@"):
        try:
            chat = bot.get_chat(message.text.strip())
            uid = chat.id
            name = (chat.first_name or "").strip()
        except Exception:
            bot.reply_to(message, "⚠️ یوزرنیم پیدا نشد — یا ایدی عددی بده یا پیامی از طرفش فوروارد کن.")
            return
    else:
        bot.reply_to(message, "⚠️ فرمت درست نیست.")
        return
    if uid:
        added = db.add_admin(uid, name)
        mark = "✅ ادمین جدید اضافه شد" if added else "ℹ️ از قبل ادمین بود"
        bot.reply_to(message, f"{mark}:\n🛡 <code>{uid}</code>" +
                     (f" — {name}" if name else ""))


# ---------- کانال هدف: callback ها ----------
@bot.callback_query_handler(func=lambda c: c.data in ("t:prod", "t:test", "t:settest"))
def cb_target(cb):
    if not db.is_admin(cb.from_user.id):
        return bot.answer_callback_query(cb.id, "⛔️")
    action = cb.data
    if action == "t:prod":
        db.set_setting("test_mode", "0")
        bot.answer_callback_query(cb.id, "🎯 حالت اصلی فعال شد")
        cb.data = "m:target"
        cb_menu(cb)
    elif action == "t:test":
        if not db.get_setting("test_channel"):
            return bot.answer_callback_query(cb.id, "اول کانال تست را تنظیم کن", show_alert=True)
        db.set_setting("test_mode", "1")
        bot.answer_callback_query(cb.id, "🧪 حالت تست فعال شد")
        cb.data = "m:target"
        cb_menu(cb)
    else:  # t:settest
        bot.answer_callback_query(cb.id, "✍️ منتظر کانال...")
        msg = bot.send_message(cb.message.chat.id,
                               "📤 کانال تست را بفرست: <code>@username</code> یا لینکش\n\n"
                               "⚠️ ربات @FreeConfig7xbot باید ادمین آن کانال باشد.")
        bot.register_next_step_handler(msg, _step_set_test_channel)


@bot.callback_query_handler(func=lambda c: c.data == "auto:toggle")
def cb_auto_toggle(cb):
    if not db.is_admin(cb.from_user.id):
        return bot.answer_callback_query(cb.id, "⛔️")
    cur = db.get_setting("auto", "off")
    db.set_setting("auto", "off" if cur == "on" else "on")
    bot.answer_callback_query(cb.id, "✅ تغییر کرد")
    cb.data = "m:auto"
    cb_menu(cb)


# ---------- مراحل ورودی (next steps) ----------
def _step_add_source(message):
    if not db.is_admin(message.from_user.id):
        return
    ident = message.text.strip()
    if not (ident.startswith("@") or "t.me/" in ident or ident.startswith("-")):
        bot.reply_to(message, "⚠️ فرمت درست نیست. مثال: <code>@channel_name</code>")
        return
    db.add_source(ident)
    bot.reply_to(message, f"✅ منبع <b>{ident}</b> اضافه شد.\n\n"
                          "⚠️ اکانت رصد باید عضو آن کانال باشد.")


def _step_set_test_channel(message):
    if not db.is_admin(message.from_user.id):
        return
    t = parse_channel_input(message.text)
    if not t:
        bot.reply_to(message, "⚠️ نتونستم بخونمش. مثال: <code>@test_channel</code>")
        return
    db.set_setting("test_channel", json.dumps(t, ensure_ascii=False))
    db.set_setting("test_mode", "1")
    bot.reply_to(message, f"🧪 کانال تست: <b>{t['username']}</b>\n\n"
                          f"حالت تست <b>فعال</b> شد — از این به بعد همه پست‌ها آنجا می‌روند.\n"
                          "وقتی راضی شدی، از منوی 🎯 کانال هدف برگرد روی اصلی.")


# ---------- دستورات ----------
@bot.message_handler(commands=["start", "menu", "help"])
@admin_only
def cmd_start(message):
    bot.reply_to(message, main_menu_text(), reply_markup=main_menu_kb())


@bot.message_handler(commands=["panel"])
@admin_only
def cmd_panel(message):
    u = web_url()
    kb = InlineKeyboardMarkup()
    kb.row(_btn("🌐 باز کردن پنل", url=u))
    bot.reply_to(message, "🌐 پنل وب Auto-Scraper:", reply_markup=kb)


@bot.message_handler(commands=["add"])
@admin_only
def cmd_add(message):
    ident = " ".join(message.text.split()[1:]).strip()
    if not ident:
        msg = bot.reply_to(message, "🔎 فرمت: <code>/add @channel_name</code>\n\n"
                                    "یا از منوی 📡 منابع ➕ افزودن منبع استفاده کن.")
        bot.register_next_step_handler(msg, _step_add_source)
        return
    db.add_source(ident)
    bot.reply_to(message, f"✅ منبع <b>{ident}</b> اضافه شد (اکانت رصد باید عضوش باشه).")


@bot.message_handler(commands=["sources"])
@admin_only
def cmd_sources(message):
    bot.reply_to(message, main_menu_text(), reply_markup=main_menu_kb())
    rows = db.list_sources()
    if not rows:
        bot.send_message(message.chat.id, "📭 هنوز منبعی اضافه نشده.")
        return
    lines = ["📡 <b>منابع رصد:</b>\n"]
    for r in rows:
        lines.append(f"{'✅' if r['enabled'] else '⛔️'} {r['id']}. {r['identifier']}")
    bot.send_message(message.chat.id, "\n".join(lines))


@bot.message_handler(commands=["del"])
@admin_only
def cmd_del(message):
    ident = " ".join(message.text.split()[1:]).strip()
    if not ident:
        bot.reply_to(message, "فرمت: /del شماره (یا از منوی 📡 منابع دکمه 🗑 را بزن)")
        return
    rows = db.list_sources()
    for r in rows:
        if str(r["id"]) == ident:
            db.remove_source(r["identifier"])
            bot.reply_to(message, f"🗑 حذف شد: {r['identifier']}")
            return
    db.remove_source(ident)
    bot.reply_to(message, f"🗑 حذف شد (در صورت وجود): {ident}")


@bot.message_handler(commands=["pending"])
@admin_only
def cmd_pending(message):
    rows = db.list_pending()
    kb = InlineKeyboardMarkup(row_width=1)
    if not rows:
        bot.reply_to(message, "📭 صف تایید خالیه.")
        return
    for r in rows[:12]:
        n = len(json.loads(r["configs"]))
        kb.row(_btn(f"👁 #{r['id']} • {n} کانفیگ • {r['source_title'][:18]}",
                    callback_data=f"pend:{r['id']}"))
    kb.row(_btn("🔙 منو", callback_data="m:menu"))
    bot.reply_to(message, "🕐 <b>صف تایید:</b> — برای دیدن جزئیات بزن 👇", reply_markup=kb)


@bot.message_handler(commands=["stats"])
@admin_only
def cmd_stats(message):
    s = db.stats()
    bot.reply_to(message,
                 f"📊 <b>آمار Auto-Scraper</b>\n\n"
                 f"• کل منتشر شده: <b>{s['total']}</b>\n"
                 f"• ۲۴ ساعت اخیر: <b>{s['today']}</b>\n"
                 f"• منابع فعال: <b>{s['sources']}</b>\n"
                 f"• در صف تایید: <b>{s['pending']}</b>")


@bot.message_handler(commands=["auto"])
@admin_only
def cmd_auto(message):
    arg = message.text.split()[1].lower() if len(message.text.split()) > 1 else ""
    if arg not in ("on", "off"):
        cur = db.get_setting("auto", "off")
        bot.reply_to(message, f"وضعیت فعلی: <b>{cur}</b>\nفرمت: /auto on یا /auto off")
        return
    db.set_setting("auto", arg)
    bot.reply_to(message, f"⚙️ انتشار خودکار: <b>{'روشن ✅' if arg == 'on' else 'خاموش ⛔️'}</b>")


@bot.message_handler(commands=["test"])
@admin_only
def cmd_test(message):
    """میان‌بر: سوییچ سریع بین کانال اصلی و تست"""
    arg = message.text.split()[1] if len(message.text.split()) > 1 else ""
    if arg == "on":
        if not db.get_setting("test_channel"):
            msg = bot.reply_to(message, "🧪 کانال تست را بفرست: <code>@username</code>")
            bot.register_next_step_handler(msg, _step_set_test_channel)
            return
        db.set_setting("test_mode", "1")
        t = json.loads(db.get_setting("test_channel"))
        bot.reply_to(message, f"🧪 حالت تست فعال — پست‌ها به <b>{t['username']}</b> می‌روند")
    elif arg == "off":
        db.set_setting("test_mode", "0")
        bot.reply_to(message, "🎯 حالت اصلی فعال — پست‌ها به کانال اصلی می‌روند")
    else:
        test = db.get_setting("test_mode", "0") == "1"
        bot.reply_to(message, f"حالت فعلی: <b>{'🧪 تست' if test else '🎯 اصلی'}</b>\n"
                              "فرمت: <code>/test on</code> یا <code>/test off</code>")


# ---------- انتشار خودکار (وقتی auto=on) ----------
def auto_publisher():
    while True:
        try:
            if db.get_setting("auto", "off") == "on":
                for p in db.list_pending()[:5]:
                    ok, msg = publish_pending(p["id"])
                    print(f"[auto] #{p['id']}: {msg}")
                    time.sleep(3)
        except Exception as e:
            print(f"[auto] error: {e}")
        time.sleep(5)


if __name__ == "__main__":
    _seed_owner()
    threading.Thread(target=auto_publisher, daemon=True).start()
    print("🤖 Management bot (@FreeConfig7xbot) polling...")
    bot.infinity_polling(skip_pending=True)
