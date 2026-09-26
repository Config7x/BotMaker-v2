'use strict';

const path = require('path');

function getStr(key, def = '') {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v.trim();
}
function getInt(key, def) {
  const v = parseInt(getStr(key, ''), 10);
  return Number.isFinite(v) ? v : def;
}
function getBool(key, def = false) {
  const v = getStr(key).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return def;
}

function loadConfig(envPath) {
  // minimal .env loader (no external deps)
  try {
    const fs = require('fs');
    const p = envPath || path.join(process.cwd(), '.env');
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    }
  } catch (_) { /* .env is optional */ }

  const cfg = {
    CONTROL_BOT_TOKEN: getStr('CONTROL_BOT_TOKEN'),
    ENCRYPTION_KEY: getStr('ENCRYPTION_KEY'),
    PUBLIC_URL: getStr('PUBLIC_URL', ''),
    PORT: getInt('PORT', 8443),
    DB_PATH: getStr('DB_PATH', path.join(process.cwd(), 'data', 'botmaker.db')),
    OWNER_TELEGRAM_ID: getStr('OWNER_TELEGRAM_ID', ''),
    SECURITY_ALERT_SECRET: getStr('SECURITY_ALERT_SECRET'),
    MOCK_TELEGRAM: getBool('MOCK_TELEGRAM', false),
    CUSTOM_SOURCE_PRICE: getInt('CUSTOM_SOURCE_PRICE', 300000),
    CUSTOM_SOURCES_DIR: getStr('CUSTOM_SOURCES_DIR', path.join(process.cwd(), 'custom_sources')),
    GVISOR_AVAILABLE: getBool('GVISOR_AVAILABLE', false), // production: installer verifies `docker info | grep runsc`
    // containerized template #11 (Config Auto-Scraper): fresh platform-level
    // Telethon API credentials from my.telegram.org — never from the reference copy
    TELETHON_API_ID: getInt('TELETHON_API_ID', 0),
    TELETHON_API_HASH: getStr('TELETHON_API_HASH', '')
  };
  const problems = [];
  if (!cfg.CONTROL_BOT_TOKEN || cfg.CONTROL_BOT_TOKEN.includes('PUT_')) problems.push('CONTROL_BOT_TOKEN missing in .env');
  if (!cfg.ENCRYPTION_KEY || cfg.ENCRYPTION_KEY.length < 8) problems.push('ENCRYPTION_KEY missing/too short in .env');
  if (!cfg.PUBLIC_URL && !cfg.MOCK_TELEGRAM) problems.push('PUBLIC_URL missing in .env (needed for user-bot webhooks)');
  if (!cfg.OWNER_TELEGRAM_ID) problems.push('OWNER_TELEGRAM_ID missing in .env (platform owner user id)');
  if (!cfg.SECURITY_ALERT_SECRET) problems.push('SECURITY_ALERT_SECRET missing in .env');
  if (!cfg.TELETHON_API_ID || !cfg.TELETHON_API_HASH || cfg.TELETHON_API_HASH.includes('PUT_')) {
    problems.push('TELETHON_API_ID / TELETHON_API_HASH missing in .env (required for template #11 Config Auto-Scraper)');
  }
  cfg.problems = problems;
  return cfg;
}

module.exports = { loadConfig };
