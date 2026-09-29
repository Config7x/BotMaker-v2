# BotMaker v2

پلتفرم چندمستأجری (Multi-tenant) ساخت و مدیریت ربات تلگرام با Node.js 20، Express و SQLite. کاربر نهایی از طریق یک **ربات کنترل**، ربات خودش را می‌سازد و مدیریت می‌کند.

> **نسخه فعلی: v2.1.0** — ۹۷ تست پروژه با موفقیت عبور می‌کنند. برای اجرای تست‌ها از `npm test` استفاده کنید.

## قابلیت‌ها و معماری

- ربات کنترل مبتنی بر **وب‌هوک** (تضمین عدم خطای 409 تلگرام) + وب‌سرور Express برای وب‌هوک ربات‌های کاربران، health check و اندپوینت هشدار امنیتی داخلی.
- معماری ماژولار «بلوکی»: هر زیرسیستم یک ماژول مستقل با رابط مشخص است (`db`, `admin`, `webhook`, `telegram`, `wallet`, `support`, `lifecycle`, `templateManager`, `containerized`, `provisioner`, `telethon`, `monitoring`).
- مدیریت قالب‌ها به‌صورت پویا با `src/templateManager.js`؛ قالب‌های ZIP قابل نصب توسط ادمین.
- SQLite با `better-sqlite3`، مهاجرت idempotent و رمزنگاری توکن‌ها با **AES-256-GCM**.
- کیف پول، پلن‌های اشتراک (Free/Pro/VIP)، تمدید خودکار و چرخه عمر اشتراک.
- سیستم تیکتینگ پشتیبانی.
- دکمه‌های شیشه‌ای **رنگی** (success / danger / primary) در رابط تلگرام.
- قالب Custom Source (لابراتوار خصوصی) با اسکن امنیتی هوش مصنوعی، تأیید ادمین و اجرای ایزوله؛ **FAIL-CLOSED** بدون gVisor.

## قالب‌ها

**۱۱ قالب درون‌پروسه** (وب‌هوک پلتفرم): فروشگاه، آپلود فایل، پست‌ساز، مدیریت کانال، کوییز، دانلودر، پست‌ساز جامع، دانلودر چندپلتفرمه، دانلودر موزیک، موزیک‌یاب اینستاگرام، دانلودر ویدیو.

**۲ قالب کانتینری Pro/VIP** (کانتینر Docker اختصاصی با gVisor برای هر ربات):

| # | قالب | توضیح |
|---|------|-------|
| 10 | VPN Shop | فروش اشتراک VPN با اتصال به پنل شما (Marzban/Pasarguard/WGDashboard/Remnawave/x-ui)، مینی‌اپ تلگرام، MySQL و کرون تمدید داخل کانتینر اختصاصی |
| 11 | Config Auto-Scraper | رصد خودکار کانال‌های منبع برای کانفیگ VPN و انتشار موارد تأییدشده با سشن Telethon اکانت خودتان |

هر دو قالب فقط برای پلن‌های **Pro / VIP** در دسترس‌اند (بدون دمو). قالب #11 پیش از شروع ویزارد، هشدار رسمی ریسک محدودیت اکانت شخصی تلگرام را نمایش می‌دهد.

## نصب روی Ubuntu (idempotent)

```bash
git clone https://github.com/Config7x/BotMaker-v2.git
cd BotMaker-v2
sudo bash install.sh
```

اسکریپت Node.js 20 و وابستگی‌ها را نصب می‌کند، `.env` را به‌صورت تعاملی می‌سازد، سرویس systemd را تنظیم می‌کند و در صورت وجود Docker + gVisor، ایمیج‌های قالب‌های کانتینری را build می‌کند. اجرای مجدد آن بی‌خطر است.

## پیکربندی محیطی

مقادیر در `.env` (نمونه: `.env.example`):

- `CONTROL_BOT_TOKEN` — توکن ربات کنترل از BotFather
- `ENCRYPTION_KEY` — کلید رمزنگاری (حداقل ۳۲ کاراکتر، توصیه: `openssl rand -hex 32`)
- `PUBLIC_BASE_URL` — آدرس HTTPS عمومی سرور
- `ADMIN_ID` — شناسه عددی تلگرام مالک پلتفرم
- `ADMIN_ONLY` — `false` برای سرویس چندکاربره
- `TELETHON_API_ID` / `TELETHON_API_HASH` — فقط برای قالب #11 (از my.telegram.org)
- `INTERNAL_ALERT_SECRET` — راز مشترک اندپوینت هشدار امنیتی

## Docker و gVisor

قالب‌های کانتینری و Custom Source هر نمونه را در کانتینر Docker خودش با `--runtime=runsc` (gVisor)، `cap-drop=ALL`، `no-new-privileges`، روت‌فایل read-only و محدودیت منابع اجرا می‌کنند. بدون gVisor، این ویژگی‌ها **FAIL-CLOSED** هستند.

## اجرای توسعه‌ای (Docker / پیش‌نمایش Base44)

```bash
docker compose -f docker-compose.base44.yml up -d
curl http://localhost:3000/health   # {"status":"ok",...}
```

این محیط با `MOCK_TELEGRAM=true` و مقادیر placeholder بوت می‌شود (فایل `.env.base44-defaults`)؛ رازهای واقعی از `/run/base44/app.env` تزریق و اولویت دارند. جزئیات در `AGENTS.md`.

## عملیات روزمره

```bash
sudo systemctl status botmaker-v2   # وضعیت سرویس
sudo journalctl -u botmaker-v2 -f   # لاگ زنده
curl http://127.0.0.1:3000/health  # health check
npm test                            # اجرای ۹۷ تست
```

## امنیت

- رمزنگاری توکن‌ها در دیتابیس با AES-256-GCM
- سکرت‌توکن اختصاصی برای وب‌هوک هر ربات + هدر `X-Telegram-Bot-Api-Secret-Token`
- اجرای کد کاربر در سندباکس gVisor ایزوله با کانتینر اختصاصی هر ربات
- اسکن امنیتی هوش مصنوعی + تأیید دستی ادمین برای Custom Source
- گزارش کامل: `SECURITY-REVIEW.md`

## مجوز

MIT — فایل `LICENSE`.
