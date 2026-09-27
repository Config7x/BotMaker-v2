'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createDb } = require('../src/db');
const { createWebhookApp } = require('../src/webhook');
const { createMonitoring } = require('../src/monitoring');

function request(server, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function harness(cfg = {}) {
  const db = createDb(':memory:');
  const app = createWebhookApp({
    db,
    cfg: { problems: [], METRICS_TOKEN: 'metrics-secret', ...cfg },
    registry: {},
    apiFor: () => null,
    onSecurityAlert: async () => ({ ok: true })
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  return { server, db };
}

test('health monitoring: liveness and readiness expose safe state', async () => {
  const h = await harness();
  try {
    const live = await request(h.server, 'GET', '/healthz');
    assert.equal(live.status, 200);
    assert.equal(JSON.parse(live.body).status, 'alive');

    const ready = await request(h.server, 'GET', '/readyz');
    assert.equal(ready.status, 200);
    const payload = JSON.parse(ready.body);
    assert.equal(payload.ok, true);
    assert.equal(payload.checks.database.ok, true);
    assert.equal(payload.checks.configuration.ok, true);
  } finally {
    h.server.close();
  }
});

test('health monitoring: readiness returns 503 for invalid configuration', async () => {
  const h = await harness({ problems: ['CONTROL_BOT_TOKEN missing'] });
  try {
    const ready = await request(h.server, 'GET', '/readyz');
    assert.equal(ready.status, 503);
    assert.equal(JSON.parse(ready.body).ok, false);
  } finally {
    h.server.close();
  }
});

test('health monitoring: metrics are private and expose Prometheus counters', async () => {
  const h = await harness();
  try {
    const denied = await request(h.server, 'GET', '/metrics');
    assert.equal(denied.status, 401);

    const allowed = await request(h.server, 'GET', '/metrics', { 'X-Metrics-Token': 'metrics-secret' });
    assert.equal(allowed.status, 200);
    assert.match(allowed.body, /botmaker_ready [01]/);
    assert.match(allowed.body, /botmaker_http_requests_total/);
    assert.match(allowed.headers['content-type'], /text\/plain/);
  } finally {
    h.server.close();
  }
});

test('health monitoring: monitoring records control and lifecycle failures', () => {
  let t = 1_000;
  const monitoring = createMonitoring({ now: () => t });
  monitoring.markControlSuccess();
  monitoring.markControlError(new Error('telegram unavailable'));
  monitoring.markLifecycleError(new Error('database busy'), 12);
  const snapshot = monitoring.snapshot({ db: { raw: { prepare: () => ({ get: () => ({ ok: 1 }) }) } }, cfg: { problems: [] } });
  assert.equal(snapshot.counters.controlPolls, 1);
  assert.equal(snapshot.counters.controlPollErrors, 1);
  assert.equal(snapshot.counters.lifecycleErrors, 1);
  assert.equal(snapshot.checks.control_bot.last_error, 'telegram unavailable');
  t += 1000;
  assert.match(monitoring.metrics({ db: { raw: { prepare: () => ({ get: () => ({ ok: 1 }) }) } }, cfg: { problems: [] } }), /botmaker_lifecycle_errors_total 1/);
});
