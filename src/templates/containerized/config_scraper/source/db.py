# -*- coding: utf-8 -*-
"""دیتابیس SQLite پروژه Auto-Scraper (کاملاً جدا از ربات پست‌ساز)"""
import hashlib
import json
import re
import sqlite3
import threading
import time

import config

_lock = threading.Lock()
_conn = None


def _connect():
    global _conn
    _conn = sqlite3.connect(config.DB_FILE, check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL")
    _conn.executescript("""
    CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identifier TEXT UNIQUE NOT NULL,   -- @username یا t.me/xxx یا -100... id
        title TEXT DEFAULT '',
        enabled INTEGER DEFAULT 1,
        added_date TEXT
    );
    CREATE TABLE IF NOT EXISTS posted (
        config_hash TEXT PRIMARY KEY,
        config_raw TEXT,
        protocol TEXT DEFAULT '',
        posted_date TEXT
    );
    CREATE TABLE IF NOT EXISTS pending (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_title TEXT,
        msg_link TEXT DEFAULT '',
        configs TEXT NOT NULL,             -- json list
        status TEXT DEFAULT 'pending',    -- pending/approved/denied/posted
        created TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS admins (
        user_id INTEGER PRIMARY KEY,
        name TEXT DEFAULT '',
        added_date TEXT
    );
    CREATE TABLE IF NOT EXISTS recent (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT, protocol TEXT,
        country_code TEXT, country TEXT, city TEXT,
        posted_date TEXT
    );
    CREATE TABLE IF NOT EXISTS geo_cache (
        host TEXT PRIMARY KEY,
        country_code TEXT, country TEXT, city TEXT,
        resolved_date TEXT
    );
    """)
    # مهاجرت ملایم برای دیتابیس‌های قدیمی‌تر که ستون protocol را ندارند
    try:
        _conn.execute("ALTER TABLE posted ADD COLUMN protocol TEXT DEFAULT ''")
    except sqlite3.OperationalError:
        pass
    _conn.commit()


def get_conn():
    if _conn is None:
        with _lock:
            if _conn is None:
                _connect()
    return _conn


def config_hash(raw: str) -> str:
    return hashlib.sha256(raw.strip().encode("utf-8")).hexdigest()


# ---------- sources ----------
def normalize_identifier(identifier: str) -> list:
    """همه فرمت‌های معادل یک منبع را تولید می‌کند:
    https://t.me/x , t.me/x , @x , telegram.me/x → همه به @x تبدیل می‌شوند"""
    ident = identifier.strip().lower().rstrip("/")
    out = {ident}
    m = re.search(r"(?:t\.me|telegram\.me)/([A-Za-z0-9_]+)", ident)
    if m:
        out.add("@" + m.group(1))
    # id عددی: هم فرمت -100xxxx و هم -xxxx ذخیره می‌شود
    if re.fullmatch(r"-?\d{5,}", ident):
        digits = ident.lstrip("-")
        if digits.startswith("100"):
            out.add("-" + digits)
        else:
            out.add("-100" + digits)
    return [i for i in out if i]


def add_source(identifier: str, title: str = ""):
    c = get_conn()
    with _lock:
        for ident in normalize_identifier(identifier):
            c.execute("INSERT OR IGNORE INTO sources(identifier, title, added_date) VALUES(?,?,?)",
                      (ident, title, str(int(time.time()))))
        c.commit()
    return list_sources()


def remove_source(identifier: str):
    c = get_conn()
    with _lock:
        c.execute("DELETE FROM sources WHERE identifier=?", (identifier.lower(),))
        c.commit()


def list_sources():
    c = get_conn()
    rows = c.execute("SELECT * FROM sources ORDER BY id").fetchall()
    return [dict(r) for r in rows]


def is_source(identifiers) -> bool:
    """identifiers: list[str] — همه فرمت‌های معرف چت نرمال و چک می‌شوند"""
    if not identifiers:
        return False
    c = get_conn()
    ids = set()
    for i in identifiers:
        if i:
            ids.update(normalize_identifier(i))
    if not ids:
        return False
    q = ",".join("?" * len(ids))
    row = c.execute(f"SELECT 1 FROM sources WHERE identifier IN ({q}) AND enabled=1",
                   sorted(ids)).fetchone()
    return row is not None


# ---------- posted (dedup + آنالیز پروتکل) ----------
def already_posted(raw: str) -> bool:
    c = get_conn()
    row = c.execute("SELECT 1 FROM posted WHERE config_hash=?", (config_hash(raw),)).fetchone()
    return row is not None


def mark_posted(raw: str, protocol: str = ""):
    c = get_conn()
    with _lock:
        c.execute("INSERT OR IGNORE INTO posted(config_hash, config_raw, protocol, posted_date) VALUES(?,?,?,?)",
                  (config_hash(raw), raw, protocol, str(int(time.time()))))
        c.commit()


def protocol_distribution() -> list:
    """[{'protocol':'vless','count':598}, ...] مرتب‌شده نزولی"""
    c = get_conn()
    rows = c.execute(
        "SELECT COALESCE(NULLIF(protocol,''),'نامشخص') AS p, COUNT(*) AS n "
        "FROM posted GROUP BY p ORDER BY n DESC").fetchall()
    return [{"protocol": r["p"], "count": r["n"]} for r in rows]


# ---------- recent (کارت‌های کانفیگ داغ) ----------
def add_recent(name: str, protocol: str, country_code: str, country: str, city: str):
    c = get_conn()
    with _lock:
        c.execute("INSERT INTO recent(name, protocol, country_code, country, city, posted_date) "
                  "VALUES(?,?,?,?,?,?)",
                  (name, protocol, country_code, country, city, str(int(time.time()))))
        # فقط ۱۰۰ مورد آخر نگه داشته می‌شود
        c.execute("DELETE FROM recent WHERE id NOT IN "
                  "(SELECT id FROM recent ORDER BY id DESC LIMIT 100)")
        c.commit()


def list_recent(limit: int = 8) -> list:
    c = get_conn()
    rows = c.execute("SELECT * FROM recent ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


# ---------- geo cache ----------
def geo_cache_get(host: str):
    c = get_conn()
    row = c.execute("SELECT * FROM geo_cache WHERE host=?", (host.lower(),)).fetchone()
    return dict(row) if row else None


def geo_cache_set(host: str, country_code: str, country: str, city: str):
    c = get_conn()
    with _lock:
        c.execute("INSERT OR REPLACE INTO geo_cache(host, country_code, country, city, resolved_date) "
                  "VALUES(?,?,?,?,?)",
                  (host.lower(), country_code, country, city, str(int(time.time()))))
        c.commit()


# ---------- pending ----------
def add_pending(source_title: str, msg_link: str, configs: list) -> int:
    c = get_conn()
    with _lock:
        cur = c.execute(
            "INSERT INTO pending(source_title, msg_link, configs, created) VALUES(?,?,?,?)",
            (source_title, msg_link, json.dumps(configs, ensure_ascii=False), str(int(time.time()))))
        c.commit()
        return cur.lastrowid


def get_pending(pid: int):
    c = get_conn()
    row = c.execute("SELECT * FROM pending WHERE id=?", (pid,)).fetchone()
    return dict(row) if row else None


def set_pending_status(pid: int, status: str):
    c = get_conn()
    with _lock:
        c.execute("UPDATE pending SET status=? WHERE id=?", (status, pid))
        c.commit()


def list_pending():
    c = get_conn()
    rows = c.execute("SELECT * FROM pending WHERE status='pending' ORDER BY id").fetchall()
    return [dict(r) for r in rows]


# ---------- settings ----------
def get_setting(key: str, default=None):
    c = get_conn()
    row = c.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value: str):
    c = get_conn()
    with _lock:
        c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?,?)", (key, value))
        c.commit()


