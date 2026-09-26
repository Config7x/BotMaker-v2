# -*- coding: utf-8 -*-
"""
تشخیص هاست کانفیگ + کشور/شهر (Geo-IP) برای کارت‌های «کانفیگ داغ» و آنالیز پروتکل.
از ipwho.is استفاده می‌شود (رایگان، HTTPS، بدون کلید) با کش دائمی در دیتابیس.
"""
import base64
import json
import re
from urllib.parse import urlsplit

import requests

import db

_IP_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")


def extract_host(raw: str, protocol: str):
    protocol = (protocol or "").lower()
    if protocol == "vmess":
        try:
            payload = raw.split("://", 1)[1]
            pad = "=" * (-len(payload) % 4)
            data = json.loads(base64.b64decode(payload + pad).decode("utf-8", "ignore"))
            return data.get("add")
        except Exception:
            return None
    try:
        u = urlsplit(raw)
        return u.hostname
    except Exception:
        return None


def flag_emoji(country_code: str) -> str:
    if not country_code or len(country_code) != 2 or not country_code.isalpha():
        return "🏳️"
    cc = country_code.upper()
    return "".join(chr(0x1F1E6 + ord(ch) - ord("A")) for ch in cc)


def resolve_country(host: str, timeout: int = 4) -> dict:
    """برمی‌گرداند: {country_code, country, city} — با کش دیتابیس"""
    unknown = {"country_code": "", "country": "نامشخص", "city": ""}
    if not host:
        return unknown
    host = host.strip().lower()
    cached = db.geo_cache_get(host)
    if cached:
        return {"country_code": cached["country_code"], "country": cached["country"], "city": cached["city"]}
    try:
        r = requests.get(f"https://ipwho.is/{host}", timeout=timeout)
        j = r.json()
        if j.get("success", True) is False:
            db.geo_cache_set(host, "", "نامشخص", "")
            return unknown
        cc = (j.get("country_code") or "").upper()
        country = j.get("country") or "نامشخص"
        city = j.get("city") or ""
        db.geo_cache_set(host, cc, country, city)
        return {"country_code": cc, "country": country, "city": city}
    except Exception:
        return unknown
