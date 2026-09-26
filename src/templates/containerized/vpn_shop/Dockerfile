FROM php:8.2-apache

# BotMaker v2 containerized template #10 — VPN Subscription Shop
# Pre-built, code-reviewed source (GPL-3.0, NOTICE.md preserved) in ./source.
# PHP + MySQL(MariaDB in-container) + cron + Mini App static assets.

RUN apt-get update && apt-get install -y --no-install-recommends \
      mariadb-server mariadb-client cron curl unzip \
      libonig-dev libxml2-dev libcurl4-openssl-dev libzip-dev \
    && rm -rf /var/lib/apt/lists/* \
    && docker-php-ext-install mysqli pdo pdo_mysql curl zip bcmath

# platform integration shim: turns BotMaker env vars into app config
COPY shims/ /opt/botmaker/

RUN chmod +x /opt/botmaker/entrypoint.sh

# app source (Apache doc root)
COPY source/ /var/www/html/

# in-container MySQL data + app storage survive restarts via /app/data volume
VOLUME ["/app/data"]

ENTRYPOINT ["/opt/botmaker/entrypoint.sh"]
