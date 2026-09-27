#!/usr/bin/env bash
# ============================================================================
# BotMaker v2 — idempotent Ubuntu VPS installer
# Safe to re-run: every step checks before changing anything.
# Usage:  sudo bash install.sh
# ============================================================================
set -euo pipefail

APP_DIR="/opt/botmaker-v2"
SERVICE="botmaker-v2"
NONINTERACTIVE="${NONINTERACTIVE:-0}"
echo "==> BotMaker v2 installer (idempotent)"

set_env_value() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

is_placeholder() {
  [[ -z "${1:-}" || "$1" == EDIT_ME || "$1" == PUT_* || "$1" == 123456:ABC-* || "$1" == https://bots.yourdomain.com ]]
}

configure_env_interactive() {
  if [[ "$NONINTERACTIVE" == "1" || ! -t 0 ]]; then
    echo "==> Non-interactive mode: skipping .env questions (use NONINTERACTIVE=0 on a terminal to configure it)."
    return
  fi

  echo ""
  echo "==> Interactive configuration"
  echo "    Each value is asked separately. Existing non-placeholder values are kept; press Enter to keep them."

  local value current answer
  current="$(grep -E '^CONTROL_BOT_TOKEN=' .env | cut -d= -f2- || true)"
  if is_placeholder "$current"; then
    read -r -p "توکن ربات کنترل از BotFather: " value
    while [[ -z "$value" ]]; do read -r -p "این مقدار الزامی است، دوباره وارد کنید: " value; done
    set_env_value CONTROL_BOT_TOKEN "$value"
  else
    echo "CONTROL_BOT_TOKEN از قبل تنظیم شده است."
  fi

  current="$(grep -E '^ENCRYPTION_KEY=' .env | cut -d= -f2- || true)"
  if is_placeholder "$current"; then
    read -r -p "برای ENCRYPTION_KEY کلید تصادفی خودکار ساخته شود؟ [Y/n]: " answer
    if [[ ! "$answer" =~ ^[Nn]$ ]]; then
      set_env_value ENCRYPTION_KEY "$(openssl rand -hex 32)"
      echo "ENCRYPTION_KEY ساخته شد و نمایش داده نمی‌شود."
    else
      read -r -s -p "ENCRYPTION_KEY: " value; echo
      while [[ ${#value} -lt 32 ]]; do read -r -s -p "حداقل ۳۲ کاراکتر، دوباره وارد کنید: " value; echo; done
      set_env_value ENCRYPTION_KEY "$value"
    fi
  else
    echo "ENCRYPTION_KEY از قبل تنظیم شده است."
  fi

  current="$(grep -E '^PUBLIC_URL=' .env | cut -d= -f2- || true)"
  if is_placeholder "$current"; then
    read -r -p "آدرس عمومی HTTPS پروژه (مثلاً https://bots.example.com): " value
    while [[ -z "$value" ]]; do read -r -p "این مقدار الزامی است، دوباره وارد کنید: " value; done
    set_env_value PUBLIC_URL "$value"
  else
    echo "PUBLIC_URL از قبل تنظیم شده است."
  fi

  current="$(grep -E '^OWNER_TELEGRAM_ID=' .env | cut -d= -f2- || true)"
  if is_placeholder "$current"; then
    read -r -p "شناسه عددی تلگرام مالک پلتفرم: " value
    while [[ -z "$value" ]]; do read -r -p "این مقدار الزامی است، دوباره وارد کنید: " value; done
    set_env_value OWNER_TELEGRAM_ID "$value"
  else
    echo "OWNER_TELEGRAM_ID از قبل تنظیم شده است."
  fi

  current="$(grep -E '^SECURITY_ALERT_SECRET=' .env | cut -d= -f2- || true)"
  if is_placeholder "$current"; then
    set_env_value SECURITY_ALERT_SECRET "$(openssl rand -hex 32)"
    echo "SECURITY_ALERT_SECRET به‌صورت تصادفی ساخته شد."
  fi

  current="$(grep -E '^METRICS_TOKEN=' .env | cut -d= -f2- || true)"
  if is_placeholder "$current"; then
    read -r -p "برای endpoint مانیتورینگ (/metrics) توکن ساخته شود؟ [Y/n]: " answer
    if [[ ! "$answer" =~ ^[Nn]$ ]]; then
      set_env_value METRICS_TOKEN "$(openssl rand -hex 32)"
      echo "METRICS_TOKEN ساخته شد؛ آن را در password manager نگه دارید."
    else
      set_env_value METRICS_TOKEN ""
      echo "endpoint /metrics غیرفعال خواهد بود؛ /healthz و /readyz فعال می‌مانند."
    fi
  fi

  current="$(grep -E '^TELETHON_API_ID=' .env | cut -d= -f2- || true)"
  read -r -p "قالب Config Scraper را استفاده می‌کنید؟ API_ID و API_HASH تنظیم شود؟ [y/N]: " answer
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    read -r -p "TELETHON_API_ID از my.telegram.org: " value
    set_env_value TELETHON_API_ID "$value"
    read -r -s -p "TELETHON_API_HASH از my.telegram.org: " value; echo
    set_env_value TELETHON_API_HASH "$value"
  else
    set_env_value TELETHON_API_ID "0"
    set_env_value TELETHON_API_HASH ""
    echo "تنظیمات Telethon رد شد؛ قالب Config Scraper غیرفعال می‌ماند."
  fi

  chmod 600 .env
  echo "==> تنظیمات در $APP_DIR/.env ذخیره شد."
}

# ---------------------------------------------------------------- node 20
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "==> Node.js $(node -v) OK"
fi

# ---------------------------------------------------------------- basics
for pkg in unzip curl ca-certificates rsync; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    echo "==> Installing $pkg"
    apt-get install -y "$pkg"
  fi
done

# ---------------------------------------------------------------- app files
echo "==> Deploying app to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --exclude node_modules --exclude .env --exclude data \
  "$(dirname "$0")/src" "$(dirname "$0")/test" "$(dirname "$0")/package.json" \
  "$(dirname "$0")/package-lock.json" "$(dirname "$0")/README.md" \
  "$(dirname "$0")/.env.example" "$APP_DIR/" 2>/dev/null \
  || cp -r "$(dirname "$0")/src" "$(dirname "$0")/test" "$(dirname "$0")/package.json" \
     "$(dirname "$0")/package-lock.json" "$(dirname "$0")/README.md" \
     "$(dirname "$0")/.env.example" "$APP_DIR/"

cd "$APP_DIR"
if [[ ! -f .env ]]; then
  echo "==> Creating .env from example"
  cp .env.example .env 2>/dev/null || cat > .env <<'ENVEOF'
CONTROL_BOT_TOKEN=EDIT_ME
ENCRYPTION_KEY=EDIT_ME
PUBLIC_URL=EDIT_ME
OWNER_TELEGRAM_ID=EDIT_ME
SECURITY_ALERT_SECRET=EDIT_ME
TELETHON_API_ID=0
TELETHON_API_HASH=EDIT_ME
ENVEOF
fi
configure_env_interactive
mkdir -p data custom_sources

echo "==> Installing npm dependencies"
[[ -d node_modules/better-sqlite3 ]] || npm ci --omit=dev || npm install --omit=dev

# ---------------------------------------------------------------- sandbox stack (optional, for custom-source hosting)
if command -v docker >/dev/null 2>&1; then
  echo "==> Docker found"
  if docker info 2>/dev/null | grep -q runsc; then
    echo "==> gVisor (runsc) detected — enabling sandbox hosting"
    sed -i 's/^GVISOR_AVAILABLE=.*/GVISOR_AVAILABLE=true/' .env || true
  else
    echo "==> gVisor NOT installed. Custom-source execution stays FAIL-CLOSED."
    echo "    To enable: install gVisor per https://gvisor.dev/docs/user_guide/install/"
  fi
  if command -v falcoctl >/dev/null 2>&1; then
    echo "==> Falco found — runtime monitoring active"
  else
    echo "==> Falco not installed (optional; recommended for custom-source hosting)"
  fi

  # ------------------------------------------------------------ containerized templates (§3.10-11)
  if docker info 2>/dev/null | grep -q runsc; then
    for tpl in vpn_shop config_scraper; do
      img="botmaker/${tpl}:latest"
      if docker image inspect "$img" >/dev/null 2>&1; then
        echo "==> Image $img already built"
      else
        echo "==> Building containerized template image: $img"
        docker build -t "$img" "$APP_DIR/src/templates/containerized/${tpl}" || {
          echo "!! Build of $img failed — template ${tpl} will be unavailable until it builds."
        }
      fi
    done
  else
    echo "==> gVisor missing: containerized templates (#10 VPN Shop, #11 Config"
    echo "    Auto-Scraper) stay FAIL-CLOSED and cannot be provisioned."
    echo "    Install gVisor per https://gvisor.dev/docs/user_guide/install/, re-run install.sh."
  fi
else
  echo "==> Docker not installed. Custom-source hosting AND containerized"
  echo "    templates (#10/#11) disabled (fail-closed)."
fi

# ---------------------------------------------------------------- systemd
echo "==> Setting up systemd service"
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=BotMaker v2 (Telegram bot builder platform)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE}" >/dev/null 2>&1 || true

if grep -qE 'EDIT_ME|PUT_|123456:ABC-|bots\.yourdomain\.com' .env 2>/dev/null; then
  echo ""
  echo "********************************************************"
  echo "*  .env is not configured yet."
  echo "*  1) nano $APP_DIR/.env  (fill all values)"
  echo "*  2) systemctl start ${SERVICE}"
  echo "********************************************************"
else
  systemctl restart "${SERVICE}"
  echo "==> Started. Status:"
  systemctl --no-pager -l status "${SERVICE}" | head -12 || true
fi

echo "==> Done. Health check: curl http://localhost:8443/healthz"
echo ""
echo "Post-install checklist:"
echo "  1) nano $APP_DIR/.env   — fill CONTROL_BOT_TOKEN, ENCRYPTION_KEY,"
echo "     PUBLIC_URL, OWNER_TELEGRAM_ID, and for template #11:"
echo "     TELETHON_API_ID / TELETHON_API_HASH (from https://my.telegram.org)"
echo "  2) systemctl start ${SERVICE}"
echo "  3) For containerized templates: Docker + gVisor required (fail-closed)."
