'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const { createControlBot } = require('../src/admin');
const { TelegramApi } = require('../src/telegram');
const { encrypt } = require('../src/cryptoutil');
const { registry } = require('../src/templates/registry');

const ENC = 'test-encryption-key-123';
const OWNER = '1001';
const USER = '2002';

function makeHarness() {
  const db = createDb(':memory:');
  const controlLog = [];
  const botLogs = new Map();
  const controlApi = new TelegramApi('0:control', { mock: true, mockLog: controlLog });
  const cfg = {
    ENCRYPTION_KEY: ENC,
    PUBLIC_URL: 'https://bm.example.com',
    OWNER_TELEGRAM_ID: OWNER,
    CUSTOM_SOURCE_PRICE: 300000,
    CUSTOM_SOURCES_DIR: '/tmp/bm2_test_custom',
    CONTROL_BOT_TOKEN: '0:control'
  };
  const apiFor = (bot) => {
    if (!botLogs.has(bot.id)) botLogs.set(bot.id, []);
    return new TelegramApi('0:bot', { mock: true, mockLog: botLogs.get(bot.id) });
  };
  const makeApi = (token) => {
    const l = [];
    return new TelegramApi(token, { mock: true, mockLog: l, mockResponses: { getMe: { ok: true, result: { id: 1, username: 'newbot', first_name: 'NB' } } } });
  };
  const controlBot = createControlBot({ db, cfg, registry, apiFor, makeApi, controlApi, clock: { now: () => 5_000_000_000 } });
  return { db, controlBot, controlApi, controlLog, botLogs, cfg };
}

function lastSend(log) {
  return [...log].reverse().find((c) => c.method === 'sendMessage');
}

async function msgText(h, userId, text) {
  await h.controlBot.processUpdate({ update_id: Math.floor(Math.random() * 1e9), message: { message_id: 1, chat: { id: userId }, from: { id: userId }, text } });
  return lastSend(h.controlLog);
}

