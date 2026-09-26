'use strict';

const crypto = require('crypto');

/**
 * AES-256-GCM encryption for BotFather tokens.
 * Plaintext tokens are NEVER stored or logged — only token_encrypted.
 * Key comes from ENCRYPTION_KEY env (64 hex chars or any string, hashed to 32 bytes).
 */
function deriveKey(encKey) {
  if (!encKey) throw new Error('ENCRYPTION_KEY is required');
  if (/^[0-9a-fA-F]{64}$/.test(encKey)) return Buffer.from(encKey, 'hex');
  return crypto.createHash('sha256').update(encKey).digest();
}

function encrypt(plain, encKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(encKey), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(payload, encKey) {
  const [ivB64, tagB64, dataB64] = String(payload).split('.');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Malformed encrypted payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(encKey), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
