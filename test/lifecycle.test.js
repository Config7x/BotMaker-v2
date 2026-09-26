'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const lifecycle = require('../src/lifecycle');
const { TelegramApi } = require('../src/telegram');
const { encrypt } = require('../src/cryptoutil');

const MIN = 60 * 1000;
const ENC = 'test-encryption-key-123';

function mkBot(db, owner, over = {}) {
  db.upsertUser(owner);
  const bot = db.createBot({
    id: over.id || 'demo1', owner_id: owner,
    token_encrypted: encrypt('111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ENC),
    secret_token: over.secret_token || 'sec', username: over.username || 'demobot',
    template_id: over.template_id || 'quiz', plan_id: over.plan_id || 'free',
    status: over.status || 'active', created_at: over.created_at, config: over.config
  });
  return bot;
}

function deps(log) {
  const apiFor = () => new TelegramApi('111:x', { mock: true, mockLog: log, mockResponses: {} });
  return { apiFor, publicUrl: 'https://example.com' };
}

test('lifecycle: exact demo-cycle timings (50min warn, 60min grace, +300min delete)', async () => {
  const db = createDb(':memory:');
  const log = [];
  const t0 = 1_000_000_000;
  const bot = mkBot(db, 777, { created_at: t0 });

  // nothing at 49 minutes
  mkBot0(); function mkBot0() {}
  let out = await lifecycle.tick(db, deps(log), t0 + 49 * MIN);
  assert.strictEqual(out.length, 0);
  assert.strictEqual(db.getBot(bot.id).config.warned || 0, 0);

  // warning exactly at 50 minutes — one-time
  out = await lifecycle.tick(db, deps(log), t0 + 50 * MIN);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].type, 'warn');
  assert.ok(log.some((c) => c.method === 'sendMessage' && /یادآوری/.test(c.payload.text)));
  out = await lifecycle.tick(db, deps(log), t0 + 55 * MIN); // no repeat
  assert.strictEqual(out.length, 0);

  // grace at 60 minutes: webhook removed, status grace, data intact
  const d = deps(log);
  out = await lifecycle.tick(db, d, t0 + 60 * MIN);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].type, 'grace');
  const g = db.getBot(bot.id);
  assert.strictEqual(g.status, 'grace');
  assert.ok(log.some((c) => c.method === 'deleteWebhook'));
  assert.ok(log.some((c) => c.method === 'sendMessage' && /۳۰۰ دقیقه/.test(c.payload.text)));

  // data intact during grace
  const store = db.botStore(bot.id);
  await store.set('quiz', { a: 1 });
  assert.deepStrictEqual(await store.get('quiz'), { a: 1 });

  // still in grace at +299 minutes
  out = await lifecycle.tick(db, deps(log), t0 + (60 + 299) * MIN);
  assert.strictEqual(out.length, 0);

  // permanent deletion at grace_start + 300 minutes, with final notice
  out = await lifecycle.tick(db, deps(log), t0 + (60 + 300) * MIN);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].type, 'delete');
  assert.strictEqual(db.getBot(bot.id), undefined);
  assert.ok(log.some((c) => c.method === 'sendMessage' && /دائمی حذف شد/.test(c.payload.text)));
});

test('lifecycle: upgrade during grace restores active immediately', async () => {
  const db = createDb(':memory:');
  const log = [];
  const t0 = 2_000_000_000;
  const bot = mkBot(db, 888, { created_at: t0 });
  const wallet = require('../src/wallet');

  await lifecycle.tick(db, deps(log), t0 + 60 * MIN); // -> grace
  assert.strictEqual(db.getBot(bot.id).status, 'grace');

  // fund wallet and upgrade
  wallet.credit(db, 888, 300000, 'topup', '');
  const r = await lifecycle.upgradeDemoBot(db, deps(log), { botId: bot.id, userId: 888, planId: 'pro', now: t0 + 90 * MIN });
  assert.strictEqual(r.ok, true);
  const up = db.getBot(bot.id);
  assert.strictEqual(up.status, 'active');
  assert.strictEqual(up.plan_id, 'pro');
  assert.ok(log.some((c) => c.method === 'setWebhook'));
});

test('lifecycle: one demo per template type — second attempt is not eligible', () => {
  const db = createDb(':memory:');
  db.upsertUser(999);
  assert.strictEqual(db.hasUsedDemo(999, 'quiz'), false);
  db.markDemoUsed(999, 'quiz');
  assert.strictEqual(db.hasUsedDemo(999, 'quiz'), true);
  assert.strictEqual(db.hasUsedDemo(999, 'shop'), false); // other templates remain eligible
});
