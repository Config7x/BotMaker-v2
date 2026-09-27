# BotMaker v2

پلتفرم چندمستأجری ساخت و مدیریت ربات تلگرام با Node.js، Express و SQLite. کاربر نهایی از طریق یک **ربات کنترل**، ربات خودش را می‌سازد و مدیریت می‌کند.

> **وضعیت فعلی:** ۲۸ تست پروژه با موفقیت عبور می‌کنند. برای اجرای تست‌ها از `npm test` استفاده کنید؛ این دستور به‌صورت مستقیم فایل‌های `test/*.test.js` را اجرا می‌کند.

## فهرست مطالب

- [قابلیت‌ها و معماری](#قابلیت‌ها-و-معماری)
- [پیش‌نیازها](#پیش‌نیازها)
- [اجرای توسعه‌ای](#اجرای-توسعه‌ای)
- [استقرار روی Ubuntu با systemd](#استقرار-روی-ubuntu-با-systemd)
- [پیکربندی محیطی](#پیکربندی-محیطی)
- [دامنه، TLS و وب‌هوک](#دامنه-tls-و-وبهوک)
- [Docker و gVisor](#docker-و-gvisor)
- [عملیات روزمره](#عملیات-روزمره)
- [مانیتورینگ و Health Check](#مانیتورینگ-و-health-check)
- [به‌روزرسانی و rollback](#بهروزرسانی-و-rollback)
- [بکاپ و بازیابی](#بکاپ-و-بازیابی)
- [عیب‌یابی](#عیبیابی)
- [امنیت](#امنیت)

## قابلیت‌ها و معماری

- ربات کنترل با long polling؛ فقط **یک نمونهٔ فعال** مجاز است تا خطای Telegram 409 رخ ندهد.
- وب‌سرور Express برای health check، وب‌هوک ربات‌ها و هشدار امنیتی داخلی.
- SQLite با `better-sqlite3` و مهاجرت idempotent.
- رمزنگاری توکن‌ها با AES-256-GCM.
- چرخهٔ دمو: هشدار دقیقهٔ ۵۰، ورود به grace در دقیقهٔ ۶۰ و انقضا در دقیقهٔ ۳۶۰.
- قالب‌های درون‌پروسه و قالب‌های کانتینری Pro/VIP.
- اجرای سورس سفارشی فقط با gVisor و به‌صورت fail-closed.
- محافظت SSRF برای دانلودهای HTTP/HTTPS و escape کردن متن‌های HTML.

ساختار مهم پروژه:

```text
src/index.js                         نقطهٔ ورود
src/config.js                        بارگذاری و اعتبارسنجی .env
src/db.js                            SQLite، schema و عملیات داده
src/admin.js                         ربات کنترل و پنل مدیریت
src/webhook.js                       Express، healthz و webhook
src/lifecycle.js                     چرخهٔ دمو و تمدید خودکار
src/customsource.js                  گیت پرداخت و اسکن سورس سفارشی
src/templates/                       رجیستری قالب‌ها
src/templates/containerized/         سورس قالب‌های کانتینری
src/utils/                           ابزار HTML و SSRF
test/                                تست‌های پروژه
install.sh                           نصب Ubuntu و سرویس systemd
.env.example                         نمونهٔ پیکربندی
```

## پیش‌نیازها

### توسعه و تست

- Node.js **20 یا بالاتر**
- npm
- Python و ابزارهای build در صورت نبودن binary آمادهٔ `better-sqlite3`

### استقرار تولیدی

- Ubuntu 22.04 یا 24.04
- دسترسی `sudo`
- حداقل ۱ گیگابایت RAM؛ برای قالب‌های کانتینری و build ایمیج‌ها RAM بیشتری توصیه می‌شود.
- دامنه یا زیردامنه با رکورد A به IP سرور
- توکن ربات کنترل از [@BotFather](https://t.me/BotFather)
- TLS معتبر برای استفادهٔ تولیدی از وب‌هوک‌ها

## اجرای توسعه‌ای

```bash
git clone https://github.com/Config7x/BotMaker-v2.git
cd BotMaker-v2

cp .env.example .env
openssl rand -hex 32
# مقدار تولیدشده را در ENCRYPTION_KEY قرار دهید.
# CONTROL_BOT_TOKEN، OWNER_TELEGRAM_ID و SECURITY_ALERT_SECRET را نیز پر کنید.

npm install
npm test
```

برای اجرای محلی، `PUBLIC_URL` را روی آدرس قابل‌دسترسی تنظیم کنید. اگر فقط تست واحد انجام می‌دهید، لازم نیست به Telegram واقعی متصل شوید. هرگز توکن واقعی یا کلید رمزنگاری را commit نکنید.

اجرای برنامه:

```bash
npm start
# یا:
node src/index.js
```

در حالت توسعه، قبل از اجرا باید `.env` کامل باشد؛ در غیر این صورت برنامه عمداً متوقف می‌شود.

## استقرار روی Ubuntu با systemd

### ۱. دریافت کد و نصب

```bash
sudo apt update
sudo apt install -y git curl build-essential python3

git clone https://github.com/Config7x/BotMaker-v2.git /opt/botmaker-v2-src
cd /opt/botmaker-v2-src
sudo bash install.sh
```

`install.sh` این کارها را انجام می‌دهد:

1. Node.js 20 یا نسخهٔ جدیدتر را بررسی/نصب می‌کند.
2. کد را در `/opt/botmaker-v2` کپی می‌کند و `.env` موجود را حفظ می‌کند.
3. دایرکتوری‌های `data/` و `custom_sources/` را می‌سازد.
4. وابستگی‌های npm را نصب می‌کند.
5. در صورت وجود Docker و gVisor، ایمیج‌های قالب‌های کانتینری را build می‌کند.
6. سرویس `botmaker-v2.service` را در systemd ثبت می‌کند.

در اجرای معمولی، نصب‌کننده بعد از کپی فایل‌ها یک wizard تعاملی نشان می‌دهد و این موارد را **یکی‌یکی** می‌پرسد: توکن ربات کنترل، آدرس عمومی، شناسه مالک، تنظیم کلید رمزنگاری، فعال‌سازی metrics و در صورت نیاز APIهای Telethon. کلیدهای `ENCRYPTION_KEY`، `SECURITY_ALERT_SECRET` و `METRICS_TOKEN` می‌توانند خودکار با `openssl` ساخته شوند و در ترمینال نمایش داده نمی‌شوند. مقادیر غیرخالی قبلی در اجرای دوباره حفظ می‌شوند.

برای نصب بدون پرسش (CI یا cloud-init):

```bash
sudo NONINTERACTIVE=1 bash install.sh
```

در حالت بدون پرسش، قبل از اجرا باید `.env` را از قبل آماده کرده باشید؛ نصب‌کننده آن را تکمیل نمی‌کند.

### ۲. ساخت و تکمیل `.env`

اگر فایل وجود نداشته باشد، نصب‌کننده آن را از `.env.example` می‌سازد. ابتدا آن را تکمیل کنید:

```bash
sudo nano /opt/botmaker-v2/.env
sudo chmod 600 /opt/botmaker-v2/.env
```

حداقل مقادیر لازم در بخش [پیکربندی محیطی](#پیکربندی-محیطی) توضیح داده شده‌اند.

### ۳. فعال‌سازی سرویس و health check

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now botmaker-v2
sudo systemctl status botmaker-v2 --no-pager
curl -fsS http://127.0.0.1:8443/healthz
```

پاسخ سالم مشابه زیر است:

```json
{"ok":true,"status":"alive","service":"botmaker-v2","version":"2.0.0","uptime_seconds":42,"timestamp":"2026-09-27T12:00:00.000Z"}
```

مشاهدهٔ لاگ:

```bash
sudo journalctl -u botmaker-v2 -f
```

اگر `.env` ناقص باشد، سرویس را فعال نکنید؛ ابتدا خطاهای چاپ‌شده را برطرف کنید.

## پیکربندی محیطی

فایل مرجع: `.env.example`

| متغیر | اجباری | توضیح |
|---|---:|---|
| `CONTROL_BOT_TOKEN` | بله | توکن ربات کنترل از BotFather |
| `OWNER_TELEGRAM_ID` | بله | شناسهٔ عددی مالک برای کنسول مدیریت |
| `ENCRYPTION_KEY` | بله | کلید AES؛ مقدار پیشنهادی `openssl rand -hex 32` |
| `PUBLIC_URL` | بله | آدرس عمومی، مانند `https://bots.example.com` |
| `PORT` | خیر | پورت داخلی Express؛ پیش‌فرض `8443` |
| `DB_PATH` | خیر | مسیر SQLite؛ پیش‌فرض `./data/botmaker.db` |
| `SECURITY_ALERT_SECRET` | بله | راز مشترک هشدارهای امنیتی |
| `METRICS_TOKEN` | توصیه‌شده | توکن endpoint خصوصی Prometheus؛ اگر خالی باشد `/metrics` غیرفعال است |
| `CUSTOM_SOURCE_PRICE` | خیر | قیمت سرویس سورس سفارشی به تومان |
| `CUSTOM_SOURCES_DIR` | خیر | محل نگهداری سورس‌های سفارشی |
| `GVISOR_AVAILABLE` | خیر | فقط پس از نصب و شناسایی `runsc` روی `true` قرار گیرد |
| `MOCK_TELEGRAM` | خیر | فقط برای تست؛ در تولید `false` باشد |
| `TELETHON_API_ID` | فقط قالب اسکرپر | API ID اختصاصی از `my.telegram.org` |
| `TELETHON_API_HASH` | فقط قالب اسکرپر | API Hash اختصاصی؛ در Git یا چت عمومی قرار نگیرد |

تولید مقادیر تصادفی:

```bash
openssl rand -hex 32   # ENCRYPTION_KEY
openssl rand -hex 32   # SECURITY_ALERT_SECRET
```

**هشدار:** تغییر `ENCRYPTION_KEY` بعد از ذخیرهٔ توکن‌های کاربران، رمزگشایی داده‌های قبلی را ممکن نمی‌کند. قبل از تغییر آن، برنامه و روش migration کلید را طراحی کنید.

## دامنه، TLS و وب‌هوک

برنامه به‌طور معمول روی `127.0.0.1:8443` اجرا می‌شود و بهتر است TLS در reverse proxy terminate شود. نمونهٔ سادهٔ Nginx:

```nginx
server {
    listen 80;
    server_name bots.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name bots.example.com;

    ssl_certificate     /etc/letsencrypt/live/bots.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bots.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8443;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
```

مراحل پیشنهادی:

1. رکورد DNS را ایجاد کنید.
2. گواهی TLS را با Certbot یا Caddy بگیرید.
3. `PUBLIC_URL=https://bots.example.com` را در `.env` قرار دهید.
4. سرویس را restart کنید.
5. health check و لاگ را بررسی کنید.

```bash
sudo systemctl restart botmaker-v2
curl -fsS https://bots.example.com/healthz
```

وب‌هوک ربات‌های معمولی توسط برنامه روی مسیر `/webhook/:secretToken` مدیریت می‌شود و هدر secret تلگرام را بررسی می‌کند. قالب‌های کانتینری مسیر وب‌هوک خودشان را دارند و از dispatcher درون‌پروسه استفاده نمی‌کنند.

## Docker و gVisor

Docker و gVisor برای موارد زیر ضروری‌اند:

- اجرای سورس سفارشی
- قالب VPN Shop
- قالب Config Scraper

بدون `runsc`، رفتار برنامه **fail-closed** است و provision انجام نمی‌شود. بعد از نصب Docker و gVisor، بررسی کنید:

```bash
docker info --format '{{json .Runtimes}}' | grep runsc
```

سپس نصب‌کننده را دوباره اجرا کنید تا ایمیج‌ها build و وضعیت `.env` به‌روزرسانی شود:

```bash
cd /opt/botmaker-v2-src
sudo bash install.sh
sudo systemctl restart botmaker-v2
```

قالب Config Scraper به `TELETHON_API_ID` و `TELETHON_API_HASH` اختصاصی نیاز دارد. احراز هویت حساب شخصی تلگرام ریسک محدودیت دارد و باید قبل از ورود، هشدار داخل ویزارد را صریحاً بپذیرید.

## عملیات روزمره

```bash
# وضعیت سرویس
sudo systemctl status botmaker-v2 --no-pager

# شروع، توقف و restart
sudo systemctl start botmaker-v2
sudo systemctl stop botmaker-v2
sudo systemctl restart botmaker-v2

# لاگ زنده و لاگ‌های اخیر
sudo journalctl -u botmaker-v2 -f
sudo journalctl -u botmaker-v2 -n 200 --no-pager

# health check محلی
curl -fsS http://127.0.0.1:8443/healthz

# بررسی فضای دیسک
sudo du -sh /opt/botmaker-v2/data /opt/botmaker-v2/custom_sources
```

فقط یک process باید long polling ربات کنترل را اجرا کند. اجرای هم‌زمان `npm start` در کنار systemd باعث خطای Telegram 409 می‌شود.

## مانیتورینگ و Health Check

برنامه سه endpoint عملیاتی دارد:

| Endpoint | کاربرد | وضعیت خطا |
|---|---|---|
| `GET /healthz` | liveness؛ فقط زنده‌بودن process و HTTP را بررسی می‌کند | همیشه `200` تا orchestrator بتواند process را restart کند |
| `GET /readyz` | readiness؛ دیتابیس و پیکربندی را بررسی می‌کند و آخرین وضعیت control bot و lifecycle را نشان می‌دهد | در صورت آماده‌نبودن `503` |
| `GET /metrics` | سنجه‌های Prometheus با counterهای HTTP، polling و lifecycle | بدون توکن `404` و با توکن اشتباه `401` |

`/healthz` عمداً به Telegram وابسته نیست؛ قطع موقت Telegram نباید باعث شود health check، process زنده را مرده اعلام کند. در مقابل، `/readyz` برای load balancer و deploy باید استفاده شود.

بررسی دستی:

```bash
curl -fsS http://127.0.0.1:8443/healthz | jq
curl -i http://127.0.0.1:8443/readyz
curl -i -H "X-Metrics-Token: $METRICS_TOKEN" http://127.0.0.1:8443/metrics
```

برای Prometheus، endpoint را فقط روی شبکهٔ داخلی یا از طریق allowlist در reverse proxy منتشر کنید؛ توکن را در URL query قرار ندهید چون ممکن است در access log ذخیره شود. نمونهٔ scrape:

```yaml
scrape_configs:
  - job_name: botmaker
    scheme: https
    metrics_path: /metrics
    static_configs:
      - targets: ['bots.example.com']
    authorization:
      type: Bearer
      credentials: 'REPLACE_WITH_METRICS_TOKEN'
```

سنجه‌های اصلی شامل `botmaker_ready`، `botmaker_uptime_seconds`، تعداد درخواست‌ها و خطاهای HTTP، موفقیت/خطای polling ربات کنترل و اجرا/خطای scheduler چرخهٔ عمر هستند. هیچ متن پیام، توکن یا secret در metrics ذخیره نمی‌شود.

برای alerting اولیه می‌توانید این قواعد را در Prometheus/Alertmanager تعریف کنید:

```yaml
groups:
  - name: botmaker
    rules:
      - alert: BotMakerNotReady
        expr: botmaker_ready == 0
        for: 5m
      - alert: BotMakerControlPollingErrors
        expr: increase(botmaker_control_poll_errors_total[10m]) > 3
        for: 2m
      - alert: BotMakerLifecycleErrors
        expr: increase(botmaker_lifecycle_errors_total[15m]) > 0
        for: 5m
```

در systemd، `Restart=always` خرابی process را جبران می‌کند؛ `/readyz` و metrics برای تشخیص خرابی dependency، خطای polling و خطای scheduler هستند و جایگزین لاگ و alerting نمی‌شوند.

## به‌روزرسانی و rollback

قبل از به‌روزرسانی از دیتابیس backup بگیرید:

```bash
sudo systemctl stop botmaker-v2
sudo cp -a /opt/botmaker-v2/data/botmaker.db "/opt/botmaker-v2/data/botmaker.db.$(date +%F-%H%M%S).bak"
sudo systemctl start botmaker-v2
```

به‌روزرسانی پیشنهادی:

```bash
cd /opt/botmaker-v2-src
git fetch origin
git checkout main
git pull --ff-only origin main
sudo bash install.sh
sudo systemctl restart botmaker-v2
sudo systemctl status botmaker-v2 --no-pager
```

نصب‌کننده `.env` و `data/` را حفظ می‌کند. برای rollback:

```bash
cd /opt/botmaker-v2-src
git log --oneline -10
git checkout <KNOWN_GOOD_COMMIT>
sudo bash install.sh
sudo systemctl restart botmaker-v2
```

## بکاپ و بازیابی

بکاپ شامل دیتابیس و secretهاست و باید خارج از همان سرور، به‌صورت رمزنگاری‌شده و با دسترسی محدود نگهداری شود:

```bash
sudo systemctl stop botmaker-v2
sudo tar -czf "/root/botmaker-backup-$(date +%F).tar.gz" \
  -C /opt/botmaker-v2 data .env
sudo systemctl start botmaker-v2
sudo chmod 600 /root/botmaker-backup-*.tar.gz
```

بازیابی:

```bash
sudo systemctl stop botmaker-v2
sudo tar -xzf /root/botmaker-backup-YYYY-MM-DD.tar.gz -C /opt/botmaker-v2
sudo chown -R root:root /opt/botmaker-v2/data
sudo chmod 600 /opt/botmaker-v2/.env
sudo systemctl start botmaker-v2
curl -fsS http://127.0.0.1:8443/healthz
```

برای دیتابیس SQLite در حال استفاده، توقف سرویس قبل از کپی توصیه می‌شود تا فایل WAL ناقص منتقل نشود.

## عیب‌یابی

### `npm test` خطای پیدا نکردن مسیر `test` می‌دهد

بررسی کنید `package.json` شامل این دستور باشد:

```json
"test": "node --test test/*.test.js"
```

### خطای `Could not locate the bindings file` برای better-sqlite3

ابزارهای build را نصب و binding را rebuild کنید:

```bash
sudo apt install -y build-essential python3
npm rebuild better-sqlite3 --build-from-source
npm test
```

### سرویس بلافاصله متوقف می‌شود

```bash
sudo journalctl -u botmaker-v2 -n 100 --no-pager
sudo grep -E '^(CONTROL_BOT_TOKEN|OWNER_TELEGRAM_ID|ENCRYPTION_KEY|PUBLIC_URL|SECURITY_ALERT_SECRET)=' /opt/botmaker-v2/.env
```

مقادیر placeholder، کلید کوتاه و `PUBLIC_URL` خالی در حالت غیرمصنوعی باعث توقف عمدی برنامه می‌شوند.

### Telegram 409 Conflict

یک process اضافی را متوقف کنید:

```bash
pgrep -af 'node src/index.js'
sudo systemctl restart botmaker-v2
```

### health check کار می‌کند ولی وب‌هوک Telegram نه

- DNS و TLS را بررسی کنید.
- `PUBLIC_URL` باید با `https://` و دامنهٔ قابل‌دسترسی عمومی تنظیم شده باشد.
- reverse proxy باید مسیرها و هدرها را عبور دهد.
- لاگ systemd و لاگ Nginx را هم‌زمان بررسی کنید.
- در صورت تغییر دامنه، سرویس را restart کنید تا وب‌هوک‌های جدید با URL صحیح ثبت شوند.

### قالب‌های کانتینری در دسترس نیستند

وجود Docker به‌تنهایی کافی نیست؛ `runsc` باید در runtimeهای Docker دیده شود. در نبود gVisor، fail-closed بودن رفتار مورد انتظار و امنیتی است.

## امنیت

- `.env`، دیتابیس و `custom_sources/` را public یا commit نکنید.
- دسترسی `.env` و backupها را به owner محدود کنید.
- `ENCRYPTION_KEY` و `SECURITY_ALERT_SECRET` را در password manager یا secret manager نگهداری کنید.
- پورت داخلی `8443` را عمومی نکنید؛ دسترسی عمومی را از reverse proxy با TLS عبور دهید.
- برای قالب‌های کانتینری و سورس سفارشی، gVisor را نصب و Falco را در محیط تولید فعال کنید.
- لاگ‌های عمومی و issueها نباید شامل توکن Telegram، API Hash، شمارهٔ تلفن یا secret باشند.
- قبل از انتشار، `npm audit` و بررسی dependencyها را انجام دهید.

## مجوز

این پروژه با مجوز MIT منتشر شده است. برای اجزای شخص ثالث، فایل‌های `LICENSE` و `NOTICE` همان جزء را نیز رعایت کنید.
