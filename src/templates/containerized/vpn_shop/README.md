# Template #10 — VPN Subscription Shop (containerized)

Pro-VIP only. PHP + in-container MariaDB + cron + Telegram Mini App;
provisioned per bot instance into its own gVisor container
(`--runtime=runsc`, cap-drop=ALL, resource limits, read-only rootfs +
`/app/data` volume for MySQL + app storage). No AI scan / admin approval
(pre-built, code-reviewed).

• `source/` — rebranded fork of the GPL-3.0 "Faoxima" bot (§8.2).
  `LICENSE` + `NOTICE.md` preserved per GPL "marked as changed" requirements.
• `shims/entrypoint.sh` — BotMaker integration shim: injects the customer's
  panel credentials (panel type / URL / user / password, AES-256-GCM
  encrypted at rest) and the bot token as env vars, boots MariaDB, installs
  renewal/expiry cron and Apache. The app source itself is not modified.

Panel adapters: Marzban / PasarGuard / WGDashboard / Remnawave / x-ui —
the panel runs on the customer's own infrastructure; this bot only talks
to it over HTTPS with the credentials the customer provides at creation.

Build: `docker build -t botmaker/vpn_shop:latest .` from this directory.
