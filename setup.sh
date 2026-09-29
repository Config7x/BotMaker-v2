#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -e config.json ]]; then echo 'config.json already exists; refusing to overwrite it.' >&2; exit 1; fi
command -v node >/dev/null || { echo 'Install Node.js 20 first.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Install npm first.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'Install openssl first.' >&2; exit 1; }
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != '20' ]]; then echo 'This trial requires Node.js 20.' >&2; exit 1; fi
read -r -p 'HTTPS base URL (example: https://bots.example.com): ' BASE
if [[ ! "$BASE" =~ ^https://[a-zA-Z0-9.-]+$ ]]; then echo 'Use an HTTPS hostname with no path or trailing slash.' >&2; exit 1; fi
read -r -p 'Your numeric Telegram user ID: ' ADMIN
if [[ ! "$ADMIN" =~ ^[1-9][0-9]{3,15}$ ]]; then echo 'Invalid numeric admin ID.' >&2; exit 1; fi
read -r -s -p 'New dedicated control bot token from BotFather: ' TOKEN
printf '\n'
if [[ ! "$TOKEN" =~ ^[0-9]+:[a-zA-Z0-9_-]{30,}$ ]]; then echo 'Invalid control bot token.' >&2; exit 1; fi
KEY="$(openssl rand -hex 32)"
umask 077
cat > config.json <<EOF
{"port":3000,"public_base_url":"$BASE","encryption_key":"$KEY","admin_id":$ADMIN,"max_bots_per_user":3,"db_path":"./data/botmaker.sqlite","control_bot_token":"$TOKEN","mock_telegram":false}
EOF
unset TOKEN KEY
chmod 600 config.json
npm ci --no-audit --no-fund
npm test
printf '\nConfiguration and dependencies ready. Next: configure HTTPS proxy to 127.0.0.1:3000, then run npm start.\n'
printf 'For private custom-source lab ONLY, read README_FA.md for explicit opt-in and Docker safety notes.\n'
