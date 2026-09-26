# -*- coding: utf-8 -*-
"""ساخت پست کانال با برند @Config7x — مطابق قالب ربات پست‌ساز"""
import json

import config

# حافظه‌ی hash برای payload های بیشتر از ۲۵۶ کاراکتر (مثل _copy_all_store)
_copy_all_store = {}


def _btn(text, **kwargs):
    """ساخت دکمه با style در صورت پشتیبانی کتابخانه (patched) و بدون style در غیر این صورت"""
    try:
        from telebot.types import InlineKeyboardButton
        try:
            return InlineKeyboardButton(text=text, **kwargs)
        except TypeError:
            kwargs.pop("style", None)
            return InlineKeyboardButton(text=text, **kwargs)
    except ImportError:
        return None


def build_post(configs: list):
    """متن پست + کیبورد را می‌سازد. configs: [{'name','raw'},...]"""
    from telebot.types import InlineKeyboardMarkup, CopyTextButton

    channel_row_text = "🪅 Channel || @Config7x"

    if len(configs) == 1:
        c = configs[0]
        name = c["name"][:60] or c["protocol"].upper()
        text = (
            f"🚀 <b>{name}</b>\n\n"
            f"<blockquote>{c['raw']}</blockquote>\n\n"
            f"<blockquote>{channel_row_text}</blockquote>\n"
            f"📢 @Config7x"
        )
        kb = InlineKeyboardMarkup()
        kb.row(_btn("📋 کپی کردن کانفیگ", copy_text=CopyTextButton(text=c["raw"]), style="danger"))
        kb.row(_btn("📥 دریافت کانفیگ رایگان بیشتر", url=config.CHANNEL_LINK, style="primary"))
        return text, kb

    # چند کانفیگ — جدا شده با \n\n (سبک batch)
    joined = "\n\n".join(c["raw"] for c in configs)
    names = "\n".join(f"• <b>{c['name'][:50]}</b>" for c in configs[:10])
    text = (
        f"🚀 <b>{len(configs)} کانفیگ جدید</b>\n\n"
        f"{names}\n\n"
        f"<blockquote>{joined}</blockquote>\n\n"
        f"<blockquote>{channel_row_text}</blockquote>\n"
        f"📢 @Config7x"
    )
    kb = InlineKeyboardMarkup()
    if len(joined) <= 256:
        kb.row(_btn("📋 کپی همه کانفیگ‌ها", copy_text=CopyTextButton(text=joined), style="danger"))
    else:
        # hash store + تحویل داخلی با callback (پرچم سبز سبک قدیمی)
        h = str(abs(hash(joined)) % (10 ** 12))
        _copy_all_store[h] = [c["raw"] for c in configs]
        kb.row(_btn("📋 کپی همه کانفیگ‌ها", callback_data=f"cp:{h}", style="danger"))
    kb.row(_btn("📥 دریافت کانفیگ رایگان بیشتر", url=config.CHANNEL_LINK, style="primary"))
    return text, kb


def preview_text(source_title: str, msg_link: str, configs: list, limit=config.PREVIEW_LIMIT) -> str:
    """پیش‌نمایش برای ادمین قبل از انتشار"""
    lines = [f"🆕 <b>{len(configs)} کانفیگ جدید</b> پیدا شد", f"📡 منبع: <b>{source_title}</b>"]
    if msg_link:
        lines.append(f"🔗 <a href=\"{msg_link}\">پیام اصلی</a>")
    lines.append("")
    for c in configs[:limit]:
        lines.append(f"• <code>{c['name'][:40]}</code>")
    if len(configs) > limit:
        lines.append(f"و {len(configs) - limit} مورد دیگر...")
    return "\n".join(lines)
