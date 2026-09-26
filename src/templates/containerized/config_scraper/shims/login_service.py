# -*- coding: utf-8 -*-
"""
BotMaker v2 — Config Auto-Scraper (template #11) session login service.

Runs INSIDE the container (same image as the scraper) and exposes a tiny
HTTP API on 127.0.0.1 for the platform's creation wizard:

    POST /start     {"phone": "+98..."}   -> {"ok":true,"need":"code","key":...}
    POST /code      {"code": "12345"}      -> {"ok":true,"need":"session"}
                                             or {"ok":true,"need":"password"}
    POST /password  {"password": "..."}   -> {"ok":true,"need":"session"}
    POST /session   {}                     -> {"ok":true,"session":"<string>"}

The session string is handed back ONCE and the platform stores it
AES-256-GCM encrypted. The helper container is destroyed right after.

Per reference-source security note: API_ID/API_HASH/BOT_TOKEN come fresh
from environment variables — never hardcoded.
"""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

from telethon import TelegramClient
from telethon.sessions import StringSession

API_ID = int(os.environ.get("TELETHON_API_ID", "0"))
API_HASH = os.environ.get("TELETHON_API_HASH", "")
assert API_ID and API_HASH, "TELETHON_API_ID / TELETHON_API_HASH must be set"

STATE = {}  # single in-flight login per helper container


def client():
    return TelegramClient(StringSession(), API_ID, API_HASH)


class Handler(BaseHTTPRequestHandler):
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        data = json.loads(self.rfile.read(length) or b"{}")
        try:
            if self.path == "/start":
                cl = client()
                cl.connect()
                r = cl.send_code_request(data["phone"])
                STATE["client"] = cl
                STATE["phone"] = data["phone"]
                STATE["code_hash"] = r.phone_code_hash
                return self._json({"ok": True, "need": "code"})
            if self.path == "/code":
                cl = STATE["client"]
                try:
                    cl.sign_in(STATE["phone"], data["code"], phone_code_hash=STATE["code_hash"])
                except Exception as e:
                    if "Password" in type(e).__name__ or "SessionPasswordNeeded" in str(type(e)):
                        STATE["need_password"] = True
                        return self._json({"ok": True, "need": "password"})
                    raise
                s = StringSession.save(cl.session)
                STATE["session"] = s
                return self._json({"ok": True, "need": "session"})
            if self.path == "/password":
                cl = STATE["client"]
                cl.sign_in(password=data["password"])
                s = StringSession.save(cl.session)
                STATE["session"] = s
                return self._json({"ok": True, "need": "session"})
            if self.path == "/session":
                return self._json({"ok": True, "session": STATE.get("session", "")})
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "error": str(e)}, 400)
        return self._json({"ok": False, "error": "not found"}, 404)

    def log_message(self, *a):  # silence request logs (no secrets to stdout)
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", int(os.environ.get("LOGIN_SERVICE_PORT", "8731"))), Handler).serve_forever()
