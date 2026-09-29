'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BotDb } = require('../src/db');
const { AdminController } = require('../src/admin');
const { createTelegramApi, clearMockCalls, getMockCalls } = require('../src/telegram');

function makeAdmin() {
  const db = new BotDb(':memory:');
  const config = {
    admin_id: 9999,
    max_bots_per_user: 3,
    encryption_key: 'test_admin_enc_key_32bytes_long!',
    mock_telegram: true,
    control_bot_token: '000000000:ControlBotTokenABCdefGHIjklMNO',
    public_base_url: 'https://test-domain.com'
  };
  const adminController = new AdminController({ db, config });
  const mockApi = createTelegramApi(config.control_bot_token, { mock: true });
  return { adminController, mockApi, adminId: config.admin_id };
}

test('Plan Manager: add a new plan via the one-line format', async () => {
  const { adminController, mockApi, adminId } = makeAdmin();
  const chatId = adminId;

  adminController.userStates.set(adminId, { step: 'awaiting_plan_line' });
  clearMockCalls();
  await adminController.handleUpdate({
    update: { message: { from: { id: adminId }, chat: { id: chatId }, text: 'vip|پلن VIP|150000|10|30|دسترسی کامل' } },
    api: mockApi
  });

  const plan = adminController.db.getPlanById('vip');
  assert.ok(plan);
  assert.equal(plan.name, 'پلن VIP');
  assert.equal(plan.price, 150000);
  assert.equal(plan.max_bots, 10);
  assert.equal(plan.duration_days, 30);
  assert.equal(plan.description, 'دسترسی کامل');

  const calls = getMockCalls().filter(c => c.method === 'sendMessage');
  assert.ok(calls.some(c => /ذخیره شد/.test(c.payload.text)), 'expected a confirmation message containing ذخیره شد');
  assert.equal(adminController.userStates.has(adminId), false);
});

test('Plan Manager: editing an existing id updates it in place (no duplicate)', async () => {
  const { adminController, mockApi, adminId } = makeAdmin();
  await adminController.handlePlanLineInput(mockApi, adminId, adminId, 'vip|پلن VIP|150000|10|30|desc');
  await adminController.handlePlanLineInput(mockApi, adminId, adminId, 'vip|پلن VIP طلایی|200000|20|30|desc2');

  const plans = adminController.db.getPlans().filter(p => p.id === 'vip');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].name, 'پلن VIP طلایی');
  assert.equal(plans[0].price, 200000);
});

test('Plan Manager: rejects malformed lines without creating a plan', async () => {
  const { adminController, mockApi, adminId } = makeAdmin();
  clearMockCalls();
  await adminController.handlePlanLineInput(mockApi, adminId, adminId, 'not-enough-fields');
  assert.equal(adminController.db.getPlanById('not-enough-fields'), null);

  const calls = getMockCalls().filter(c => c.method === 'sendMessage');
  assert.match(calls[calls.length - 1].payload.text, /فرمت نادرست/);
});

test('Plan Manager: cannot delete a plan currently used by an active bot', async () => {
  const { adminController, adminId } = makeAdmin();
  adminController.db.savePlan({ id: 'basic', name: 'Basic', price: 10000, maxBots: 1, durationDays: 30, description: '' });
  adminController.db.registerUser(1111);
  adminController.db.createBot({
    ownerId: 1111,
    token: '111111111:AAAdefGHIjklMNOpqrsTUVwxyZ111111',
    templateId: 'shop',
    planId: 'basic',
    encryptionKey: 'test_admin_enc_key_32bytes_long!'
  });

  assert.throws(() => adminController.db.deletePlan('basic'), /PLAN_IN_USE/);
  assert.ok(adminController.db.getPlanById('basic'));
});

test('Plan Manager: deletes an unused plan successfully', async () => {
  const { adminController } = makeAdmin();
  adminController.db.savePlan({ id: 'unused', name: 'Unused', price: 5000, maxBots: 1, durationDays: 30, description: '' });
  const removed = adminController.db.deletePlan('unused');
  assert.equal(removed, true);
  assert.equal(adminController.db.getPlanById('unused'), null);
});