# ---------- پاکسازی خودکار ----------
def purge_old_pending(days: int = 14) -> int:
    cutoff = str(int(time.time()) - days * 86400)
    c = get_conn()
    with _lock:
        cur = c.execute("DELETE FROM pending WHERE created < ? AND status = 'pending'", (cutoff,))
        c.commit()
        return cur.rowcount


# ---------- admins ----------
def list_admins() -> list:
    c = get_conn()
    rows = c.execute("SELECT * FROM admins ORDER BY user_id").fetchall()
    return [dict(r) for r in rows]


def add_admin(user_id: int, name: str = "") -> bool:
    c = get_conn()
    with _lock:
        cur = c.execute("INSERT OR IGNORE INTO admins(user_id, name, added_date) VALUES(?,?,?)",
                        (int(user_id), name, str(int(time.time()))))
        c.commit()
        return cur.rowcount > 0


def remove_admin(user_id: int) -> bool:
    c = get_conn()
    with _lock:
        cur = c.execute("DELETE FROM admins WHERE user_id=?", (int(user_id),))
        c.commit()
        return cur.rowcount > 0


def is_admin(user_id) -> bool:
    try:
        uid = int(user_id)
    except (TypeError, ValueError):
        return False
    c = get_conn()
    row = c.execute("SELECT 1 FROM admins WHERE user_id=?", (uid,)).fetchone()
    return row is not None


# ---------- stats ----------
def stats():
    c = get_conn()
    total_posted = c.execute("SELECT COUNT(*) FROM posted").fetchone()[0]
    today = c.execute(
        "SELECT COUNT(*) FROM posted WHERE posted_date >= ?", (str(int(time.time()) - 86400),)).fetchone()[0]
    n_sources = c.execute("SELECT COUNT(*) FROM sources").fetchone()[0]
    n_pending = c.execute("SELECT COUNT(*) FROM pending WHERE status='pending'").fetchone()[0]
    return {"total": total_posted, "today": today, "sources": n_sources, "pending": n_pending}
