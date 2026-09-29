'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { start, stop, status, logs, setRunnerOptions, DockerRunner, ISOLATION_NOTICE } = require('../src/custom/runtime');

// Helper to create a temporary test source directory
function createTempBotSource(files = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
  const defaultFiles = {
    'manifest.json': JSON.stringify({ runtime: 'node20', start: 'node index.js' }),
    'index.js': 'console.log("bot running");'
  };
  const allFiles = { ...defaultFiles, ...files };
  for (const [filename, content] of Object.entries(allFiles)) {
    fs.writeFileSync(path.join(tmpDir, filename), content, 'utf8');
  }
  return tmpDir;
}

// Mock execFile recorder
function createMockExecFile() {
  const calls = [];

  const mockFn = (command, args, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    calls.push({ command, args, options });

    if (command !== 'docker') {
      return callback(new Error(`Unexpected binary call: ${command}`));
    }

    const subCmd = args[0];

    if (subCmd === 'version') {
      return callback(null, '24.0.5\n', '');
    }

    if (subCmd === 'info') {
      return callback(null, '{"runsc":{"path":"/usr/bin/runsc"}}', '');
    }

    if (subCmd === 'run') {
      return callback(null, 'container_id_hash_12345\n', '');
    }

    if (subCmd === 'rm' || subCmd === 'stop') {
      return callback(null, 'container_id_hash_12345\n', '');
    }

    if (subCmd === 'inspect') {
      return callback(null, 'true\n', '');
    }

    if (subCmd === 'logs') {
      return callback(null, '[INFO] Bot initialized successfully\n', '');
    }

    return callback(null, '', '');
  };

  return { mockFn, calls };
}

test('Environment Gating - Requires REVIEWED=true and TEST_LAB_MODE=true', async () => {
  const originalEnv = { REVIEWED: process.env.REVIEWED, TEST_LAB_MODE: process.env.TEST_LAB_MODE };

  try {
    delete process.env.REVIEWED;
    delete process.env.TEST_LAB_MODE;

    await assert.rejects(
      async () => {
        await start({ sourceDir: '/tmp', botId: '123' });
      },
      /Lab execution prohibited/
    );

    process.env.REVIEWED = 'true';
    delete process.env.TEST_LAB_MODE;

    await assert.rejects(
      async () => {
        await stop({ botId: '123' });
      },
      /Lab execution prohibited/
    );

    delete process.env.REVIEWED;
    process.env.TEST_LAB_MODE = 'true';

    await assert.rejects(
      async () => {
        await status({ botId: '123' });
      },
      /Lab execution prohibited/
    );

    await assert.rejects(
      async () => {
        await logs({ botId: '123' });
      },
      /Lab execution prohibited/
    );

  } finally {
    if (originalEnv.REVIEWED) process.env.REVIEWED = originalEnv.REVIEWED;
    else delete process.env.REVIEWED;

    if (originalEnv.TEST_LAB_MODE) process.env.TEST_LAB_MODE = originalEnv.TEST_LAB_MODE;
    else delete process.env.TEST_LAB_MODE;
    delete process.env.LAB_ALLOW_NETWORK;
  }
});

test('Fail Closed when Docker is Absent - No Host Fallback', async () => {
  const originalEnv = { REVIEWED: process.env.REVIEWED, TEST_LAB_MODE: process.env.TEST_LAB_MODE };
  process.env.REVIEWED = 'true';
  process.env.TEST_LAB_MODE = 'true';
  process.env.LAB_ALLOW_NETWORK = 'true';

  const mockExecFail = (command, args, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
    }
    const err = new Error('spawn docker ENOENT');
    err.code = 'ENOENT';
    callback(err, '', 'docker: command not found');
  };

  const tempSource = createTempBotSource();

  try {
    const runner = new DockerRunner({ execFile: mockExecFail });

    await assert.rejects(
      async () => {
        await runner.start({ sourceDir: tempSource, botId: 'fail_bot' });
      },
      /Docker is absent or unavailable/
    );

    await assert.rejects(
      async () => {
        await runner.stop({ botId: 'fail_bot' });
      },
      /Docker is absent or unavailable/
    );

  } finally {
    fs.rmSync(tempSource, { recursive: true, force: true });
    if (originalEnv.REVIEWED) process.env.REVIEWED = originalEnv.REVIEWED;
    else delete process.env.REVIEWED;
    if (originalEnv.TEST_LAB_MODE) process.env.TEST_LAB_MODE = originalEnv.TEST_LAB_MODE;
    else delete process.env.TEST_LAB_MODE;
    delete process.env.LAB_ALLOW_NETWORK;
  }
});

