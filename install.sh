#!/usr/bin/env bash
# ============================================================================
# BotMaker v2 — idempotent Ubuntu VPS installer
# Safe to re-run: every step checks before changing anything.
# Usage:  sudo bash install.sh
# ============================================================================
set -euo pipefail

APP_DIR="/opt/botmaker-v2"
SERVICE="botmaker-v2"
echo "==> BotMaker v2 installer (idempotent)"

# ---------------------------------------------------------------- node 20
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  echo "==> Node.js $(node -v) OK"
fi

# ---------------------------------------------------------------- basics
for pkg in unzip curl ca-certificates; do
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
     "$(dirname "$0")/.env.example" "$APP_DIR/"

cd "$APP_DIR"
if [[ ! -f .env ]]; then
  echo "==> Creating .env from example — EDIT IT BEFORE STARTING"
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

if grep -q 'EDIT_ME' .env 2>/dev/null; then
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
