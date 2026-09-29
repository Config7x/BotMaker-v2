'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
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

test('Previously-broken template buttons (universal_poster/multi_downloader/music_downloader) no longer say invalid', async () => {
  const { adminController, mockApi } = makeAdmin();
  const userId = 5555;
  const chatId = 5555;

  for (const templateId of ['universal_poster', 'multi_downloader', 'music_downloader']) {
    adminController.userStates.set(userId, { step: 'awaiting_template' });
    clearMockCalls();
    await adminController.handleUpdate({
      update: { callback_query: { id: 'cb1', from: { id: userId }, message: { chat: { id: chatId } }, data: `tpl:${templateId}` } },
      api: mockApi
    });
    const calls = getMockCalls();
    const sendMessageCalls = calls.filter(c => c.method === 'sendMessage');
    const lastMsg = sendMessageCalls[sendMessageCalls.length - 1];
    assert.ok(lastMsg, `expected a sendMessage for ${templateId}`);
    assert.doesNotMatch(lastMsg.payload.text, /نامعتبر/, `${templateId} should be accepted, got: ${lastMsg.payload.text}`);
    assert.match(lastMsg.payload.text, /انتخاب شد/);
  }
});

test('Custom Source menu button routes into the custom controller (not "invalid command")', async () => {
  const { adminController, mockApi, adminId } = makeAdmin();
  const chatId = adminId;

  clearMockCalls();
  await adminController.handleUpdate({
    update: { message: { from: { id: adminId }, chat: { id: chatId }, text: '🧪 سورس اختصاصی' } },
    api: mockApi
  });
  const calls = getMockCalls();
  const sendMessageCalls = calls.filter(c => c.method === 'sendMessage');
  assert.ok(sendMessageCalls.length > 0, 'expected at least one sendMessage reply');
  const lastMsg = sendMessageCalls[sendMessageCalls.length - 1];
  assert.doesNotMatch(lastMsg.payload.text, /دستور نامعتبر است/, `should not hit the invalid-command fallback, got: ${lastMsg.payload.text}`);
});

test('Template Manager: add, list, appear in create-bot keyboard, then remove', async () => {
  const { adminController, mockApi, adminId } = makeAdmin();
  const chatId = adminId;
  const zipPath = path.join(__dirname, 'fixtures', 'test_template.zip');

  // Add via TemplateManager directly (equivalent to what the ZIP-upload wizard step does)
  const row = await adminController.templates.addFromZip({
    id: 'smoke_test_tpl',
    name: 'قالب تست',
    description: 'برای تست خودکار',
    zipPath,
    addedBy: adminId
  });
  assert.equal(row.id, 'smoke_test_tpl');

  // Should now appear in the merged names map
  const names = adminController.getTemplateNames();
  assert.ok(Object.prototype.hasOwnProperty.call(names, 'smoke_test_tpl'));

  // Should be selectable via the normal template-selection flow (callback)
  const userId = 6666;
  adminController.userStates.set(userId, { step: 'awaiting_template' });
  clearMockCalls();
  await adminController.handleUpdate({
    update: { callback_query: { id: 'cb2', from: { id: userId }, message: { chat: { id: userId } }, data: 'tpl:smoke_test_tpl' } },
    api: mockApi
  });
  const calls = getMockCalls();
  const sendMessageCalls = calls.filter(c => c.method === 'sendMessage');
  const lastMsg = sendMessageCalls[sendMessageCalls.length - 1];
  assert.doesNotMatch(lastMsg.payload.text, /نامعتبر/);
  assert.match(lastMsg.payload.text, /قالب تست/);

  // Remove it
  const removed = adminController.templates.remove('smoke_test_tpl');
  assert.equal(removed, true);
  assert.equal(adminController.templates.exists('smoke_test_tpl'), false);
});

test('Template Manager: rejects duplicate id and missing entry point', async () => {
  const { adminController, adminId } = makeAdmin();
  const zipPath = path.join(__dirname, 'fixtures', 'test_template.zip');

  await adminController.templates.addFromZip({ id: 'dup_tpl', name: 'A', zipPath, addedBy: adminId });
  await assert.rejects(
    () => adminController.templates.addFromZip({ id: 'dup_tpl', name: 'B', zipPath, addedBy: adminId }),
    /قبلاً ثبت شده/
  );
  adminController.templates.remove('dup_tpl');
});
