'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BotDb } = require('../src/db');
const { runLifecycleCheck } = require('../src/lifecycle');
const { AdminController } = require('../src/admin');
const { createTelegramApi, clearMockCalls, getMockCalls } = require('../src/telegram');

test('Wallet Operations - Deposit, Charge, Transactions & Insufficient Funds', async () => {
  const db = new BotDb(':memory:');
  const userId = 1001;

  // Initial balance should be 0
  assert.equal(db.getWalletBalance(userId), 0);

  // Deposit 150,000 Toman
  const bal1 = db.addWalletBalance(userId, 150000, 'deposit', 'شارژ اولیه');
  assert.equal(bal1, 150000);
  assert.equal(db.getWalletBalance(userId), 150000);

  // Charge 50,000 Toman
  const bal2 = db.chargeWallet(userId, 50000, 'خرید پلن');
  assert.equal(bal2, 100000);
  assert.equal(db.getWalletBalance(userId), 100000);

  // Check transaction log
  const txs = db.getWalletTransactions(userId);
  assert.equal(txs.length, 2);
  assert.equal(txs[0].type, 'charge');
  assert.equal(txs[1].type, 'deposit');

  // Charge exceeding balance should throw INSUFFICIENT_BALANCE
  assert.throws(() => {
    db.chargeWallet(userId, 200000, 'خرید پلن سنگین');
  }, /INSUFFICIENT_BALANCE/);

  db.close();
});

test('Plans Seeding & Bot Plan Assignment', async () => {
  const db = new BotDb(':memory:');
  const userId = 1002;

  const plans = db.getPlans();
  assert.equal(plans.length, 3);
  assert.ok(plans.some(p => p.id === 'free'));
  assert.ok(plans.some(p => p.id === 'pro'));
  assert.ok(plans.some(p => p.id === 'vip'));

  // Create a bot
  const bot = db.createBot({
    ownerId: userId,
    token: '111111111:ABCdefGHIjklMNOpqrsTUVwxyZ11111',
    username: 'TestPlanBot',
    templateId: 'shop',
    encryptionKey: 'test_admin_enc_key_32bytes_long!'
  });

  assert.equal(bot.plan_id, 'free');
  assert.ok(bot.expires_at);

  // Set bot plan to 'pro'
  const updatedBot = db.setBotPlan(bot.id, 'pro', 30);
  assert.equal(updatedBot.plan_id, 'pro');

  db.close();
});

test('Subscription Lifecycle Job - Auto-Renewal and Expiration Pausing', async () => {
  const db = new BotDb(':memory:');
  const userId = 1003;
  const config = {
    encryption_key: 'test_admin_enc_key_32bytes_long!',
    mock_telegram: true
  };

  // 1. Bot with Free Plan (Price 0) - Should auto renew for free
  const botFree = db.createBot({
    ownerId: userId,
    token: '222222222:ABCdefGHIjklMNOpqrsTUVwxyZ22222',
    username: 'FreeBot',
    templateId: 'shop',
    encryptionKey: config.encryption_key
  });

  // Set expires_at in the past
  db.sqlite.prepare("UPDATE bots SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 3600000).toISOString(), botFree.id);

  let res = await runLifecycleCheck({ db, config });
  assert.equal(res.renewed.length, 1);
  assert.equal(res.renewed[0].botId, botFree.id);

  // 2. Bot with Pro Plan (Price 100,000) & Sufficient Balance -> Auto Renew
  db.addWalletBalance(userId, 100000, 'deposit', 'شارژ برای تمدید');
  db.setBotPlan(botFree.id, 'pro', 30);
  db.sqlite.prepare("UPDATE bots SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 3600000).toISOString(), botFree.id);

  res = await runLifecycleCheck({ db, config });
  assert.equal(res.renewed.length, 1);
  assert.equal(db.getWalletBalance(userId), 0); // Balance deducted
  const renewedBot = db.getBotById(botFree.id);
  assert.equal(renewedBot.status, 'active');
  assert.ok(new Date(renewedBot.expires_at) > new Date());

  // 3. Bot with Pro Plan & Insufficient Balance -> Paused
  db.sqlite.prepare("UPDATE bots SET expires_at = ? WHERE id = ?").run(new Date(Date.now() - 3600000).toISOString(), botFree.id);
  res = await runLifecycleCheck({ db, config });
  assert.equal(res.paused.length, 1);
  const pausedBot = db.getBotById(botFree.id);
  assert.equal(pausedBot.status, 'paused');

  db.close();
});

test('Support Tickets - Create, Reply, Close & Master Admin Console', async () => {
  clearMockCalls();
  const db = new BotDb(':memory:');
  const adminId = 8888;
  const userId = 1004;
  const config = {
    admin_id: adminId,
    max_bots_per_user: 5,
    encryption_key: 'test_admin_enc_key_32bytes_long!',
    mock_telegram: true
  };

  const adminController = new AdminController({ db, config });
  const mockApi = createTelegramApi('000000000:ControlBotTokenABCdefGHIjklMNO', { mock: true });

  // 1. User opens Support Ticket
  const ticket = db.createSupportTicket({
    userId,
    subject: 'مشکل در پرداخت',
    message: 'سلام، کیف پول شارژ نشد.'
  });

  assert.equal(ticket.subject, 'مشکل در پرداخت');
  assert.equal(ticket.status, 'open');
  assert.equal(ticket.messages.length, 1);

  // 2. Admin views open tickets via /admin_tickets
  clearMockCalls();
  await adminController.handleUpdate({
    update: { message: { from: { id: adminId }, chat: { id: adminId }, text: '/admin_tickets' } },
    api: mockApi
  });
  const calls1 = getMockCalls();
  assert.match(calls1[0].payload.text, /تیکت‌های باز/);

  // 3. Admin replies to ticket via /admin_reply
  clearMockCalls();
  await adminController.handleUpdate({
    update: { message: { from: { id: adminId }, chat: { id: adminId }, text: `/admin_reply ${ticket.id} سلام، پیگیری شد.` } },
    api: mockApi
  });

  const updatedTicket = db.getTicketById(ticket.id);
  assert.equal(updatedTicket.status, 'replied');
  assert.equal(updatedTicket.messages.length, 2);

  // 4. Admin adjusts User Wallet via /admin_wallet
  clearMockCalls();
  await adminController.handleUpdate({
    update: { message: { from: { id: adminId }, chat: { id: adminId }, text: `/admin_wallet ${userId} 250000` } },
    api: mockApi
  });
  assert.equal(db.getWalletBalance(userId), 250000);

  // 5. Admin opens Master Console via /admin
  clearMockCalls();
  await adminController.handleUpdate({
    update: { message: { from: { id: adminId }, chat: { id: adminId }, text: '/admin' } },
    api: mockApi
  });
  const calls2 = getMockCalls();
  assert.match(calls2[0].payload.text, /پنل مدیریت ارشد/);

  // 6. User accesses /wallet menu and deposits preset
  clearMockCalls();
  await adminController.handleUpdate({
    update: { message: { from: { id: userId }, chat: { id: userId }, text: '/wallet' } },
    api: mockApi
  });
  const walletCalls = getMockCalls();
  assert.match(walletCalls[0].payload.text, /کیف پول و حساب کاربری/);

  // Deposit preset via callback query
  await adminController.handleCallbackQuery({
    callbackQuery: {
      id: 'cb_123',
      from: { id: userId },
      message: { chat: { id: userId } },
      data: 'wallet:deposit_preset:50000'
    },
    api: mockApi
  });

  assert.equal(db.getWalletBalance(userId), 300000);

  db.close();
});
