'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BotDb } = require('../src/db');
const { createTelegramApi, clearMockCalls, getMockCalls } = require('../src/telegram');
const template = require('../src/templates/music_bot');
const services = require('../src/templates/music_bot/services');
const { STRINGS, LANGUAGES } = require('../src/templates/music_bot/i18n');

function setup() {
  clearMockCalls();
  const db = new BotDb(':memory:');
  const scoped = db.getBotScopedDb('mb_test');
  const api = createTelegramApi('123456789:ABCdefGHIjklMNOpqrsTUVwxyZ12345', { mock: true });
  const bot = { id: 'mb_test', owner_id: 1, config: '{}' };
  const send = (update) => template.handle({ update, bot, db: scoped, api });
  const msg = (text, id = 42) => ({ message: { from: { id }, chat: { id, type: 'private' }, message_id: 1, text } });
  const cb = (data, id = 42) => ({ callback_query: { id: 'q1', from: { id }, data, message: { chat: { id }, message_id: 7 } } });
  return { db, send, msg, cb };
}

// Installs a fake yt-dlp on PATH so the real code path (execFile -> file -> upload) runs offline.
function withFakeYtDlp(script, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake_ytdlp_'));
  const bin = path.join(dir, 'yt-dlp');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  return Promise.resolve(fn()).finally(() => { process.env.PATH = oldPath; fs.rmSync(dir, { recursive: true, force: true }); });
}

const FAKE_OK = `#!/bin/bash
if [[ "$*" == *"ytsearch"* ]]; then
  for i in 1 2 3; do printf 'Song %s\\thttps://www.youtube.com/watch?v=abcdefghi%s\\tabcdefghi%s\\n' $i $i $i; done
  exit 0
fi
out=""; while [[ $# -gt 0 ]]; do if [[ "$1" == "-o" ]]; then out="$2"; fi; shift; done
out="\${out//%(title).80B/Test Song}"; out="\${out//%(ext)s/mp3}"
head -c 2048 /dev/zero > "$out"
`;

test('registry metadata is valid', () => {
  assert.equal(template.id, 'music_bot');
  assert.equal(typeof template.handle, 'function');
  assert.equal(Object.keys(LANGUAGES).length, 10);
});

test('every language defines every string key', () => {
  const keys = Object.keys(STRINGS.en);
  for (const code of Object.keys(LANGUAGES)) {
    for (const k of keys) assert.ok(STRINGS[code] && STRINGS[code][k], `${code} missing ${k}`);
  }
});

test('/start shows the 10-language picker', async () => {
  const { send, msg, db } = setup();
  await send(msg('/start'));
  const call = getMockCalls().find(c => c.method === 'sendMessage');
  const buttons = call.payload.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.length, 10);
  assert.ok(buttons.every(b => b.callback_data.startsWith('mb:lang:')));
  db.close();
});

test('choosing a language shows the service menu in that language', async () => {
  const { send, cb, db } = setup();
  await send(cb('mb:lang:de'));
  const call = getMockCalls().find(c => c.method === 'editMessageText');
  assert.match(call.payload.text, /Sprache gewählt/);
  assert.equal(call.payload.reply_markup.inline_keyboard[0].length, 2);
  db.close();
});

test('text before choosing a service asks to pick one', async () => {
  const { send, msg, db } = setup();
  await send(msg('hello'));
  const calls = getMockCalls().filter(c => c.method === 'sendMessage');
  assert.match(calls[calls.length - 1].payload.text, /\/start/);
  db.close();
});

test('music search returns up to 10 pick buttons (fake yt-dlp)', async () => {
  await withFakeYtDlp(FAKE_OK, async () => {
    const { send, msg, cb, db } = setup();
    await send(cb('mb:music'));
    await send(msg('shadmehr'));
    const last = getMockCalls().filter(c => c.method === 'sendMessage').pop();
    const buttons = last.payload.reply_markup.inline_keyboard.flat();
    assert.equal(buttons.length, 3);
    assert.match(buttons[0].callback_data, /^mb:pick:abcdefghi1$/);
    db.close();
  });
});

test('picking a result downloads and uploads an mp3, then cleans temp files (fake yt-dlp)', async () => {
  await withFakeYtDlp(FAKE_OK, async () => {
    const { send, cb, db } = setup();
    await send(cb('mb:pick:abcdefghi1'));
    const audio = getMockCalls().find(c => c.method === 'sendAudio');
    assert.ok(audio, 'sendAudio should be called');
    assert.match(audio.payload.audio, /^file:\/\/.*\.mp3$/);
    const leftovers = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('music_bot_'));
    assert.equal(leftovers.length, 0, 'temp dir must be removed');
    db.close();
  });
});

test('instagram mode rejects non-links and private/internal URLs', async () => {
  const { send, msg, cb, db } = setup();
  await send(cb('mb:instagram'));
  for (const bad of ['just text', 'http://127.0.0.1/x', 'https://localhost/a', 'http://169.254.169.254/latest', 'file:///etc/passwd']) {
    clearMockCalls();
    await send(msg(bad));
    assert.equal(getMockCalls().filter(c => c.method === 'sendAudio').length, 0, bad);
    assert.ok(getMockCalls().some(c => c.method === 'sendMessage'), bad);
  }
  db.close();
});

test('shell metacharacters in a search query cannot execute commands', async () => {
  const marker = path.join(os.tmpdir(), 'pwned_' + Date.now());
  await withFakeYtDlp(FAKE_OK, async () => {
    const { send, msg, cb, db } = setup();
    await send(cb('mb:music'));
    await send(msg(`x"; touch ${marker}; echo "`));
    assert.equal(fs.existsSync(marker), false);
    db.close();
  });
});

test('missing yt-dlp shows a clear message instead of crashing', async () => {
  const old = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    const { send, msg, cb, db } = setup();
    await send(cb('mb:music'));
    await send(msg('song'));
    const last = getMockCalls().filter(c => c.method === 'sendMessage').pop();
    assert.match(last.payload.text, /yt-dlp/);
    db.close();
  } finally { process.env.PATH = old; }
});

test('services.isSafeHttpUrl', () => {
  assert.equal(services.isSafeHttpUrl('https://www.instagram.com/reel/abc/'), true);
  assert.equal(services.isSafeHttpUrl('http://10.0.0.5/x'), false);
  assert.equal(services.isSafeHttpUrl('ftp://a.com'), false);
  assert.equal(services.isSafeHttpUrl(null), false);
});
