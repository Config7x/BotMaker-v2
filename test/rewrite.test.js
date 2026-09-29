'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  generateAiRewriteCandidate,
  validateTargetRuntime,
  validateEndpointUrl,
  scrubSecrets,
  isTextFile,
  sanitizeRelativePath,
  DEFAULT_ENDPOINT,
  MAX_FILE_COUNT,
  MAX_SINGLE_FILE_SIZE
} = require('../src/custom/rewrite');

// Utility to mock fetch responses
function createMockFetch(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    return handler(url, options);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test('validateTargetRuntime - accepts valid node20 and python3.11 targets', () => {
  assert.equal(validateTargetRuntime('node20'), 'node20');
  assert.equal(validateTargetRuntime('NODE:20'), 'node20');
  assert.equal(validateTargetRuntime('python3.11'), 'python3.11');
  assert.equal(validateTargetRuntime('python 3.11'), 'python3.11');
});

test('validateTargetRuntime - rejects unsupported target runtimes', () => {
  assert.throws(() => validateTargetRuntime('ruby'), /Unsupported target runtime/);
  assert.throws(() => validateTargetRuntime('go1.21'), /Unsupported target runtime/);
  assert.throws(() => validateTargetRuntime(null), /Explicit target runtime/);
  assert.throws(() => validateTargetRuntime(''), /Explicit target runtime/);
});

test('validateEndpointUrl - allows HTTPS endpoints and rejects HTTP/non-allowlisted', () => {
  assert.equal(validateEndpointUrl(DEFAULT_ENDPOINT), DEFAULT_ENDPOINT);

  assert.throws(() => {
    validateEndpointUrl('http://api.openai.com/v1/chat/completions');
  }, /HTTPS/);

  assert.throws(() => {
    validateEndpointUrl('https://untrusted-malicious-site.com/v1');
  }, /allowlist/);
});

test('scrubSecrets - redacts Telegram bot tokens and API keys', () => {
  const input = `
    const token = "123456789:ABCdefGHIjklMNOpqrsTUVwxyZ12345";
    const apiKey = "sk-proj-1234567890abcdef1234567890";
    bot_token = "987654321:XYZdefGHIjklMNOpqrsTUVwxyZ54321";
  `;

  const scrubbed = scrubSecrets(input);

  assert.ok(!scrubbed.includes('123456789:ABCdefGHIjklMNOpqrsTUVwxyZ12345'));
  assert.ok(!scrubbed.includes('sk-proj-1234567890abcdef1234567890'));
  assert.ok(!scrubbed.includes('987654321:XYZdefGHIjklMNOpqrsTUVwxyZ54321'));
  assert.ok(scrubbed.includes('[REDACTED_TELEGRAM_TOKEN]'));
  assert.ok(scrubbed.includes('[REDACTED_API_KEY]'));
});

test('isTextFile & sanitizeRelativePath - validates text files and blocks path traversal', () => {
  assert.equal(isTextFile('main.js', 'console.log("hello")'), true);
  assert.equal(isTextFile('bot.py', 'print("hello")'), true);
  assert.equal(isTextFile('image.png', Buffer.from([139, 80, 78, 71])), false);
  assert.equal(isTextFile('binary.bin', Buffer.from([0x00, 0x01, 0x02])), false);

  assert.equal(sanitizeRelativePath('src/index.js'), 'src/index.js');
  assert.throws(() => sanitizeRelativePath('../etc/passwd'), /Path traversal/);
  assert.throws(() => sanitizeRelativePath('/abs/path/file.js'), /Path traversal/);
  assert.throws(() => sanitizeRelativePath('foo/../../bar.js'), /Path traversal/);
  assert.throws(() => sanitizeRelativePath('foo\0bar.js'), /Path traversal/);
});

test('generateAiRewriteCandidate - throws without explicit opt-in and consent', async () => {
  await assert.rejects(async () => {
    await generateAiRewriteCandidate({ 'main.js': 'console.log("hi")' }, {
      targetRuntime: 'node20',
      optIn: false,
      consent: true
    });
  }, /explicit opt-in/);

  await assert.rejects(async () => {
    await generateAiRewriteCandidate({ 'main.js': 'console.log("hi")' }, {
      targetRuntime: 'node20',
      optIn: true,
      consent: false
    });
  }, /explicit opt-in/);
});

test('generateAiRewriteCandidate - throws when AI_API_KEY is missing', async () => {
  const origKey = process.env.AI_API_KEY;
  delete process.env.AI_API_KEY;

  try {
    await assert.rejects(async () => {
      await generateAiRewriteCandidate({ 'main.js': 'console.log("hi")' }, {
        targetRuntime: 'node20',
        optIn: true,
        consent: true
      });
    }, /Missing required AI_API_KEY/);
  } finally {
    if (origKey) process.env.AI_API_KEY = origKey;
  }
});

test('generateAiRewriteCandidate - throws when non-text or binary files are submitted', async () => {
  process.env.AI_API_KEY = 'test_mock_api_key';

  await assert.rejects(async () => {
    await generateAiRewriteCandidate({
      'main.js': 'console.log("hi")',
      'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('binary')
    }, {
      targetRuntime: 'node20',
      optIn: true,
      consent: true
    });
  }, /binary or non-text/);
});

test('generateAiRewriteCandidate - throws when file size or count exceeds limits', async () => {
  process.env.AI_API_KEY = 'test_mock_api_key';

  // Single file size limit test
  const hugeContent = 'a'.repeat(MAX_SINGLE_FILE_SIZE + 10);
  await assert.rejects(async () => {
    await generateAiRewriteCandidate({ 'huge.js': hugeContent }, {
      targetRuntime: 'node20',
      optIn: true,
      consent: true
    });
  }, /exceeds maximum allowed file size/);

  // File count limit test
  const manyFiles = {};
  for (let i = 0; i < MAX_FILE_COUNT + 1; i++) {
    manyFiles[`file_${i}.js`] = 'console.log(1);';
  }

  await assert.rejects(async () => {
    await generateAiRewriteCandidate(manyFiles, {
      targetRuntime: 'node20',
      optIn: true,
      consent: true
    });
  }, /File count exceeds maximum limit/);
});

test('generateAiRewriteCandidate - successful mock flow with secret scrubbing, JSON candidate result & path traversal protection', async () => {
  process.env.AI_API_KEY = 'test_mock_api_key_12345';
  process.env.AI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

  let capturedBody = null;
  let capturedHeaders = null;

  const restoreFetch = createMockFetch(async (url, options) => {
    capturedHeaders = options.headers;
    capturedBody = JSON.parse(options.body);

    const mockAiResponse = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'Converted Python telebot to Node.js 20 Express bot.',
              files: [
                {
                  path: 'index.js',
                  content: 'const express = require("express");'
                },
                {
                  path: 'package.json',
                  content: '{"name": "migrated-bot", "version": "1.0.0"}'
                },
                {
                  // Traversal attempt in candidate output should be caught/sanitized
                  path: '../../etc/shadow',
                  content: 'malicious'
                }
              ]
            })
          }
        }
      ]
    };

    return {
      ok: true,
      status: 200,
      json: async () => mockAiResponse
    };
  });

  try {
    const inputFiles = {
      'bot.py': 'import telebot\nBOT_TOKEN = "123456789:ABCdefGHIjklMNOpqrsTUVwxyZ12345"\nbot = telebot.TeleBot(BOT_TOKEN)\n'
    };

    const result = await generateAiRewriteCandidate(inputFiles, {
      targetRuntime: 'node20',
      optIn: true,
      consent: true
    });

    // Check captured payload sent to AI
    assert.equal(capturedHeaders['Authorization'], 'Bearer test_mock_api_key_12345');
    assert.equal(capturedHeaders['Content-Type'], 'application/json');

    const promptText = JSON.stringify(capturedBody);
    assert.ok(!promptText.includes('123456789:ABCdefGHIjklMNOpqrsTUVwxyZ12345'), 'Telegram token should be scrubbed');
    assert.ok(promptText.includes('[REDACTED_TELEGRAM_TOKEN]'), 'Redacted token marker should be present');

    // Verify structured output
    assert.equal(result.success, true);
    assert.equal(result.targetRuntime, 'node20');
    assert.equal(result.summary, 'Converted Python telebot to Node.js 20 Express bot.');
    assert.equal(result.deployed, false);
    assert.equal(result.correctnessGuaranteed, false);
    assert.ok(result.disclaimer.includes('NOT been automatically deployed'));

    // Verify candidate files returned (and traversal path was blocked/rejected)
    assert.equal(result.candidateFiles.length, 2);
    assert.equal(result.candidateFiles[0].path, 'index.js');
    assert.equal(result.candidateFiles[1].path, 'package.json');
  } finally {
    restoreFetch();
  }
});

test('generateAiRewriteCandidate - reads directory input safely', async () => {
  process.env.AI_API_KEY = 'test_mock_api_key_dir';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botmaker-test-'));
  fs.writeFileSync(path.join(tmpDir, 'bot.py'), 'print("test bot")');
  fs.writeFileSync(path.join(tmpDir, 'config.json'), '{"key": "value"}');

  const restoreFetch = createMockFetch(async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Migrated directory bot to Node 20',
                files: [{ path: 'index.js', content: 'console.log("migrated");' }]
              })
            }
          }
        ]
      })
    };
  });

  try {
    const result = await generateAiRewriteCandidate(tmpDir, {
      targetRuntime: 'node20',
      optIn: true,
      consent: true
    });

    assert.equal(result.success, true);
    assert.equal(result.candidateFiles.length, 1);
    assert.equal(result.candidateFiles[0].path, 'index.js');
  } finally {
    restoreFetch();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
