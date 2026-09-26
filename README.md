# BotMaker v2

[![Node.js 20](https://img.shields.io/badge/Node.js-20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-17%20passing-brightgreen)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Database: SQLite](https://img.shields.io/badge/DB-SQLite%20(better--sqlite3)-003B57?logo=sqlite&logoColor=white)](#)
[![Telegram](https://img.shields.io/badge/Telegram-Bot%20API-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![Persian](https://img.shields.io/badge/lang-%D9%81%D8%A7%D8%B1%D8%B3%DB%8C-red)](#)

پلتفرم چند-مستأجری (multi-tenant) ساخت ربات تلگرام — کاملاً فارسی. کاربر نهایی فقط با یک «ربات کنترل» در تلگرام گفتگو می‌کند و بدون حتی یک خط کدنویسی، ربات خود را می‌سازد، پولی می‌کند و مدیریت می‌کند. اجرا روی یک VPS لینوکسی تکی با Node.js 20 و SQLite.

> تمام منطق کسب‌وکار تست‌شده است: `node --test test/` — ۱۷ تست شامل کیف پول، چرخه دقیق دمو با ساعت تزریقی (بدون sleep واقعی)، اقدامات پنل ربات، جریان FAQ-ثم-تیکت پشتیبانی و گیت‌های سرویس سورس سفارشی.

## معماری

```
src/
├── index.js        نقطه ورود: وب‌سرور + حلقه getUpdates ربات کنترل + زمان‌بند چرخه عمر
├── config.js       خواندن .env و اعتبارسنجی
├── db.js           SQLite (better-sqlite3): اسکیما + مهاجرت idempotent + CRUD
├── cryptoutil.js   رمزنگاری AES-256-GCM توکن‌ها (توکن خام هرگز ذخیره/لاگ نمی‌شود)
├── telegram.js     کلاینت HTTP بوت API با حالت MOCK برای تست‌ها
├── webhook.js      دیسپچر مرکزی Express + اندپوینت هشدار امنیتی داخلی
├── admin.js        ربات کنترل: منوها، جریان ساخت ربات، پنل‌ها، کنسول مدیریت
├── wallet.js       کیف پول: شارژ، کسر، خرید/تمدید، تمدید خودکار
├── lifecycle.js    چرخه دمو ۶۰ دقیقه (هشدار ۵۰ → grace ۶۰ → حذف ۳۶۰)
├── support.js      FAQ-first سپس تیکت
├── customsource.js گیت پرداخت، اعتبارسنجی، اسکن امنیتی→باگ، تأیید ادمین، sandbox، Falco
├── clock.js        ساعت تزریقی (تست‌ها بدون زمان واقعی)
├── utils/          escapeHtml + محافظت SSRF
└── templates/      رجیستری ایستای ۱۱ قالب: ۹ قالب سبک درون-پروسه + ۲ قالب کانتینری (§3.10-11)
```

### ۹ قالب
Shop/کاتالوگ • آپلودر فایل (۲۰/۵۰MB صادقانه) • پست‌ساز (رنگ دکمه فقط ایموجی 🔴🟢🔵🟡⚪) • مدیر کانال (بدون ادعای مدیریت بن) • کوئیز (امتیاز + لیدربورد) • دانلودر HTTPS مستقیم • **پست‌ساز جامع** (پارس خط‌به‌خط چندکانفیگ، کپی بومی CopyTextButton با سقف ۲۵۶ کاراکتر و فروش هش برای payloads بلند، ارسال ovpn/conf بدون پارس، برندینگ بلاک‌کوت، پیش‌نمایش + تأیید) • **دانلودر چندپلتفرمه** (Instagram/TikTok/YouTube/SoundCloud/Twitter، منوی کیفیت مطابق سورس اصلی multidl، SSRF) • **دانلودر موزیک** (جستجو، force-join، علاقه‌مندی، دستورات مالک — پورت سورس اصلی music_bot)

### ۲ قالب کانتینری (Pro/VIP only — بدون دمو)
• **#۱۰ فروشگاه اشتراک VPN** (PHP + MySQL داخل کانتینر، مینی‌اپ تلگرام، کرون تمدید) — ویزارد ساخت: نوع پنل (Marzban/PasarGuard/WGDashboard/Remnawave/x-ui) → آدرس پنل → کاربر → رمز (AES-256-GCM). مبتنی بر فورک باز-متن GPL-3.0 پروژه Faoxima (LICENSE + NOTICE.md حفظ شده).
• **#۱۱ اسکرپر و پستر خودکار کانفیگ** (Python + Telethon) — اول افشای ریسک مسدودی اکانت شخصی (باید صریحاً بپذیرید)، سپس لاگین شماره → OTP → رمز دوم اختیاری؛ رشته سشن رمزنگاری‌شده ذخیره می‌شود؛ کانال‌های منبع از پنل قابل افزودن/حذف‌اند.

هر نمونه ربات کانتینری در **کانتینر اختصاصی خودش** با همان پشته امنیتی سورس سفارشی اجرا می‌شود (gVisor/runsc + cap-drop=ALL + no-new-privileges + read-only rootfs + ولوم دیتا + محدودیت منابع)، اما **بدون** اسکن هوش مصنوعی/تأیید ادمین چون سورس ثابت و بازبینی‌شده است. بدون gVisor راه‌اندازی fail-closed است. این ربات‌ها از وب‌هوک پلتفرم استفاده نمی‌کنند؛ توقف/فعال‌سازی یعنی stop/start کانتینر و حذف یعنی نابود کانتینر + ولوم دیتا.

## چرخه دمو (دقیقاً طبق مشخصات)
- دقیقه ۵۰: هشدار یک‌باره
- دقیقه ۶۰: حالت grace (حذف وب‌هوک، داده سالم) + اطلاع ۳۰۰ دقیقه‌ای
- دقیقه ۳۶۰ بدون ارتقا: حذف دائمی + اطلاع نهایی
- ارتقا در هر پنجره → فعال‌سازی فوری روی پلن پرداختی
- هر نوع قالب فقط **یک بار** دمو برای هر کاربر (بقیه قالب‌ها همچنان واجد شرایط)

## نصب روی Ubuntu VPS (تکی و idempotent)

```bash
sudo bash install.sh
nano /opt/botmaker-v2/.env     # مقادیر را پر کنید
sudo systemctl restart botmaker-v2
```

نصب‌کننده Node 20، وابستگی‌ها و سرویس systemd را می‌سازد؛ اگر Docker و gVisor (`runsc`) موجود باشد `GVISOR_AVAILABLE=true` می‌گذارد و **ایمیج دو قالب کانتینری را هم می‌سازد** (`botmaker/vpn_shop` و `botmaker/config_scraper`)؛ در غیر این صورت اجرای سورس سفارشی و قالب‌های کانتینری **fail-closed** باقی می‌مانند. برای قالب #۱۱ مقادیر `TELETHON_API_ID` و `TELETHON_API_HASH` را از my.telegram.org در `.env` بگذارید (هرگز از کپی رفرنس).

### متغیرهای محیطی (`.env.example`)
`CONTROL_BOT_TOKEN` (ربات کنترل از BotFather) • `ENCRYPTION_KEY` (۶۴ hex توصیه: `openssl rand -hex 32`) • `PUBLIC_URL` (دامنه/آی‌پی عمومی) • `PORT` • `DB_PATH` • `OWNER_TELEGRAM_ID` (مالک پلتفرم) • `SECURITY_ALERT_SECRET` (Falco) • `CUSTOM_SOURCE_PRICE` • `GVISOR_AVAILABLE`

### مدیریت سرویس
```bash
systemctl status botmaker-v2
journalctl -u botmaker-v2 -f
curl http://localhost:8443/healthz
```
تکی‌بودن پروسه با lock-file تضمین می‌شود (خطای 409 تلگرام از دو instance رخ نمی‌دهد).

## سورس سفارشی (§6، پرمیوم)
ترتیب اجباری: **گیت پرداخت →** اعتبارسنجی ساختار (سقف ZIP/فایل/نسبت، manifest) → **اسکن امنیتی** (الگوهای استاتیک + بازبینی AI) → اسکن باگ (فقط برای گذرنده‌های امنیتی) → **تأیید انسانی ادمین** → اجرا فقط در کانتینر hardened با gVisor:
`--runtime=runsc --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges --user 1000:1000` + سقف CPU/RAM/PID.
خطای زمان اجرا: source-caused → به کاربر برای اصلاح خودش؛ host-caused → فقط با تأیید کاربر و fix بدون پیامد امنیتی خودکار؛ هر fix با پیامد امنیتی → escalation مستقیم به مالک. هشدار Falco با راز مشترک → kill + پاک‌سازی سورس + علامت‌گذاری + اطلاع دوطرفه.

## امنیت
- توکن‌های BotFather فقط رمزنگاری‌شده AES-256-GCM ذخیره می‌شوند؛ هرگز لاگ نمی‌شوند
- تمام متن‌های کاربر قبل از ارسال با `parse_mode:HTML` → escape می‌شوند
- `style` دکمه‌ها فقط `primary` (پاک‌سازی خودکار؛ success/destructive خطای 400 می‌دهد)
- بدون eval/Function/کد داینامیک در موتور قالب؛ رجیستری کاملاً ایستا
- SSRF: بلاک شبکه‌های خصوصی + DNS-pinning هنگام دانلود
- محدودیت‌های حجمی صادقانه (۲۰MB دانلود / ۵۰MB ارجاع Bot API)

## تست
```bash
npm test   # node --test test/  (17 تست)
```

## نکات عملیاتی
- شارژ کیف پول فعلاً دستی/کریپتویی است: کاربر درخواست مبلغ می‌دهد، ادمین از کنسول تأیید می‌کند (مبنای آماده برای اتصال درگاه کریپتویی)
- تمدید خودکار: موجودی کافی → تمدید بی‌صدا + اطلاع؛ ناکافی → توقف + دلیل با کمبود دقیق
- بدون gVisor، پروژه‌های سفارشی اجرا نمی‌شوند (این رفتار عمدی است)


## راه‌اندازی سریع

```bash
cp .env.example .env   # توکن ربات کنترل و کلیدها را پر کنید
npm install
npm start               # یا: bash install.sh
npm test                # اجرای ۱۷ تست
```

نیازمندی‌ها: Node.js ≥ 20، لینوکس (به دلیل Docker/gVisor برای قالب‌های کانتینری).
