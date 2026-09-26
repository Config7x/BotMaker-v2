'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const { createControlBot } = require('../src/admin');
const { TelegramApi } = require('../src/telegram');
const support = require('../src/support');
const { registry } = require('../src/templates/registry');

const OWNER = 1001;
const USER = 2002;

function makeHarness() {
  const db = createDb(':memory:');
  const controlLog = [];
  const controlApi = new TelegramApi('0:c', { mock: true, mockLog: controlLog });
  const cfg = { ENCRYPTION_KEY: 'k'.repeat(16), PUBLIC_URL: 'https://x.example', OWNER_TELEGRAM_ID: String(OWNER), CONTROL_BOT_TOKEN: '0:c' };
  const apiFor = () => new TelegramApi('0:b', { mock: true, mockLog: [] });
  const makeApi = (t) => new TelegramApi(t, { mock: true, mockLog: [] });
  const controlBot = createControlBot({ db, cfg, registry, apiFor, makeApi, controlApi, clock: { now: () => 1 } });
  return { db, controlBot, controlLog };
}

async function send(h, userId, text) {
  await h.controlBot.processUpdate({ update_id: (Math.random() * 1e9) | 0, message: { message_id: 1, chat: { id: userId }, from: { id: userId }, text } });
}
async function click(h, userId, data) {
  await h.controlBot.processUpdate({ update_id: (Math.random() * 1e9) | 0, callback_query: { id: 'cb', from: { id: userId }, message: { chat: { id: userId } }, data } });
}
function lastSend(h) {
  return [...h.controlLog].reverse().find((c) => c.method === 'sendMessage');
}

test('support: FAQ screen first; solved closes; still-need-help proceeds to ticket', async () => {
  const h = makeHarness();

  await send(h, USER, '🎫 پشتیبانی و تیکت');
  assert.ok(/قبل از ثبت تیکت/.test(lastSend(h).payload.text));

  // path 1: solved -> back to menu, NO ticket created
  await click(h, USER, 'support:solved');
  assert.strictEqual(h.db.listTickets('open').length, 0);

  // path 2: still need help -> subject -> message -> ticket created
  await send(h, USER, '🎫 پشتیبانی و تیکت');
  await click(h, USER, 'support:ticket');
  await send(h, USER, 'ربات جواب نمی‌دهد');
  await send(h, USER, 'بعد از ساخت وب‌هوک خطا می‌دهد');
  const tickets = h.db.listTickets('open');
  assert.strictEqual(tickets.length, 1);
  assert.strictEqual(tickets[0].subject, 'ربات جواب نمی‌دهد');
  const full = h.db.getTicket(tickets[0].id);
  assert.strictEqual(full.messages.length, 1);
  assert.strictEqual(full.messages[0].message, 'بعد از ساخت وب‌هوک خطا می‌دهد');
  assert.strictEqual(full.messages[0].sender_role, 'user');

  // owner notified
  assert.ok(h.controlLog.some((c) => c.method === 'sendMessage' && String(c.payload.chat_id) === String(OWNER) && /تیکت جدید/.test(c.payload.text)));

  // admin reply reaches the user; close works
  await click(h, OWNER, `admin:ticket:${tickets[0].id}`);
  await click(h, OWNER, `admin:ticketreply:${tickets[0].id}`);
  await send(h, OWNER, 'وب‌هوک را از پنل ثبت مجدد کنید');
  const t = h.db.getTicket(tickets[0].id);
  assert.strictEqual(t.messages.length, 2);
  assert.strictEqual(t.messages.filter((m) => m.sender_role === 'admin').length, 1);
  await click(h, OWNER, `admin:ticketclose:${tickets[0].id}`);
  assert.strictEqual(h.db.getTicket(tickets[0].id).status, 'closed');
});

test('support: FAQ covers the four common issues', () => {
  assert.ok(support.FAQ.length >= 4);
  assert.ok(support.FAQ.some((f) => f.q.includes('جواب نمی')));
  assert.ok(support.FAQ.some((f) => f.q.includes('شارژ')));
  assert.ok(support.FAQ.some((f) => f.q.includes('409')));
  assert.ok(support.FAQ.some((f) => f.q.includes('توکن')));
});
