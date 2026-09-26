'use strict';

const express = require('express');

/**
 * Central webhook dispatcher: single Express endpoint. Every created bot's
 * Telegram webhook points to POST /webhook/:secretToken. Verifies the
 * X-Telegram-Bot-Api-Secret-Token header, decrypts the BotFather token,
 * loads the template module from the STATIC registry (no dynamic code), and
 * invokes template.handle({ update, bot, api, db }).
 * Also exposes POST /internal/security-alert (Falco watchdog, shared secret)
 * and GET /healthz.
 */
function createWebhookApp(deps) {
  const { db, cfg, registry, apiFor, onSecurityAlert } = deps;
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', (_req, res) => res.json({ ok: true, name: 'botmaker-v2' }));

  app.post('/webhook/:secretToken', async (req, res) => {
    try {
      const { secretToken } = req.params;
      const headerSecret = req.get('X-Telegram-Bot-Api-Secret-Token');
      const bot = db.getBotBySecret(secretToken);
      if (!bot || headerSecret !== bot.secret_token) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }
      if (bot.status !== 'active') {
        return res.status(200).json({ ok: true, skipped: bot.status }); // grace/paused: no responses
      }
      // containerized templates (§3.10-11) run their own bot inside a gVisor
      // container — they never point a webhook at this platform dispatcher.
      if (bot.config && bot.config.containerized) {
        return res.status(200).json({ ok: true, skipped: 'containerized' });
      }
      const template = registry[bot.template_id];
      if (!template) return res.status(500).json({ ok: false, error: 'template_not_found' });
      const api = apiFor(bot);
      const store = db.botStore(bot.id);
      await template.handle({ update: req.body, bot, api, db: store });
      return res.json({ ok: true });
    } catch (err) {
      // never log the token; log bot id only
      console.error('[webhook] handler error:', err.message);
      return res.status(200).json({ ok: true, handled: false });
    }
  });

  app.post('/internal/security-alert', async (req, res) => {
    const sharedSecret = req.get('X-Alert-Secret');
    const projectId = req.body && req.body.project_id;
    const result = await onSecurityAlert({ projectId, sharedSecret });
    if (!result.ok) return res.status(result.reason === 'bad_secret' ? 403 : 404).json(result);
    res.json(result);
  });

  return app;
}

module.exports = { createWebhookApp };
