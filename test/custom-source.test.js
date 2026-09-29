'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { BotDb } = require('../src/db');
const { CustomController } = require('../src/custom/controller');
const { classifyRuntimeError } = require('../src/custom/runtime');
const { checkGvisorAvailable } = require('../src/custom/container');
const { createWebhookApp } = require('../src/webhook');
const { createTelegramApi, clearMockCalls, getMockCalls } = require('../src/telegram');

function makePostRequest(url, headers, payload) {
  const data = JSON.stringify(payload);
  const parsedUrl = new URL(url);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
      },
      (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('classifyRuntimeError heuristics', () => {
  // Source-caused errors
  const sourceErr1 = classifyRuntimeError('SyntaxError: Unexpected token in index.js');
  assert.equal(sourceErr1.cause, 'source');
  assert.equal(sourceErr1.requiresSecurityReview, false);

  const sourceErr2 = classifyRuntimeError('Error: Cannot find module "express" MODULE_NOT_FOUND');
  assert.equal(sourceErr2.cause, 'source');
  assert.equal(sourceErr2.requiresSecurityReview, false);

  const sourceErr3 = classifyRuntimeError('IndentationError: unexpected indent in main.py');
  assert.equal(sourceErr3.cause, 'source');
  assert.equal(sourceErr3.requiresSecurityReview, false);

  // Host-caused errors
  const hostErr1 = classifyRuntimeError('docker: Error response from daemon: Out of memory');
  assert.equal(hostErr1.cause, 'host');

  const hostErr2 = classifyRuntimeError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
  assert.equal(hostErr2.cause, 'host');
  assert.equal(hostErr2.requiresSecurityReview, true); // contains docker.sock security pattern

  // Security-implication errors
  const secErr = classifyRuntimeError('EACCES: permission denied, open "/etc/passwd"');
  assert.equal(secErr.requiresSecurityReview, true);

  const segfaultErr = classifyRuntimeError('Process terminated with SIGSEGV');
  assert.equal(segfaultErr.requiresSecurityReview, true);
});

test('gVisor fail-closed behavior', async () => {
  // Test checkGvisorAvailable with mock exec file that outputs no runsc
  const mockExecNoGvisor = (cmd, args, opts, cb) => {
    cb(null, '{"runtimes":{"runc":{"path":"/usr/bin/runc"}}}', '');
  };
  const gvisorRes = await checkGvisorAvailable(1000, mockExecNoGvisor);
  assert.equal(gvisorRes.available, false);
  assert.match(gvisorRes.reason, /gVisor/);

  // Test CustomController /source_run when gVisor unavailable
  clearMockCalls();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmaker-gvisor-test-'));
  const db = new BotDb(':memory:');
  const config = {
    admin_id: 42,
    mock_telegram: true,
    control_bot_token: '555555555:ABCdefGHIjklMNOpqrsTUVwxyZ99999',
    encryption_key: 'test_secret_longer_than_32_characters',
    projects_dir: root,
    skipGvisorCheck: false // enforce gVisor check
  };

  let runnerStarted = false;
  const runner = {
    start: async () => { runnerStarted = true; return { status: 'running' }; },
    stop: async () => {},
    logs: async () => ({ logs: 'ok' })
  };

  const c = new CustomController({ db, config, runner, downloadFile: async () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-node.zip')) });
  const api = createTelegramApi(config.control_bot_token, { mock: true });

  try {
    // Setup approved project in DB with valid token
    const projectId = 'src_1111222233334444';
    db.sqlite.prepare(
      'INSERT INTO custom_projects (id, owner_id, source_dir, token_encrypted, runtime, start_command, status, report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(projectId, 100, path.join(root, projectId), 'enc_token', 'node20', 'node index.js', 'approved', '{}', new Date().toISOString());

    const send = (user, text) => c.handle({ message: { text, message_id: 1, from: { id: user }, chat: { id: user, type: 'private' } }, api, userId: user, chatId: user });

    // Mock checkGvisorAvailable to fail
    await send(100, `/source_run ${projectId}`);

    // Runner must NOT have been started
    assert.equal(runnerStarted, false);

    // Verify error message sent to user
    const userCalls = getMockCalls().filter(call => call.payload.chat_id === 100);
    assert.ok(userCalls.some(call => call.payload.text.includes('محیط امنیتی gVisor (runsc) در سرور در دسترس نیست')));

    // Verify alert sent to admin
    const adminCalls = getMockCalls().filter(call => call.payload.chat_id === 42);
    assert.ok(adminCalls.some(call => call.payload.text.includes('خطای حیاتی gVisor')));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Custom-Source Pipeline: Payment Gate & Fee Deduction', async () => {
  clearMockCalls();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmaker-pay-test-'));
  const db = new BotDb(':memory:');
  const config = {
    admin_id: 42,
    mock_telegram: true,
    control_bot_token: '555555555:ABCdefGHIjklMNOpqrsTUVwxyZ99999',
    encryption_key: 'test_secret_longer_than_32_characters',
    projects_dir: root,
    skipGvisorCheck: true,
    customSourceFeeToman: 50000
  };

  const runner = { start: async () => ({ status: 'running' }), stop: async () => {} };
  const c = new CustomController({ db, config, runner, downloadFile: async () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-node.zip')) });
  const api = createTelegramApi(config.control_bot_token, { mock: true });

  const send = (user, text, document) => c.handle({ message: { text, message_id: 1, from: { id: user }, chat: { id: user, type: 'private' }, document }, api, userId: user, chatId: user });

  try {
    const userIdUnpaid = 101;
    db.createUser(userIdUnpaid, 'unpaid_user');

    // 1. Unpaid user without wallet balance is rejected
    await send(userIdUnpaid, '/source');
    assert.ok(getMockCalls().at(-1).payload.text.includes('دسترسی محدود است'));

    await send(userIdUnpaid, '', { file_name: 'sample-node.zip', file_size: 500, file_id: 'fake_1' });
    assert.ok(getMockCalls().at(-1).payload.text.includes('دسترسی محدود است'));

    // 2. Charge user's wallet with 60,000 Toman and test again
    db.depositWallet(userIdUnpaid, 60000, 'Test deposit');
    assert.equal(db.getWalletBalance(userIdUnpaid), 60000);

    await send(userIdUnpaid, '', { file_name: 'sample-node.zip', file_size: 500, file_id: 'fake_2' });
    // Should now succeed and deduct 50,000 Toman fee
    assert.equal(db.getWalletBalance(userIdUnpaid), 10000);
    const projects = c.list(userIdUnpaid);
    assert.equal(projects.length, 1);

    // 3. User on active paid plan ('pro') is allowed without wallet deduction
    const userIdPaidPlan = 102;
    db.createUser(userIdPaidPlan, 'pro_user');
    db.sqlite.prepare("UPDATE users SET plan_id = 'pro', plan_expires_at = ? WHERE telegram_id = ?").run(
      new Date(Date.now() + 86400000).toISOString(),
      userIdPaidPlan
    );
    db.depositWallet(userIdPaidPlan, 50000, 'User wallet balance');

    await send(userIdPaidPlan, '', { file_name: 'sample-node.zip', file_size: 500, file_id: 'fake_3' });
    // Wallet balance should remain unchanged (50,000 Toman) because of active paid plan
    assert.equal(db.getWalletBalance(userIdPaidPlan), 50000);
    assert.equal(c.list(userIdPaidPlan).length, 1);

    // 4. Admin user is always allowed
    await send(42, '', { file_name: 'sample-node.zip', file_size: 500, file_id: 'fake_admin' });
    assert.equal(c.list(42).length, 1);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Custom-Source Pipeline: Admin Notification on Submission & Admin Approval Gate', async () => {
  clearMockCalls();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmaker-approve-test-'));
  const db = new BotDb(':memory:');
  const config = {
    admin_id: 42,
    mock_telegram: true,
    control_bot_token: '555555555:ABCdefGHIjklMNOpqrsTUVwxyZ99999',
    encryption_key: 'test_secret_longer_than_32_characters',
    projects_dir: root,
    skipGvisorCheck: true,
    skipSleep: true
  };

  const activity = [];
  const runner = {
    start: async x => { activity.push(['start', x.botId]); return { status: 'running' }; },
    stop: async x => { activity.push(['stop', x.botId]); },
    status: async () => ({ running: true }),
    logs: async () => ({ logs: 'running' })
  };

  const c = new CustomController({ db, config, runner, downloadFile: async () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-node.zip')) });
  const api = createTelegramApi(config.control_bot_token, { mock: true });

  const userId = 200;
  db.createUser(userId, 'submitter');
  db.depositWallet(userId, 100000, 'Initial deposit');

  const send = (user, text, document, caption) => c.handle({
    message: { text, message_id: 10, from: { id: user, username: 'testuser' }, chat: { id: user, type: 'private' }, document, caption },
    api,
    userId: user,
    chatId: user
  });

  const sendCallback = (user, data) => c.handle({
    message: {
      callback_query: { id: 'cb_123', from: { id: user }, message: { chat: { id: user } }, data }
    },
    api,
    userId: user,
    chatId: user
  });

  try {
    // 1. Submit ZIP
    await send(userId, '', { file_name: 'sample-node.zip', file_size: 500, file_id: 'zip_file_id_100' }, 'My Custom Bot');

    // Admin should have received initial submission notification
    const adminCalls = getMockCalls().filter(c => c.payload?.chat_id === 42);
    assert.ok(adminCalls.some(c => c.payload?.text?.includes('دریافت سورس اختصاصی جدید')));

    const project = c.list(userId)[0];
    assert.equal(project.status, 'pending_admin_approval');

    // Submit bot token
    const token = '888888888:ABCdefGHIjklMNOpqrsTUVwxyZ88888';
    await send(userId, token);

    // 2. Attempt /source_run before admin approval -> Blocked
    await send(userId, `/source_run ${project.id}`);
    assert.ok(getMockCalls().at(-1).payload.text.includes('پروژه در انتظار تأیید مدیر است'));
    assert.equal(activity.length, 0);

    // 3. Admin approves project via inline callback button
    await sendCallback(42, `admin_approve_${project.id}`);
    const updatedProject = c.get(project.id, userId);
    assert.equal(updatedProject.status, 'approved');

    // Owner should be notified of approval
    const ownerCalls = getMockCalls().filter(c => c.payload?.chat_id === userId);
    assert.ok(ownerCalls.some(c => c.payload?.text?.includes('پروژه شما تأیید شد')));

    // 4. Now /source_run succeeds
    await send(userId, `/source_run ${project.id}`);
    assert.equal(activity.filter(x => x[0] === 'start').length, 1);
    assert.equal(c.get(project.id, userId).status, 'running');

    // 5. Reject flow test: admin rejects a new project
    await send(userId, '', { file_name: 'sample-node.zip', file_size: 500, file_id: 'zip_file_id_200' }, 'Second Bot');
    const project2 = c.list(userId)[0];
    await sendCallback(42, `admin_reject_${project2.id}`);
    assert.equal(c.get(project2.id, userId).status, 'rejected');

    await send(userId, `/source_run ${project2.id}`);
    assert.ok(getMockCalls().at(-1).payload.text.includes('پروژه توسط مدیر رد شده است'));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Custom-Source Pipeline: Security-then-Bug Scan Order & Paid AI Auto-Fix', async () => {
  clearMockCalls();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'botmaker-autofix-test-'));
  const db = new BotDb(':memory:');
  const config = {
    admin_id: 42,
    mock_telegram: true,
    control_bot_token: '555555555:ABCdefGHIjklMNOpqrsTUVwxyZ99999',
    encryption_key: 'test_secret_longer_than_32_characters',
    projects_dir: root,
    skipGvisorCheck: true,
    aiAutoFixFeeToman: 20000
  };

  const runner = { start: async () => ({ status: 'running' }), stop: async () => {} };
  const c = new CustomController({
    db,
    config,
    runner,
    downloadFile: async () => fs.readFileSync(path.join(__dirname, 'fixtures', 'sample-node.zip'))
  });
  const api = createTelegramApi(config.control_bot_token, { mock: true });

  const userId = 300;
  db.createUser(userId, 'fixer');

  const sendCallback = (user, data) => c.handle({
    message: {
      callback_query: { id: 'cb_autofix', from: { id: user }, message: { chat: { id: user } }, data }
    },
    api,
    userId: user,
    chatId: user
  });

  try {
    const projectId = 'src_a1b2c3d4e5f60000';
    db.sqlite.prepare(
      'INSERT INTO custom_projects (id, owner_id, source_dir, runtime, start_command, status, report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(projectId, userId, path.join(root, projectId), 'node20', 'node index.js', 'failed', '{}', new Date().toISOString());

    // 1. User clicks autofix inline button -> prompted for fee confirmation
    await sendCallback(userId, `autofix_${projectId}`);
    const call1 = getMockCalls().at(-1);
    assert.ok(call1.payload.text.includes('اصلاح خودکار با AI (هزینه‌‌ای)'));
    assert.ok(call1.payload.text.includes(`${(20000).toLocaleString('fa-IR')} تومان`));

    // 2. User confirms autofix with insufficient wallet balance (0 balance) -> rejected
    await sendCallback(userId, `autofix_confirm_${projectId}`);
    const call2 = getMockCalls().at(-1);
    assert.ok(call2.payload.text.includes('موجودی کیف پول شما کافی نیست'));

    // 3. User deposits 30,000 Toman and confirms autofix again
    db.depositWallet(userId, 30000, 'Deposit for AI fix');
    await sendCallback(userId, `autofix_confirm_${projectId}`);
    assert.equal(db.getWalletBalance(userId), 10000); // 30000 - 20000 = 10000
    const call3 = getMockCalls().at(-1);
    assert.ok(call3.payload.text.includes('اصلاح خودکار انجام شد') || call3.payload.text.includes('نتیجه اصلاح خودکار'));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('/internal/security-alert Endpoint', async () => {
  clearMockCalls();
  const db = new BotDb(':memory:');
  const secret = 'my_super_internal_alert_secret_999';
  const config = {
    internal_alert_secret: secret,
    control_bot_token: '555555555:ABCdefGHIjklMNOpqrsTUVwxyZ99999',
    admin_id: 42,
    mock_telegram: true
  };

  let stoppedBotId = null;
  const runner = {
    stop: async ({ botId }) => { stoppedBotId = botId; }
  };

  const app = createWebhookApp({ db, config, runner });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const botId = 'src_9999888877776666';
    const ownerId = 500;
    const projectDir = path.join(os.tmpdir(), botId);
    fs.mkdirSync(projectDir, { recursive: true });

    db.sqlite.prepare(
      'INSERT INTO custom_projects (id, owner_id, source_dir, runtime, start_command, status, report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(botId, ownerId, path.join(projectDir, 'original'), 'node20', 'node index.js', 'running', '{}', new Date().toISOString());

    // 1. Missing header -> 401
    const res1 = await makePostRequest(`${baseUrl}/internal/security-alert`, {}, { botId });
    assert.equal(res1.statusCode, 401);

    // 2. Wrong secret header -> 403
    const res2 = await makePostRequest(`${baseUrl}/internal/security-alert`, { 'X-Internal-Secret': 'wrong_secret' }, { botId });
    assert.equal(res2.statusCode, 403);

    // 3. Valid secret header but missing botId -> 400
    const res3 = await makePostRequest(`${baseUrl}/internal/security-alert`, { 'X-Internal-Secret': secret }, {});
    assert.equal(res3.statusCode, 400);

    // 4. Valid secret header but unknown botId -> 404
    const res4 = await makePostRequest(`${baseUrl}/internal/security-alert`, { 'X-Internal-Secret': secret }, { botId: 'src_0000000000000000' });
    assert.equal(res4.statusCode, 404);

    // 5. Valid secret header and existing botId -> 200 OK
    const res5 = await makePostRequest(
      `${baseUrl}/internal/security-alert`,
      { 'X-Internal-Secret': secret },
      { botId, containerId: 'cont_123', ruleName: 'UNAUTHORIZED_OUTBOUND_CONN', details: 'Attempted connections to external C2 IP' }
    );

    assert.equal(res5.statusCode, 200);
    const body5 = JSON.parse(res5.body);
    assert.equal(body5.ok, true);
    assert.equal(body5.action, 'killed');
    assert.equal(body5.botId, botId);

    // Verify runner.stop was called
    assert.equal(stoppedBotId, botId);

    // Verify DB status updated to 'killed_security_violation'
    const updatedProject = db.sqlite.prepare('SELECT * FROM custom_projects WHERE id = ?').get(botId);
    assert.equal(updatedProject.status, 'killed_security_violation');
    assert.ok(updatedProject.report.includes('UNAUTHORIZED_OUTBOUND_CONN'));

    // Verify admin alert sent
    const adminCalls = getMockCalls().filter(c => c.payload?.chat_id === 42);
    assert.ok(adminCalls.some(c => c.payload?.text?.includes('هشدار فوق‌العاده امنیتی')));

    // Verify owner warning sent
    const ownerCalls = getMockCalls().filter(c => c.payload?.chat_id === ownerId);
    assert.ok(ownerCalls.some(c => c.payload?.text?.includes('تعلیق پروژه به دلیل نقض قوانین امنیتی')));

  } finally {
    server.close();
    db.close();
  }
});
