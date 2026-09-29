'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BotDb } = require('../src/db');
const { AdminController } = require('../src/admin');
const { createTelegramApi, clearMockCalls, getMockCalls } = require('../src/telegram');
const { containerTemplates, isContainerized } = require('../src/containerTemplates');
const { createProvisioner } = require('../src/provisioner');

const KEY = 'container_test_key_32bytes_long!!';
const TOKEN = '777777777:ABCdefGHIjklMNOpqrsTUVwxyZ77777';

async function startCreateFlow(admin, api, userId = 1234) {
  await admin.handleUpdate({
    update: { message: { from: { id: userId }, chat: { id: userId }, text: '/create_bot' } },
    api
  });
}

function makeTestEnv({ planId = 'pro' } = {}) {
  const db = new BotDb(':memory:');
  const config = {
    admin_id: 8888,
    max_bots_per_user: 5,
    encryption_key: KEY,
    mock_telegram: true,
    public_base_url: 'https://test-domain.com',
    provisioner_opts: { mock: true }
  };
  const admin = new AdminController({ db, config });
  const api = createTelegramApi('000000000:ControlBotTokenABCdefGHIjklMNO', { mock: true });
  db.savePlan({ id: 'pro', name: 'پرو', price: 100000, maxBots: 10, durationDays: 30, description: '' });
  db.registerUser(1234);
  if (planId !== 'free') db.setUserPlan(1234, planId, 30);
  return { db, admin, api };
}

test('Container template registry exposes §3.10-11 templates', () => {
  assert.ok(containerTemplates.vpn_shop);
  assert.ok(containerTemplates.config_scraper);
  assert.equal(containerTemplates.vpn_shop.wizard, 'panel');
  assert.equal(containerTemplates.config_scraper.wizard, 'telethon');
  assert.ok(isContainerized('vpn_shop'));
  assert.ok(isContainerized('config_scraper'));
  assert.equal(isContainerized('shop'), false);
  assert.equal(isContainerized(null), false);
});

test('Free-plan user is refused when selecting a containerized template', async () => {
  const { admin, api } = makeTestEnv({ planId: 'free' });
  await startCreateFlow(admin, api);
  clearMockCalls();
  await admin.handleUpdate({
    update: { message: { from: { id: 1234 }, chat: { id: 1234 }, text: 'vpn_shop' } },
    api
  });
  const calls = getMockCalls().filter(c => c.method === 'sendMessage');
  const refusal = calls.find(c => /پلن‌های/.test(c.payload.text || ''));
  assert.ok(refusal, 'expected Pro/VIP-only refusal message');
  // wizard never started
  assert.equal(admin.userStates.has('1234'), false);
});

test('Pro user: vpn_shop wizard reaches panel-type step (no webhook registration)', async () => {
  const { db, admin, api } = makeTestEnv({ planId: 'pro' });
  await startCreateFlow(admin, api);
  clearMockCalls();
  await admin.handleUpdate({
    update: { message: { from: { id: 1234 }, chat: { id: 1234 }, text: 'vpn_shop' } },
    api
  });
  assert.match(getMockCalls()[0].payload.text, /انتخاب شد/);

  clearMockCalls();
  await admin.handleUpdate({
    update: { message: { from: { id: 1234 }, chat: { id: 1234 }, text: TOKEN } },
    api
  });
  const calls = getMockCalls();
  // Containerized bots must NOT register a platform webhook
  assert.equal(calls.filter(c => c.method === 'setWebhook').length, 0);
  const wizardMsg = calls.find(c => c.method === 'sendMessage' && /پنل مدیریت VPN/.test(c.payload.text || ''));
  assert.ok(wizardMsg, 'expected panel-type wizard message');
  assert.equal(admin.userStates.get('1234').step, 'cw:panel_type');

  // bot record exists with containerized config and provisioning status
  const bot = db.getUserBots(1234).find(b => b.template_id === 'vpn_shop');
  assert.ok(bot);
  const cfg = typeof bot.config === 'string' ? JSON.parse(bot.config) : bot.config;
  assert.equal(cfg.containerized, true);
  assert.equal(bot.status, 'provisioning');
});

test('Pro user: config_scraper wizard shows ToS disclosure first', async () => {
  const { admin, api } = makeTestEnv({ planId: 'pro' });
  await startCreateFlow(admin, api);
  clearMockCalls();
  await admin.handleUpdate({
    update: { message: { from: { id: 1234 }, chat: { id: 1234 }, text: 'config_scraper' } },
    api
  });
  clearMockCalls();
  await admin.handleUpdate({
    update: { message: { from: { id: 1234 }, chat: { id: 1234 }, text: TOKEN } },
    api
  });
  const calls = getMockCalls();
  const tosMsg = calls.find(c => c.method === 'sendMessage' && /ریسک محدودیت/.test(c.payload.text || ''));
  assert.ok(tosMsg, 'expected Telethon ToS/ban-risk disclosure before phone step');
  assert.equal(admin.userStates.get('1234').step, 'cw:tos');
});

test('Container CRUD round-trip and bot record merge', () => {
  const db = new BotDb(':memory:');
  const bot = db.createBot({
    ownerId: 1234, token: TOKEN, templateId: 'vpn_shop',
    encryptionKey: KEY, maxBotsPerUser: 5
  });
  db.upsertContainer({ bot_id: bot.id, container_name: 'botmaker_test_1', image: 'botmaker/vpn_shop:latest', status: 'running' });
  assert.equal(db.getContainer(bot.id).status, 'running');
  db.updateContainer(bot.id, { status: 'stopped' });
  assert.equal(db.getContainer(bot.id).status, 'stopped');
  db.deleteContainer(bot.id);
  assert.equal(db.getContainer(bot.id), null);

  const updated = db.updateBotRecord(bot.id, { config: { containerized: true }, status: 'provisioning' });
  const cfg = typeof updated.config === 'string' ? JSON.parse(updated.config) : updated.config;
  assert.equal(cfg.containerized, true);
  assert.equal(updated.status, 'provisioning');
  // merge keeps earlier keys
  const merged = db.updateBotRecord(bot.id, { config: { panel_type: 'marzban' } });
  const cfg2 = typeof merged.config === 'string' ? JSON.parse(merged.config) : merged.config;
  assert.equal(cfg2.containerized, true);
  assert.equal(cfg2.panel_type, 'marzban');
});

test('Webhook skips containerized bots with 200 {skipped:containerized}', async () => {
  const { db, admin } = makeTestEnv({ planId: 'pro' });
  const { createWebhookApp } = require('../src/webhook');
  const app = createWebhookApp({ db, config: { encryption_key: KEY, mock_telegram: true, adminHandler: admin } });
  const bot = db.createBot({
    ownerId: 1234, token: TOKEN, templateId: 'config_scraper',
    encryptionKey: KEY, maxBotsPerUser: 5, secretToken: 'st_container_1'
  });
  db.updateBotRecord(bot.id, { config: { containerized: true }, status: 'active' });

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/webhook/${bot.secret_token}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': bot.secret_token
      },
      body: JSON.stringify({ update_id: 100001, message: { message_id: 1, from: { id: 1234 }, chat: { id: 1234, type: 'private' }, text: '/start' } })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.skipped, 'containerized');
  } finally {
    server.close();
  }
});