test('Docker Runner API Lifecycle - start, status, logs, stop', async () => {
  const originalEnv = { REVIEWED: process.env.REVIEWED, TEST_LAB_MODE: process.env.TEST_LAB_MODE };
  process.env.REVIEWED = 'true';
  process.env.TEST_LAB_MODE = 'true';
  process.env.LAB_ALLOW_NETWORK = 'true';

  const { mockFn, calls } = createMockExecFile();
  const tempSource = createTempBotSource();

  try {
    const runner = new DockerRunner({ execFile: mockFn });
    const botId = 'bot_lab_777';
    const telegramToken = '999999999:ABCdefGHIjklMNOpqrsTUVwxyZ99999';

    // 1. Start Container
    const startResult = await runner.start({
      sourceDir: tempSource,
      botId,
      telegramToken
    });

    assert.equal(startResult.success, true);
    assert.equal(startResult.botId, botId);
    assert.equal(startResult.containerName, `botlab-${botId}`);
    assert.equal(startResult.status, 'running');
    assert.equal(startResult.runtime, 'node20');

    // Verify Docker CLI Argv array flags
    const runCall = calls.find(c => c.args && c.args[0] === 'run');
    assert.ok(runCall, 'Expected docker run execution');
    assert.equal(runCall.command, 'docker');
    assert.ok(Array.isArray(runCall.args), 'Must use spawned argv array, never shell');

    const args = runCall.args;
    assert.ok(args.includes('-d'));
    assert.ok(args.includes(`--name=${startResult.containerName}`));
    assert.ok(args.includes('--security-opt=no-new-privileges'));
    assert.ok(args.includes('--cap-drop=ALL'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--tmpfs=/tmp:rw,noexec,nosuid'));
    assert.ok(args.includes('--tmpfs=/root:rw,noexec,nosuid'));
    assert.ok(args.includes('--user=1000:1000'));
    assert.ok(args.includes('--cpus=0.5'));
    assert.ok(args.includes('--memory=256m'));
    assert.ok(args.includes('--pids-limit=64'));
    assert.ok(args.includes('--init'));
    assert.ok(args.includes('--restart=no'));
    assert.ok(args.includes('--network=bridge')); // private lab needs Telegram access

    // Check read-only mount
    const vIndex = args.indexOf('-v');
    assert.ok(vIndex !== -1);
    assert.ok(args[vIndex + 1].endsWith(':/app:ro'));

    // Check environment variables
    const tokenIdx = args.indexOf(`TELEGRAM_TOKEN=${telegramToken}`);
    assert.ok(tokenIdx !== -1 && args[tokenIdx - 1] === '-e');

    // Check image and script command tokens
    assert.ok(args.includes('node:20-alpine'));
    assert.ok(args.some(arg => arg.includes('exec node index.js')));

    // Ensure no privileged flag
    assert.equal(args.includes('--privileged'), false);

    // 2. Status Check
    const statusResult = await runner.status({ botId });
    assert.equal(statusResult.botId, botId);
    assert.equal(statusResult.running, true);

    // 3. Logs Check
    const logsResult = await runner.logs({ botId, tail: 50 });
    assert.equal(logsResult.botId, botId);
    assert.match(logsResult.logs, /Bot initialized successfully/);

    const logsCall = calls.find(c => c.args && c.args[0] === 'logs');
    assert.ok(logsCall);
    assert.ok(logsCall.args.includes('--tail=50'));

    // 4. Stop Container
    const stopResult = await runner.stop({ botId });
    assert.equal(stopResult.success, true);
    assert.equal(stopResult.botId, botId);
    assert.equal(stopResult.status, 'stopped');

    const rmCall = calls.find(c => c.args && c.args[0] === 'rm');
    assert.ok(rmCall);
    assert.ok(rmCall.args.includes(startResult.containerName));

  } finally {
    fs.rmSync(tempSource, { recursive: true, force: true });
    if (originalEnv.REVIEWED) process.env.REVIEWED = originalEnv.REVIEWED;
    else delete process.env.REVIEWED;
    if (originalEnv.TEST_LAB_MODE) process.env.TEST_LAB_MODE = originalEnv.TEST_LAB_MODE;
    else delete process.env.TEST_LAB_MODE;
    delete process.env.LAB_ALLOW_NETWORK;
  }
});

test('Manifest Override - Python 3.11 Runtime Support', async () => {
  const originalEnv = { REVIEWED: process.env.REVIEWED, TEST_LAB_MODE: process.env.TEST_LAB_MODE };
  process.env.REVIEWED = 'true';
  process.env.TEST_LAB_MODE = 'true';
  process.env.LAB_ALLOW_NETWORK = 'true';

  const { mockFn, calls } = createMockExecFile();
  const tempSource = createTempBotSource({ 'main.py': 'print("hello python")' });

  try {
    const runner = new DockerRunner({ execFile: mockFn });
    const botId = 'python_bot_888';

    const startResult = await runner.start({
      sourceDir: tempSource,
      manifest: { runtime: 'python311', startCommand: 'python main.py' },
      botId
    });

    assert.equal(startResult.success, true);
    assert.equal(startResult.runtime, 'python311');

    const runCall = calls.find(c => c.args && c.args[0] === 'run');
    assert.ok(runCall);
    assert.ok(runCall.args.includes('python:3.11-alpine'));
    assert.ok(runCall.args.some(arg => arg.includes('exec python3 main.py')));

  } finally {
    fs.rmSync(tempSource, { recursive: true, force: true });
    if (originalEnv.REVIEWED) process.env.REVIEWED = originalEnv.REVIEWED;
    else delete process.env.REVIEWED;
    if (originalEnv.TEST_LAB_MODE) process.env.TEST_LAB_MODE = originalEnv.TEST_LAB_MODE;
    else delete process.env.TEST_LAB_MODE;
    delete process.env.LAB_ALLOW_NETWORK;
  }
});

test('Security & Multi-Tenant Isolation Notice', () => {
  assert.ok(Array.isArray(ISOLATION_NOTICE));
});
