'use strict';
// Regression: the admin's ✅ approve / ❌ reject buttons for a user's custom source
// are sent by CustomController but were never routed to it by AdminController.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BotDb } = require('../src/db');
const { AdminController } = require('../src/admin');
const { createTelegramApi, clearMockCalls, getMockCalls } = require('../src/telegram');

const ADMIN = 42, USER = 77;

async function setup() {
  clearMockCalls();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-btn-'));
  const db = new BotDb(':memory:');
  const config = { skipSleep: true, admin_id: ADMIN, lab_mode: true, mock_telegram: true, control_bot_token: '555555555:ABCdefGHIjklMNOpqrsTUVwxyZ99999', encryption_key: 'test_secret_longer_than_32_characters', projects_dir: root, skipGvisorCheck: true };
  const admin = new AdminController({ db, config });
  admin.custom.downloadFile = async () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-node.zip'));
  const api = createTelegramApi(config.control_bot_token, { mock: true });
  db.sqlite.prepare("INSERT OR IGNORE INTO users (telegram_id, wallet_balance, created_at) VALUES (?,?,?)").run(USER, 10000000, new Date().toISOString());
  // user submits a source -> project is created and the admin receives the buttons
  await admin.custom.handle({ message: { text: '/source', message_id: 1, from: { id: USER }, chat: { id: USER, type: 'private' } }, api, userId: USER, chatId: USER });
  await admin.custom.handle({ message: { text: '', message_id: 2, from: { id: USER }, chat: { id: USER, type: 'private' }, document: { file_name: 'sample-node.zip', file_size: 500, file_id: 'f' } }, api, userId: USER, chatId: USER });
  const project = admin.custom.list(USER)[0];
  const press = data => admin.handleCallbackQuery({ callbackQuery: { id: 'cq', data, from: { id: ADMIN }, message: { chat: { id: ADMIN }, message_id: 9 } }, api });
  const pressAs = (uid, data) => admin.handleCallbackQuery({ callbackQuery: { id: 'cq', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 9 } }, api });
  return { admin, api, project, press, pressAs, db };
}

test('admin receives approve/reject buttons after a user submits a source', async () => {
  const { project } = await setup();
  assert.ok(project && project.status === 'pending_admin_approval');
  const msg = getMockCalls().find(c => c.method === 'sendMessage' && c.payload.chat_id === ADMIN && c.payload.reply_markup);
  const btns = msg.payload.reply_markup.inline_keyboard.flat().map(b => b.callback_data);
  assert.deepEqual(btns, [`admin_approve_${project.id}`, `admin_reject_${project.id}`]);
});

test('pressing ✅ approve marks the project approved and notifies the user', async () => {
  const { admin, project, press } = await setup();
  await press(`admin_approve_${project.id}`);
  assert.equal(admin.custom.get(project.id, ADMIN).status, 'approved');
  const toUser = getMockCalls().filter(c => c.method === 'sendMessage' && c.payload.chat_id === USER).pop();
  assert.match(toUser.payload.text, /پروژه شما تأیید شد/);
});

test('pressing ❌ reject marks the project rejected and notifies the user', async () => {
  const { admin, project, press } = await setup();
  await press(`admin_reject_${project.id}`);
  assert.equal(admin.custom.get(project.id, ADMIN).status, 'rejected');
  const toUser = getMockCalls().filter(c => c.method === 'sendMessage' && c.payload.chat_id === USER).pop();
  assert.match(toUser.payload.text, /پروژه شما رد شد/);
});

test('a non-admin cannot approve by pressing (or forging) the button', async () => {
  const { admin, project, pressAs } = await setup();
  await pressAs(USER, `admin_approve_${project.id}`);
  assert.equal(admin.custom.get(project.id, ADMIN).status, 'pending_admin_approval');
});

test('after ✅ approve the owner can send the token and run the project (whole path)', async () => {
  const { admin, project, press } = await setup();
  await press(`admin_approve_${project.id}`);
  const started = [];
  // Swap the runner on the controller itself (Docker/gVisor do not exist in unit tests).
  admin.custom.runner = { start: async x => { started.push(x.botId); return { status: 'running' }; }, stop: async () => {}, logs: async () => ({ logs: '' }), status: async () => ({ running: true }) };
  const api = createTelegramApi('555555555:ABCdefGHIjklMNOpqrsTUVwxyZ99999', { mock: true });
  const send = text => admin.custom.handle({ message: { text, message_id: 5, from: { id: USER }, chat: { id: USER, type: 'private' } }, api, userId: USER, chatId: USER });
  await send('999999999:ABCdefGHIjklMNOpqrsTUVwxyZ99999');
  await send(`/source_run ${project.id}`);
  assert.equal(started.length, 1, 'runner started once');
  assert.equal(admin.custom.get(project.id, USER).status, 'running');
});

test('a rejected project cannot be run', async () => {
  const { admin, project, press } = await setup();
  await press(`admin_reject_${project.id}`);
  const started = [];
  admin.custom.runner = { start: async x => { started.push(x.botId); return { status: 'running' }; }, stop: async () => {}, logs: async () => ({ logs: '' }), status: async () => ({ running: true }) };
  const api = createTelegramApi('555555555:ABCdefGHIjklMNOpqrsTUVwxyZ99999', { mock: true });
  await admin.custom.handle({ message: { text: `/source_run ${project.id}`, message_id: 6, from: { id: USER }, chat: { id: USER, type: 'private' } }, api, userId: USER, chatId: USER });
  assert.equal(started.length, 0);
});

test('AI auto-fix buttons are routed too: ask -> cancel, and confirm with low balance is refused', async () => {
  const { admin, project, pressAs, db } = await setup();
  await pressAs(USER, `autofix_${project.id}`);
  const ask = getMockCalls().filter(c => c.method === 'sendMessage' && c.payload.chat_id === USER).pop();
  assert.match(ask.payload.text, /هزینه/);
  await pressAs(USER, `autofix_cancel_${project.id}`);
  assert.match(getMockCalls().filter(c => c.method === 'sendMessage' && c.payload.chat_id === USER).pop().payload.text, /لغو شد/);

  db.sqlite.prepare('UPDATE users SET wallet_balance=0 WHERE telegram_id=?').run(USER);
  await pressAs(USER, `autofix_confirm_${project.id}`);
  assert.match(getMockCalls().filter(c => c.method === 'sendMessage' && c.payload.chat_id === USER).pop().payload.text, /موجودی کیف پول شما کافی نیست/);
  assert.equal(db.getWalletBalance(USER), 0, 'no charge on refusal');
});

test('end to end through handleUpdate (the real webhook entry): press approve', async () => {
  const { admin, project, api } = await setup();
  await admin.handleUpdate({ update: { update_id: 1, callback_query: { id: 'cq', data: `admin_approve_${project.id}`, from: { id: ADMIN }, message: { chat: { id: ADMIN, type: 'private' }, message_id: 9 } } }, api });
  assert.equal(admin.custom.get(project.id, ADMIN).status, 'approved');
});
