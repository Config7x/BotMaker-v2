#!/bin/sh
# ============================================================================
# BotMaker v2 — VPN Shop (template #10) container entrypoint
# Turns platform-injected env vars into app configuration, starts the
# in-container MariaDB, cron jobs and Apache, then runs forever.
# Env contract (all injected by the provisioner, secrets AES-encrypted at rest):
#   BM_BOT_TOKEN        BotFather token of this shop bot instance
#   BM_PANEL_TYPE       marzban | pasarguard | wgdashboard | remnawave | x-ui
#   BM_PANEL_URL        customer's panel base URL
#   BM_PANEL_USER       panel admin username / API user
#   BM_PANEL_PASS       panel admin password / API key  (secret)
#   BM_DB_PASS          generated per-instance MariaDB root password
#   BM_BRAND_NAME       instance display name
# ============================================================================
set -e

: "${BM_BOT_TOKEN:?BM_BOT_TOKEN required}"
: "${BM_PANEL_TYPE:?BM_PANEL_TYPE required}"
: "${BM_PANEL_URL:?BM_PANEL_URL required}"
: "${BM_PANEL_USER:?BM_PANEL_USER required}"
: "${BM_PANEL_PASS:?BM_PANEL_PASS required}"
: "${BM_DB_PASS:=botmaker_$(head -c12 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
: "${BM_BRAND_NAME:=BotMaker Shop}"

# ---------------------------------------------------------------- MariaDB
mkdir -p /app/data/mysql
mysqld_safe --datadir=/app/data/mysql \
  --bind-address=127.0.0.1 --port=3306 --skip-networking=0 &

# wait for MySQL
for i in $(seq 1 60); do
  mysqladmin ping --silent 2>/dev/null && break
  sleep 1
done

mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS shopdb CHARACTER SET utf8mb4;
ALTER USER 'root'@'localhost' IDENTIFIED BY '${BM_DB_PASS}';
FLUSH PRIVILEGES;
SQL

# ---------------------------------------------------------------- app config
# The reference app consumes its config via .env-style defines (see config.php);
# we generate them from BM_* env without touching the app source.
cat > /var/www/html/botmaker.env.php <<PHP
<?php
// generated at container start by BotMaker provisioner — do not edit
\$GLOBALS['BM_ENV'] = [
  'BOT_TOKEN'    => getenv('BM_BOT_TOKEN'),
  'PANEL_TYPE'   => getenv('BM_PANEL_TYPE'),
  'PANEL_URL'    => getenv('BM_PANEL_URL'),
  'PANEL_USER'   => getenv('BM_PANEL_USER'),
  'PANEL_PASS'   => getenv('BM_PANEL_PASS'),
  'DB_HOST'      => '127.0.0.1',
  'DB_NAME'      => 'shopdb',
  'DB_USER'      => 'root',
  'DB_PASS'      => getenv('BM_DB_PASS'),
  'BRAND_NAME'   => getenv('BM_BRAND_NAME'),
];
PHP

# ---------------------------------------------------------------- cron
cat > /etc/cron.d/botmaker-shop <<CRON
*/5 * * * * root cd /var/www/html && php cronbot/cron.php >> /app/data/cron.log 2>&1
0 3 * * * root cd /var/www/html && php cron/expiry_check.php >> /app/data/cron.log 2>&1
CRON
chmod 0644 /etc/cron.d/botmaker-shop
cron

# ---------------------------------------------------------------- web server
export APACHE_RUN_USER=www-data APACHE_RUN_GROUP=www-data
exec apache2-foreground
