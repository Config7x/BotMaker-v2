'use strict';

// Load .env from the project root if present (idempotent; real env wins)
try {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
} catch { /* dotenv not installed — rely on process environment / config.json */ }

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { decryptToken, BotDb } = require('./db');
const { AdminController } = require('./admin');
const { createWebhookApp } = require('./webhook');
const { setWebhook, createTelegramApi } = require('./telegram');
const { startLifecycleJob } = require('./lifecycle');

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  let fileConfig = {};

  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.warn('Warning: Failed to parse config.json, using defaults/environment variables.');
    }
  }

  return {
    port: Number(process.env.PORT || fileConfig.port || 3000),
    host: process.env.HOST || '127.0.0.1',
    admin_only: process.env.ADMIN_ONLY !== 'false',
    public_base_url: process.env.PUBLIC_BASE_URL || fileConfig.public_base_url || 'https://example.com',
    encryption_key: process.env.ENCRYPTION_KEY || fileConfig.encryption_key || '',
    admin_id: Number(process.env.ADMIN_ID || fileConfig.admin_id || 0),
    max_bots_per_user: Number(process.env.MAX_BOTS_PER_USER || fileConfig.max_bots_per_user || 3),
    db_path: process.env.DB_PATH || fileConfig.db_path || path.join(__dirname, '..', 'data', 'botmaker.sqlite'),
    control_bot_token: process.env.CONTROL_BOT_TOKEN || fileConfig.control_bot_token || '',
    mock_telegram: process.env.MOCK_TELEGRAM === 'true' || fileConfig.mock_telegram || false,
    lab_mode: process.env.LAB_MODE === 'true',
    projects_dir: process.env.PROJECTS_DIR || fileConfig.projects_dir || path.join(__dirname, '..', 'data', 'projects')
  };
}

async function startServer() {
  const config = loadConfig();
  console.log('Starting BotMaker v2 Core Engine...');
  console.log(`Port: ${config.port}`);
  console.log(`Public Base URL: ${config.public_base_url}`);
  console.log(`Max Bots Per User: ${config.max_bots_per_user}`);
  console.log(`Mock Telegram Mode: ${config.mock_telegram}`);

  if (!Number.isSafeInteger(config.admin_id) || config.admin_id <= 0) throw new Error('Set ADMIN_ID to your numeric Telegram account ID');
  if (!config.mock_telegram && !config.control_bot_token) throw new Error('Set CONTROL_BOT_TOKEN from BotFather');
  if (config.encryption_key.length < 32) throw new Error('Set ENCRYPTION_KEY to a random secret of at least 32 characters');
  if (!config.mock_telegram && (!/^https:\/\//.test(config.public_base_url) || config.public_base_url.includes('example.com'))) throw new Error('Set PUBLIC_BASE_URL to your real HTTPS domain');
  
  const db = new BotDb(config.db_path);
  const adminController = new AdminController({ db, config });

  // Register or ensure Control Bot record in database if token is present
  if (config.control_bot_token) {
    try {
      let controlBot = db.getControlBot();
      if (controlBot && decryptToken(controlBot.token_encrypted, config.encryption_key) !== config.control_bot_token) {
        throw new Error('Control bot token changed: use the original token or start with a new empty database');
      }
      if (!controlBot) {
        controlBot = db.createBot({
          ownerId: config.admin_id || 1,
          token: config.control_bot_token,
          username: 'ControlBot',
          templateId: 'control',
          secretToken: crypto.randomBytes(24).toString('hex'),
          encryptionKey: config.encryption_key,
          maxBotsPerUser: 9999
        });
      }
      // Register webhook
      const registered = await setWebhook(config.control_bot_token, config.public_base_url, controlBot.secret_token, {
        mock: config.mock_telegram
      });
      if (!registered.ok) throw new Error('Telegram rejected the control bot webhook');
      console.log('Control Bot initialized.');
    } catch (err) {
      db.close();
      throw new Error('Control bot initialization failed: ' + err.message);
    }
  }

  // Start background subscription lifecycle manager
  const lifecycleJob = startLifecycleJob({
    db,
    config,
    getApi: token => createTelegramApi(token, { mock: config.mock_telegram })
  });

  const app = createWebhookApp({ db, config, adminHandler: adminController });

  const server = app.listen(config.port, config.host, () => {
    console.log(`BotMaker v2 Core webhook server running at ${config.host}:${config.port}`);
  });

  const gracefulShutdown = () => {
    console.log('Shutting down server...');
    if (lifecycleJob && lifecycleJob.stop) {
      lifecycleJob.stop();
    }
    server.close(() => {
      db.close();
      console.log('Server and database closed gracefully.');
      process.exit(0);
    });
  };

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  return { app, server, db, adminController, config, lifecycleJob };
}

if (require.main === module) {
  startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = {
  loadConfig,
  startServer
};
