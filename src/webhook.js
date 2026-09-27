'use strict';

const express = require('express');
const { createMonitoring } = require('./monitoring');

function hasMetricsAccess(req, token) {
  if (!token) return false;
  const header = req.get('X-Metrics-Token') || '';
  const auth = req.get('Authorization') || '';
  return header === token || auth === `Bearer ${token}`;
}

/**
 * Central webhook dispatcher plus operational endpoints:
 *   GET /healthz  - cheap liveness check, never depends on Telegram
 *   GET /readyz    - database/config readiness, 503 when not ready
 *   GET /metrics   - Prometheus text format, protected by METRICS_TOKEN
 */
function createWebhookApp(deps) {
  const { db, cfg, registry, apiFor, onSecurityAlert } = deps;
  const monitoring = deps.monitoring || createMonitoring();
  const app = express();

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      monitoring.recordHttp({ method: req.method, path: req.path, statusCode: res.statusCode, durationMs });
    });
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  app.get('/healthz', (_req, res) => {
    const snapshot = monitoring.snapshot({ db, cfg });
    // Liveness answers whether the Node process and HTTP server are alive.
    // Dependency failures belong to /readyz, not this endpoint.
    res.status(200).json({
      ok: true,
      status: 'alive',
      service: snapshot.service,
      version: snapshot.version,
      uptime_seconds: snapshot.uptime_seconds,
      timestamp: snapshot.timestamp
    });
  });

  app.get('/readyz', (_req, res) => {
    const snapshot = monitoring.snapshot({ db, cfg });
    res.status(snapshot.ok ? 200 : 503).json(snapshot);
  });

  app.get('/metrics', (req, res) => {
    if (!hasMetricsAccess(req, cfg?.METRICS_TOKEN)) {
      return res.status(cfg?.METRICS_TOKEN ? 401 : 404).type('text/plain').send('metrics unavailable\n');
    }
    return res.type('text/plain; version=0.0.4').send(monitoring.metrics({ db, cfg }));
  });

  app.post('/webhook/:secretToken', async (req, res) => {
    try {
      const { secretToken } = req.params;
      const headerSecret = req.get('X-Telegram-Bot-Api-Secret-Token');
      const bot = db.getBotBySecret(secretToken);
      if (!bot || headerSecret !== bot.secret_token) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
      }
      if (bot.status !== 'active') {
        return res.status(200).json({ ok: true, skipped: bot.status });
      }
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

module.exports = { createWebhookApp, hasMetricsAccess };
