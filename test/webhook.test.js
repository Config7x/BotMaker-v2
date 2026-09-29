'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { BotDb } = require('../src/db');
const { createWebhookApp } = require('../src/webhook');
const { clearMockCalls, getMockCalls } = require('../src/telegram');

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

function makeGetRequest(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('Webhook Dispatch Server & Security', async () => {
  clearMockCalls();
  const db = new BotDb(':memory:');
  const config = {
    encryption_key: 'test_encryption_key_32_bytes_len!!',
    mock_telegram: true,
    public_base_url: 'http://127.0.0.1:0'
  };

  const bot = db.createBot({
    ownerId: 200,
    token: '999999999:ABCdefGHIjklMNOpqrsTUVwxyZ99999',
    templateId: 'shop',
    encryptionKey: config.encryption_key
  });

  const app = createWebhookApp({ db, config });
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Health check
  const healthRes = await makeGetRequest(`${baseUrl}/health`);
  assert.equal(healthRes.statusCode, 200);

  // Unmatched / Unknown secret token -> 404, no token leak
  const unknownRes = await makePostRequest(`${baseUrl}/webhook/unknown_secret_12345`, {}, { update_id: 1 });
  assert.equal(unknownRes.statusCode, 404);
  assert.doesNotMatch(unknownRes.body, /999999999/);

  // Secret token header mismatch -> 403
  const mismatchRes = await makePostRequest(
    `${baseUrl}/webhook/${bot.secret_token}`,
    { 'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret' },
    { update_id: 2 }
  );
  assert.equal(mismatchRes.statusCode, 403);

  // Valid secret token -> 200 OK
  const validRes = await makePostRequest(
    `${baseUrl}/webhook/${bot.secret_token}`,
    { 'X-Telegram-Bot-Api-Secret-Token': bot.secret_token },
    { update_id: 3, message: { text: 'Hello bot', chat: { id: 100 } } }
  );
  assert.equal(validRes.statusCode, 200);

  // Deactivated bot -> 404
  db.deleteBot(bot.id, 200);
  const deletedRes = await makePostRequest(`${baseUrl}/webhook/${bot.secret_token}`, {}, { update_id: 4 });
  assert.equal(deletedRes.statusCode, 404);

  server.close();
  db.close();
});
