'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { createTelegramApi } = require('../src/telegram');

test('sendMessage retries without style when Telegram rejects a styled button', async () => {
  const api = createTelegramApi('000000000:RealLookingTokenABCdefGHIjklMNO', {});
  const seenPayloads = [];
  const originalRequest = https.request;

  https.request = (url, opts, cb) => {
    // Capture body via req.write
    let body = '';
    const res = new EventEmitter();
    const req = {
      write(chunk) { body += chunk; },
      end() {
        seenPayloads.push(JSON.parse(body));
        const isFirstCall = seenPayloads.length === 1;
        const responseBody = isFirstCall
          ? { ok: false, error_code: 400, description: "Bad Request: BUTTON_STYLE_INVALID" }
          : { ok: true, result: { message_id: 42, chat: { id: 1 }, text: 'hi' } };
        process.nextTick(() => {
          cb(res);
          res.emit('data', Buffer.from(JSON.stringify(responseBody)));
          res.emit('end');
        });
      },
      on() {},
      destroy() {}
    };
    return req;
  };

  try {
    const result = await api.sendMessage(1, 'hi', {
      reply_markup: { inline_keyboard: [[{ text: 'Go', callback_data: 'x', style: 'success' }]] }
    });

    assert.equal(seenPayloads.length, 2, 'expected exactly one retry');
    assert.equal(seenPayloads[0].reply_markup.inline_keyboard[0][0].style, 'success');
    assert.equal(seenPayloads[1].reply_markup.inline_keyboard[0][0].style, undefined);
    assert.equal(result.ok, true);
  } finally {
    https.request = originalRequest;
  }
});

test('sendMessage does NOT retry when there is no styled button (avoids extra API calls)', async () => {
  const api = createTelegramApi('000000000:RealLookingTokenABCdefGHIjklMNO', {});
  let calls = 0;
  const originalRequest = https.request;

  https.request = (url, opts, cb) => {
    const res = new EventEmitter();
    const req = {
      write() {},
      end() {
        calls += 1;
        process.nextTick(() => {
          cb(res);
          res.emit('data', Buffer.from(JSON.stringify({ ok: false, error_code: 400, description: 'Some other error' })));
          res.emit('end');
        });
      },
      on() {},
      destroy() {}
    };
    return req;
  };

  try {
    await api.sendMessage(1, 'hi', { reply_markup: { inline_keyboard: [[{ text: 'Go', callback_data: 'x' }]] } });
    assert.equal(calls, 1, 'no style fields present, should not retry');
  } finally {
    https.request = originalRequest;
  }
});
