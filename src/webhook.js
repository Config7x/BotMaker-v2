'use strict';

const express = require('express');
const { createTelegramApi } = require('./telegram');
const { decryptToken } = require('./db');
const { cleanupExtractedSource } = require('./custom/validator');
const path = require('path');
const fs = require('fs');

/**
 * Dynamically resolves and loads a template handler module by template ID
 */
function loadTemplateModule(templateId, db) {
  const cleanId = String(templateId || '').replace(/[^a-z0-9_]/gi, '');
  if (!cleanId) return null;

  const possiblePaths = [
    path.join(__dirname, 'templates', cleanId, 'index.js'),
    path.join(__dirname, 'templates', `${cleanId}.js`),
    path.join(__dirname, 'templates', cleanId, `${cleanId}.js`)
  ];

  // Also check admin-added custom templates (stored outside src/templates)
  if (db && db.sqlite) {
    try {
      const row = db.sqlite
        .prepare('SELECT source_dir FROM custom_templates WHERE id = ? AND enabled = 1')
        .get(cleanId);
      if (row && row.source_dir) {
        possiblePaths.push(path.join(row.source_dir, 'index.js'));
        possiblePaths.push(path.join(row.source_dir, `${cleanId}.js`));
      }
    } catch (err) {
      // custom_templates table may not exist yet on older DBs; ignore
    }
  }

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      try {
        const mod = require(p);
        if (typeof mod.handle === 'function') {
          return mod;
        } else if (typeof mod === 'function') {
          return { handle: mod };
        } else if (mod.default && typeof mod.default.handle === 'function') {
          return mod.default;
        }
      } catch (err) {
        console.error(`Error loading template module at ${p}:`, err);
      }
    }
  }

  return null;
}

/**
 * Creates Express Application for central webhook dispatch
 */
