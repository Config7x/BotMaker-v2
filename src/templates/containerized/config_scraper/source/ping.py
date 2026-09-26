# -*- coding: utf-8 -*-
"""
Ping — تست سلامت واقعی کانفیگ (TCP connect به host:port)
بر خلاف سورس‌های تقلبی، اگر سرور جواب ندهد «مرده» گزارش می‌شود، نه عدد تصادفی.
"""
import base64
import json
import re
import socket
import time
from concurrent.futures import ThreadPoolExecutor

TIMEOUT = 2.5          # ثانیه
MAX_WORKERS = 8


def extract_host_port(raw: str):
    """هاست و پورت را از کانفیگ استخراج می‌کند (اتصال واقعی به همان سرور)."""
    proto = raw.split("://", 1)[0].lower()
    try:
        if proto == "vmess":
            payload = raw.split("://", 1)[1]
            pad = "=" * (-len(payload) % 4)
            data = json.loads(base64.b64decode(payload + pad).decode("utf-8", "ignore"))
            return data.get("add"), int(data.get("port", 0))
        # vless/trojan/ss → بعد از @ تا : پورت تا / یا ?
        m = re.search(r"@([^:/?#]+):(\d+)", raw)
        if m:
            return m.group(1), int(m.group(2))
        return None, 0
    except Exception:
        return None, 0


def check(raw: str, timeout: float = TIMEOUT):
    """اتصال TCP واقعی؛ خروجی: (زنده؟, میلی‌ثانیه) — مرده = (False, -1)"""
    host, port = extract_host_port(raw)
    if not host or not port:
        return False, -1
    t0 = time.time()
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True, int((time.time() - t0) * 1000)
    except Exception:
        return False, -1


def check_many(configs: list):
    """پینگ موازی چند کانفیگ — آیتم 'ping_ms' به هر کانفیگ اضافه می‌شود.
    کانفیگ‌های مرده حذف و کانفیگ‌های زنده مرتب (سریع → کند) برگردانده می‌شوند."""
    if not configs:
        return []
    alive = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        results = list(ex.map(lambda c: check(c["raw"]), configs))
    for c, (ok, ms) in zip(configs, results):
        if ok:
            c["ping_ms"] = ms
            alive.append(c)
        else:
            c["ping_ms"] = -1
    alive.sort(key=lambda c: c["ping_ms"])
    return alive
