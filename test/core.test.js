'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BotDb, validateBotToken, encryptToken, decryptToken } = require('../src/db');
const { escapeHtml } = require('../src/utils/html');

test('Token Format Validation', () => {
  assert.equal(validateBotToken('123456789:ABCdefGHIjklMNOpqrsTUVwxyZ12345'), true);
  assert.equal(validateBotToken('987654321:abcdefghijklmnopqrstuvwxyz12345'), true);
  assert.equal(validateBotToken('invalid_token'), false);
  assert.equal(validateBotToken('12345:short'), false);
  assert.equal(validateBotToken(null), false);
  assert.equal(validateBotToken(12345), false);
});

test('Token Encryption & Decryption at Rest (AES-256-GCM)', () => {
  const secretKey = 'my_secret_encryption_key_for_testing_32bytes';
  const token = '123456789:ABCdefGHIjklMNOpqrsTUVwxyZ12345';

  const encrypted = encryptToken(token, secretKey);
  assert.ok(encrypted.includes(':'));
  assert.notEqual(encrypted, token);

  const decrypted = decryptToken(encrypted, secretKey);
  assert.equal(decrypted, token);

  // Mismatched key should throw error
  assert.throws(() => {
    decryptToken(encrypted, 'wrong_key');
  });
});

test('Database User Quota & Bot Lifecycle', () => {
  const db = new BotDb(':memory:');
  const userId = 1001;
  const token1 = '111111111:ABCdefGHIjklMNOpqrsTUVwxyZ11111';
  const token2 = '222222222:ABCdefGHIjklMNOpqrsTUVwxyZ22222';
  const token3 = '333333333:ABCdefGHIjklMNOpqrsTUVwxyZ33333';

  // Quota cap = 2
  const bot1 = db.createBot({ ownerId: userId, token: token1, templateId: 'shop', maxBotsPerUser: 2, encryptionKey: "test_fixture_secret_key_32_characters_plus" });
  assert.ok(bot1.id.startsWith('bot_'));
  assert.equal(bot1.status, 'active');
  assert.equal(db.getBotCountForUser(userId), 1);

  const bot2 = db.createBot({ ownerId: userId, token: token2, templateId: 'quiz', maxBotsPerUser: 2, encryptionKey: "test_fixture_secret_key_32_characters_plus" });
  assert.equal(db.getBotCountForUser(userId), 2);

  // Exceed quota
  assert.throws(() => {
    db.createBot({ ownerId: userId, token: token3, templateId: 'uploader', maxBotsPerUser: 2, encryptionKey: "test_fixture_secret_key_32_characters_plus" });
  }, /QUOTA_EXCEEDED/);

  // Soft delete bot1
  db.deleteBot(bot1.id, userId);
  assert.equal(db.getBotCountForUser(userId), 1);

  // Now bot3 can be created
  const bot3 = db.createBot({ ownerId: userId, token: token3, templateId: 'uploader', maxBotsPerUser: 2, encryptionKey: "test_fixture_secret_key_32_characters_plus" });
  assert.ok(bot3.id);
  assert.equal(db.getBotCountForUser(userId), 2);

  db.close();
});

test('Bot-Scoped Document & KV Persistence', async () => {
  const db = new BotDb(':memory:');
  const bot = db.createBot({ ownerId: 500, token: '555555555:ABCdefGHIjklMNOpqrsTUVwxyZ55555', templateId: 'shop', encryptionKey: 'test_fixture_secret_key_32_characters_plus' });

  const botDb = db.getBotScopedDb(bot.id);

  // KV operations
  await botDb.set('settings', { theme: 'dark', itemsPerPage: 10 });
  const settings = await botDb.get('settings');
  assert.deepEqual(settings, { theme: 'dark', itemsPerPage: 10 });

  await botDb.delete('settings');
  assert.equal(await botDb.get('settings'), null);

  // Collection operations
  const item1 = await botDb.save('products', { name: 'Laptop', price: 1000 });
  assert.ok(item1._id);
  assert.equal(item1.name, 'Laptop');

  const item2 = await botDb.save('products', { name: 'Phone', price: 500 });
  assert.ok(item2._id);

  const foundAll = await botDb.find('products');
  assert.equal(foundAll.length, 2);

  const foundPhone = await botDb.find('products', { price: 500 });
  assert.equal(foundPhone.length, 1);
  assert.equal(foundPhone[0].name, 'Phone');

  db.close();
});

test('HTML Escaping Protection', () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml('Ben & Jerry\'s'), 'Ben &amp; Jerry&#39;s');
  assert.equal(escapeHtml(null), '');
});