function createWebhookApp({ db, config, adminHandler = null, runner = null }) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Requirement 8: Internal Security Alert Endpoint
  app.post('/internal/security-alert', async (req, res) => {
    const internalSecretHeader = req.headers['x-internal-secret'];
    const expectedSecret = config.internal_alert_secret || process.env.INTERNAL_ALERT_SECRET;

    if (!internalSecretHeader) {
      return res.status(401).json({ error: 'Missing X-Internal-Secret header' });
    }

    if (!expectedSecret || internalSecretHeader !== expectedSecret) {
      return res.status(403).json({ error: 'Forbidden: Secret mismatch' });
    }

    const { containerId, botId, ruleName, details } = req.body || {};

    if (!botId) {
      return res.status(400).json({ error: 'botId is required' });
    }

    // Verify botId exists before acting on it
    const project = db.sqlite.prepare('SELECT * FROM custom_projects WHERE id = ?').get(botId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    try {
      // (a) runner.stop({ botId })
      if (runner && typeof runner.stop === 'function') {
        await runner.stop({ botId }).catch(() => {});
      } else {
        const dockerRunner = require('./custom/runtime');
        await dockerRunner.stop({ botId }).catch(() => {});
      }

      // (b) Mark custom_projects row status 'killed_security_violation'
      const reportContent = JSON.stringify({
        ruleName: ruleName || 'SECURITY_VIOLATION',
        details: details || 'Container was terminated due to a security violation',
        killedAt: new Date().toISOString()
      });

      db.sqlite.prepare(
        "UPDATE custom_projects SET status = 'killed_security_violation', report = ? WHERE id = ?"
      ).run(reportContent, botId);

      // (c) cleanupExtractedSource on its source dir
      if (project.source_dir) {
        try {
          cleanupExtractedSource(path.dirname(project.source_dir));
        } catch {
          // ignore cleanup errors
        }
      }

      const isMock = config.mock_telegram || process.env.MOCK_TELEGRAM === 'true';
      const api = createTelegramApi(config.control_bot_token || 'mock_token', { mock: isMock });

      // (d) Urgent Telegram alert to admin_id with full details
      if (config.admin_id) {
        const alertMsg = `<b>🚨 هشدار فوق‌العاده امنیتی (Security Violation Alert)</b>\n\nپروژه <code>${botId}</code> متوقف و پاکسازی شد.\n<b>کانتینر:</b> <code>${containerId || 'N/A'}</code>\n<b>قانون نقض شده:</b> ${ruleName || 'نامشخص'}\n<b>جزئیات:</b> ${details || 'نامشخص'}`;
        await api.sendMessage(config.admin_id, alertMsg, { parse_mode: 'HTML' }).catch(() => {});
      }

      // (e) Message to affected user
      if (project.owner_id) {
        const userMsg = `<b>🚨 تعلیق پروژه به دلیل نقض قوانین امنیتی</b>\n\nپروژه سورس اختصاصی <code>${botId}</code> شما به دلیل شناسایی رفتار غیرمجاز/نقض امنیت (<code>${ruleName || 'انحراف امنیتی'}</code>) به صورت فوری متوقف و از سیستم حذف گردید.`;
        await api.sendMessage(project.owner_id, userMsg, { parse_mode: 'HTML' }).catch(() => {});
      }

      return res.status(200).json({ ok: true, action: 'killed', botId });
    } catch (err) {
      console.error('Error handling internal security alert:', err);
      return res.status(500).json({ error: 'Internal server error processing security alert' });
    }
  });

  // Central Webhook Dispatch Endpoint
  app.post('/webhook/:secretToken', async (req, res) => {
    const { secretToken } = req.params;

    if (!secretToken) {
      return res.status(404).json({ error: 'Not found' });
    }

    try {
      const bot = db.getBotBySecretToken(secretToken);

      // Requirement: unknown or inactive bot token -> no leak, standard status code
      if (!bot || bot.status !== 'active') {
        return res.status(404).json({ error: 'Not found' });
      }

      // Verify X-Telegram-Bot-Api-Secret-Token header if present
      const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
      if (headerSecret !== bot.secret_token) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const update = req.body;
      if (!update || !Number.isSafeInteger(update.update_id)) {
        return res.status(400).json({ error: 'Bad request' });
      }

      if (!db.claimUpdate(bot.id, update.update_id)) return res.status(200).json({ ok: true, duplicate: true });
      req.claimedUpdate = { botId: bot.id, updateId: update.update_id };

      // Containerized templates (§3.10-11) run in their own gVisor container,
      // NOT as in-process webhook modules — nothing to dispatch here.
      try {
        const cfg = typeof bot.config === 'string' ? JSON.parse(bot.config || '{}') : (bot.config || {});
        if (cfg && cfg.containerized) {
          return res.status(200).json({ ok: true, skipped: 'containerized' });
        }
      } catch { /* treat parse failure as non-containerized */ }

      // Decrypt bot token for API calls
      const encryptionKey = config.encryption_key || process.env.ENCRYPTION_KEY;
      let decryptedToken;
      try {
        decryptedToken = decryptToken(bot.token_encrypted, encryptionKey);
      } catch (err) {
        db.releaseUpdate(bot.id, update.update_id);
        console.error(`Failed to decrypt token for bot ${bot.id}`);
        return res.status(500).json({ error: 'Internal server error' });
      }

      const isMock = config.mock_telegram || process.env.MOCK_TELEGRAM === 'true';
      const api = createTelegramApi(decryptedToken, { mock: isMock });
      const botDb = db.getBotScopedDb(bot.id);

      // Route Control Bot updates to adminHandler if template is 'control' or bot.id === 'control_bot'
      if (bot.template_id === 'control' || bot.id === 'control_bot') {
        if (adminHandler && typeof adminHandler.handleUpdate === 'function') {
          await adminHandler.handleUpdate({ update, bot, api, db });
        }
        return res.status(200).json({ ok: true });
      }

      // Load target template module
      const template = loadTemplateModule(bot.template_id, db);
      if (!template || typeof template.handle !== 'function') {
        db.releaseUpdate(bot.id, update.update_id);
        console.warn(`No handler found for template: ${bot.template_id}`);
        return res.status(503).json({ error: 'Handler unavailable' });
      }

      // Execute template handler
      await template.handle({ update, bot, api, db: botDb });

      return res.status(200).json({ ok: true });
    } catch (err) {
      if (req.claimedUpdate) db.releaseUpdate(req.claimedUpdate.botId, req.claimedUpdate.updateId);
      console.error('Error handling webhook update:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}

module.exports = {
  createWebhookApp,
  loadTemplateModule
};
