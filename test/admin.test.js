'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BotDb } = require('../src/db');
const { AdminController } = require('../src/admin');
const { createTelegramApi, clearMockCalls, getMockCalls } = require('../src/telegram');

test('Control Bot Persian Flow & Admin Actions', async () => {
  clearMockCalls();
  const db = new BotDb(':memory:');
  const config = {
    admin_id: 8888,
    max_bots_per_user: 2,
    encryption_key: 'test_admin_enc_key_32bytes_long!',
    mock_telegram: true,
    public_base_url: 'https://test-domain.com'
  };

  const adminController = new AdminController({ db, config });
  const mockApi = createTelegramApi('000000000:ControlBotTokenABCdefGHIjklMNO', { mock: true });

  const regularUserId = 1234;
  const chatId = 1234;

  // 1. Send /start
  await adminController.handleUpdate({
    update: { message: { from: { id: regularUserId }, chat: { id: chatId }, text: '/start' } },
    api: mockApi
  });

  const calls = getMockCalls();
  assert.ok(calls.length > 0);
  const startMsg = calls[calls.length - 1];
  assert.equal(startMsg.method, 'sendMessage');
  assert.match(startMsg.payload.text, /سلام! به ربات‌ساز/);

  // 2. Start Bot Creation (/create_bot)
  clearMockCalls();
  await adminController.handleUpdate({
    update: { message: { from: { id: regularUserId }, chat: { id: chatId }, text: '/create_bot' } },
    api: mockApi
  });
  const createCalls = getMockCalls();
  assert.match(createCalls[0].payload.text, /لطفاً قالب مورد نظر خود را برای ربات انتخاب کنید/);

  // 3. Select Template 'shop'
  clearMockCalls();
  await adminController.handleUpdate({
    update: { message: { from: { id: regularUserId }, chat: { id: chatId }, text: 'shop' } },
    api: mockApi
  });
  const tplCalls = getMockCalls();
  assert.match(tplCalls[0].payload.text, /انتخاب شد/);

  // 4. Send Valid Token
  clearMockCalls();
  const userBotToken = '777777777:ABCdefGHIjklMNOpqrsTUVwxyZ77777';
  await adminController.handleUpdate({
    update: { message: { from: { id: regularUserId }, chat: { id: chatId }, text: userBotToken } },
    api: mockApi
  });
  const tokenCalls = getMockCalls();
  // Expect getMe, setWebhook, sendMessage
  const createdBotMsg = tokenCalls.find(c => c.method === 'sendMessage');
  assert.ok(createdBotMsg);
  assert.match(createdBotMsg.payload.text, /ربات شما با موفقیت ساخته و فعال شد/);

  // Verify Bot is created in DB
  const userBots = db.getUserBots(regularUserId);
  assert.equal(userBots.length, 1);
  assert.equal(userBots[0].template_id, 'shop');

  // 5. Admin Stats permission check
  // Regular user attempt
  clearMockCalls();
  await adminController.handleUpdate({
    update: { message: { from: { id: regularUserId }, chat: { id: chatId }, text: '/admin_stats' } },
    api: mockApi
  });
  const regAdminCalls = getMockCalls();
  assert.match(regAdminCalls[0].payload.text, /دسترسی به بخش مدیریت سیستم را ندارید/);

  // Admin user attempt
  clearMockCalls();
  await adminController.handleUpdate({
    update: { message: { from: { id: 8888 }, chat: { id: 8888 }, text: '/admin_stats' } },
    api: mockApi
  });
  const realAdminCalls = getMockCalls();
  assert.match(realAdminCalls[0].payload.text, /آمار مدیریتی BotMaker v2/);

  db.close();
});
