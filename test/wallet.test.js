'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const wallet = require('../src/wallet');

test('wallet: credit, debit, shortfall messaging', () => {
  const db = createDb(':memory:');
  db.upsertUser(111);

  // starts at zero
  assert.strictEqual(wallet.getBalance(db, 111), 0);

  // insufficient: exact shortfall returned, no negative balance
  let r = wallet.debit(db, 111, 50000, 'purchase', 'test');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.shortfall, 50000);
  assert.strictEqual(wallet.getBalance(db, 111), 0);

  // top-up then purchase succeeds, balance never negative
  wallet.credit(db, 111, 100000, 'topup', 'admin approved');
  assert.strictEqual(wallet.getBalance(db, 111), 100000);
  r = wallet.debit(db, 111, 30000, 'purchase', 'plan');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(wallet.getBalance(db, 111), 70000);

  // transactions recorded with correct sign
  const txs = db.listTransactions(111);
  assert.strictEqual(txs.length, 2);
  assert.strictEqual(txs[0].amount, -30000);
  assert.strictEqual(txs[1].amount, 100000);
});

test('wallet: purchasePlan charges and sets expiry; shortfall blocks', () => {
  const db = createDb(':memory:');
  db.upsertUser(222);
  const now = Date.now();
  db.createBot({
    id: 'b1', owner_id: 222, token_encrypted: 'x', secret_token: 's1',
    username: 'bot1', template_id: 'quiz', plan_id: 'free', status: 'active'
  });

  // no balance -> shortfall with plan info
  let res = wallet.purchasePlan(db, { userId: 222, botId: 'b1', planId: 'pro', now });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.shortfall, 200000);
  assert.strictEqual(res.plan.id, 'pro');

  // credit and purchase -> active paid bot with 30-day expiry
  wallet.credit(db, 222, 200000, 'topup', '');
  res = wallet.purchasePlan(db, { userId: 222, botId: 'b1', planId: 'pro', now });
  assert.strictEqual(res.ok, true);
  const bot = db.getBot('b1');
  assert.strictEqual(bot.plan_id, 'pro');
  assert.strictEqual(bot.status, 'active');
  assert.strictEqual(bot.expires_at, now + 30 * 86400000);
  assert.strictEqual(wallet.getBalance(db, 222), 0);
});

test('wallet: auto-renewal renews silently or pauses with reason', () => {
  const db = createDb(':memory:');
  db.upsertUser(333);
  const now = Date.now();
  db.createBot({
    id: 'b2', owner_id: 333, token_encrypted: 'x', secret_token: 's2',
    username: 'bot2', template_id: 'shop', plan_id: 'pro', status: 'active',
    expires_at: now - 1000, auto_renew: true
  });

  // insufficient balance -> paused with shortfall
  let r = wallet.processRenewal(db, { bot: db.getBot('b2'), now });
  assert.strictEqual(r.action, 'paused_insufficient');
  assert.strictEqual(r.shortfall, 200000);
  assert.strictEqual(db.getBot('b2').status, 'paused');

  // re-activate with balance -> silent renewal
  db.updateBot('b2', { status: 'active' });
  wallet.credit(db, 333, 250000, 'topup', '');
  r = wallet.processRenewal(db, { bot: db.getBot('b2'), now });
  assert.strictEqual(r.action, 'renewed');
  assert.strictEqual(db.getBot('b2').expires_at, now + 30 * 86400000);
  assert.strictEqual(wallet.getBalance(db, 333), 50000);
});