test('panel: full create-bot flow then per-bot panel actions', async () => {
  const h = makeHarness();
  const u = String(USER);

  // start -> main menu
  let r = await msgText(h, u, '/start');
  assert.ok(/BotMaker/.test(r.payload.text));

  // create new bot -> template list -> choose quiz -> choose free plan
  await msgText(h, u, '➕ ساخت ربات جدید');
  await h.controlBot.processUpdate({ update_id: 1, callback_query: { id: 'c1', from: { id: USER }, message: { chat: { id: USER } }, data: 'tpl:quiz' } });
  await h.controlBot.processUpdate({ update_id: 2, callback_query: { id: 'c2', from: { id: USER }, message: { chat: { id: USER } }, data: 'plan:quiz:free' } });
  // sends token
  await msgText(h, u, '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  const bots = db_of(h).listBotsByOwner(u);
  assert.strictEqual(bots.length, 1);
  assert.strictEqual(bots[0].plan_id, 'free');
  assert.ok(bots[0].config.demo);
  // demo marked used
  assert.ok(db_of(h).hasUsedDemo(u, 'quiz'));

  // second demo of same template -> skipped straight to paid plans
  await msgText(h, u, '➕ ساخت ربات جدید');
  await h.controlBot.processUpdate({ update_id: 3, callback_query: { id: 'c3', from: { id: USER }, message: { chat: { id: USER } }, data: 'tpl:quiz' } });
  r = lastSend(h.controlLog);
  assert.ok(/پرداختی/.test(r.payload.text), 'should skip to paid plans');

  // my bots -> panel -> toggle auto-renew
  await msgText(h, u, '📋 ربات‌های من');
  const botId = bots[0].id;
  await h.controlBot.processUpdate({ update_id: 4, callback_query: { id: 'c4', from: { id: USER }, message: { chat: { id: USER } }, data: `openpanel:${botId}` } });
  r = lastSend(h.controlLog);
  assert.ok(/وضعیت|پلن/.test(r.payload.text));

  await h.controlBot.processUpdate({ update_id: 5, callback_query: { id: 'c5', from: { id: USER }, message: { chat: { id: USER } }, data: `botpanel:autorenew:${botId}` } });
  assert.strictEqual(db_of(h).getBot(botId).auto_renew, 1);

  // pause -> webhook removed; resume -> webhook re-added
  await h.controlBot.processUpdate({ update_id: 6, callback_query: { id: 'c6', from: { id: USER }, message: { chat: { id: USER } }, data: `botpanel:pause:${botId}` } });
  assert.strictEqual(db_of(h).getBot(botId).status, 'paused');
  assert.ok(h.botLogs.get(botId).some((c) => c.method === 'deleteWebhook'));
  await h.controlBot.processUpdate({ update_id: 7, callback_query: { id: 'c7', from: { id: USER }, message: { chat: { id: USER } }, data: `botpanel:pause:${botId}` } });
  assert.strictEqual(db_of(h).getBot(botId).status, 'active');
  assert.ok(h.botLogs.get(botId).some((c) => c.method === 'setWebhook'));

  // reset bot data: confirm-first, wipes kv/collections but keeps registration
  const store = db_of(h).botStore(botId);
  await store.set('k', 'v');
  await store.save('stuff', { a: 1 });
  await h.controlBot.processUpdate({ update_id: 8, callback_query: { id: 'c8', from: { id: USER }, message: { chat: { id: USER } }, data: `botpanel:wipeconfirm:${botId}` } });
  await h.controlBot.processUpdate({ update_id: 9, callback_query: { id: 'c9', from: { id: USER }, message: { chat: { id: USER } }, data: `botpanel:wipe:${botId}` } });
  assert.strictEqual(await store.get('k'), null);
  assert.strictEqual((await store.find('stuff', {})).length, 0);
  assert.ok(db_of(h).getBot(botId), 'registration kept');

  // change token: validate getMe, re-encrypt, re-register webhook
  const oldEnc = db_of(h).getBot(botId).token_encrypted;
  await h.controlBot.processUpdate({ update_id: 10, callback_query: { id: 'c10', from: { id: USER }, message: { chat: { id: USER } }, data: `botpanel:changetoken:${botId}` } });
  await msgText(h, u, '999999:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB');
  const updated = db_of(h).getBot(botId);
  assert.notStrictEqual(updated.token_encrypted, oldEnc);
  assert.notStrictEqual(updated.secret_token, 'sec-orig');
  assert.ok(h.controlLog.some((c) => c.method === 'sendMessage' && /تغییر کرد/.test(c.payload.text)));

  // delete bot: confirm-first
  await h.controlBot.processUpdate({ update_id: 11, callback_query: { id: 'c11', from: { id: USER }, message: { chat: { id: USER } }, data: `botpanel:deleteconfirm:${botId}` } });
  await h.controlBot.processUpdate({ update_id: 12, callback_query: { id: 'c12', from: { id: USER }, message: { chat: { id: USER } }, data: `botpanel:delete:${botId}` } });
  assert.strictEqual(db_of(h).listBotsByOwner(u).length, 0);

  function db_of(hx) { return hx.db; }
});

test('panel: renew with insufficient balance shows exact shortfall + top-up button', async () => {
  const h = makeHarness();
  const u = String(USER);
  h.db.upsertUser(USER);
  h.db.createBot({
    id: 'pro1', owner_id: USER, token_encrypted: encrypt('1:' + 'A'.repeat(35), ENC),
    secret_token: 's1', username: 'probot', template_id: 'shop', plan_id: 'pro',
    status: 'active', expires_at: 5_000_000_000 + 86400000
  });
  await h.controlBot.processUpdate({ update_id: 1, callback_query: { id: 'r1', from: { id: USER }, message: { chat: { id: USER } }, data: 'botpanel:renew:pro1' } });
  const r = lastSend(h.controlLog);
  assert.ok(/کمبود/.test(r.payload.text));
  assert.ok(/۲۰۰٬۰۰۰|200,000/.test(r.payload.text), 'amount shown');
  assert.ok(r.payload.reply_markup.inline_keyboard.some((row) => row.some((b) => (b.callback_data || '') === 'wallet:topup')));
});
