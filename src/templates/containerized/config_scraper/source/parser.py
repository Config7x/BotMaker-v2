# -*- coding: utf-8 -*-
"""
موتور پارس کانفیگ — روش خط‌به‌خط اصلی
Regex ها با lookbehind assertion نوشته شدن تا 'ss://' داخل
'vless://' و 'vmess://' به اشتباه match نشه (باگ قدیمی mutation پروتکل).
"""
import base64
import json
import re
from urllib.parse import unquote

_PROTOCOLS = ["vless", "vmess", "trojan", "ss", "ssr", "hysteria2", "hy2", "tuic"]

# هر پروتکل داخل (?i:...) با lookbehind (?<![A-Za-z0-9]):
# در 'vless://' کاراکتر قبل از 'ss' حرف است، پس match نمی‌شود؛
# ولی ' ss://' در وسط متن یا ابتدای خط به درستی match می‌شود.
_PATTERN = "|".join(
    '(?i:(?<![A-Za-z0-9])%s://[^\\s<>"\']+)' % p for p in _PROTOCOLS
)
LINE_RE = re.compile("(" + _PATTERN + ")")


def _name_of(raw: str) -> str:
    """استخراج اسم کانفیگ (fragment بعد از # یا ps داخل base64 وMess)"""
    proto = raw.split("://", 1)[0].lower()
    if proto == "vmess":
        try:
            payload = raw.split("://", 1)[1]
            pad = "=" * (-len(payload) % 4)
            data = json.loads(base64.b64decode(payload + pad).decode("utf-8", "ignore"))
            return (data.get("ps") or data.get("add") or "VMess").strip()
        except Exception:
            return "VMess"
    if "#" in raw:
        name = unquote(raw.split("#", 1)[1]).strip()
        if name:
            return name
    return proto.upper()


def parse_configs(text: str):
    """روش خط‌به‌خط: هر خط جداگانه چک می‌شود و کانفیگ‌ها با lookbehind استخراج می‌شوند."""
    found = []
    if not text:
        return found
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        for m in LINE_RE.finditer(line):
            raw = m.group(1).rstrip(".,;:)]}")
            if "://" not in raw or len(raw) < 10:
                continue
            found.append({
                "protocol": raw.split("://", 1)[0].lower(),
                "name": _name_of(raw),
                "raw": raw,
            })
    # حذف تکراری داخل یک پیام
    seen, out = set(), []
    for c in found:
        if c["raw"] not in seen:
            seen.add(c["raw"])
            out.append(c)
    return out
