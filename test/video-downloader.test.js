'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BotDb } = require('../src/db');
const { createTelegramApi, clearMockCalls, getMockCalls } = require('../src/telegram');
const template = require('../src/templates/video_downloader');
const S = require('../src/templates/video_downloader/services');
const C = require('../src/templates/video_downloader/video_downloader');

const OWNER = 1;
let seq = 0;

function setup() {
  clearMockCalls();
  const db = new BotDb(':memory:');
  const id = `vd_test_${++seq}`;
  const scoped = db.getBotScopedDb(id);
  const api = createTelegramApi('123456789:ABCdefGHIjklMNOpqrsTUVwxyZ12345', { mock: true });
  const bot = { id, owner_id: OWNER, config: '{}' };
  const send = update => template.handle({ update, bot, db: scoped, api });
  const msg = (text, uid = 42) => ({ message: { from: { id: uid, first_name: 'T', username: `u${uid}` }, chat: { id: uid, type: 'private' }, message_id: 1, text } });
  const cb = (data, uid = 42) => ({ callback_query: { id: 'q1', from: { id: uid, first_name: 'T' }, data, message: { chat: { id: uid }, message_id: 7 } } });
  const calls = m => getMockCalls().filter(c => c.method === m);
  const lastText = () => { const c = getMockCalls().filter(x => x.method === 'sendMessage' || x.method === 'editMessageText'); return c.length ? c[c.length - 1].payload.text : ''; };
  return { db, scoped, send, msg, cb, calls, lastText, bot };
}

function withFake(script, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake_vd_'));
  fs.writeFileSync(path.join(dir, 'yt-dlp'), script, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'ffmpeg'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  return Promise.resolve(fn()).finally(() => { process.env.PATH = old; fs.rmSync(dir, { recursive: true, force: true }); });
}

const INFO_JSON = JSON.stringify({
  title: 'My <Video>', duration: 125, uploader: 'Chan',
  formats: [
    { vcodec: 'avc1', height: 360, filesize: 1000000 }, { vcodec: 'avc1', height: 720, filesize: 5000000 },
    { vcodec: 'none', acodec: 'mp4a', filesize: 200000 }
  ]
});

// Fake yt-dlp: -J => metadata; otherwise prints progress lines then writes a file.
const FAKE_OK = `#!/bin/bash
if [[ "$*" == *"-J"* ]]; then echo '${INFO_JSON}'; exit 0; fi
out=""; prev=""; for a in "$@"; do if [[ "$prev" == "-o" ]]; then out="$a"; fi; prev="$a"; done
ext=mp4; for a in "$@"; do if [[ "$a" == "mp3" ]]; then ext=mp3; fi; done
out="\${out//%(title).80B/Test Video}"; out="\${out//%(ext)s/$ext}"
echo "PROG 100 1000 NA 500 1"
head -c 4096 /dev/zero > "$out"
echo "FILE $out"
exit 0
`;
const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(50); } return false; }

test('metadata helpers: qualities, size, formatting', () => {
  const info = JSON.parse(INFO_JSON);
  assert.deepEqual(S.availableQualities(info), ['360', '720']);
  assert.equal(S.estimateSize(info), 5200000);
  assert.equal(S.availableQualities({ formats: [{ vcodec: 'x' }] }).join(), 'best');
  assert.equal(S.formatDuration(125), '2:05');
  assert.equal(S.formatDuration(3725), '1:02:05');
  assert.equal(S.formatSize(1536), '1.5 KB');
  assert.equal(S.progressBar(50, 10), '█████░░░░░');
});

test('SSRF: private / non-http links are rejected', () => {
  for (const u of ['http://127.0.0.1/x', 'http://localhost/x', 'http://10.0.0.5/x', 'file:///etc/passwd', 'ftp://a.b/c', 'javascript:1', 'x y'])
    assert.equal(S.isSafeHttpUrl(u), false, u);
  assert.equal(S.isSafeHttpUrl('https://example.com/v'), true);
  assert.equal(S.normalizeUrl('www.example.com/a'), 'https://www.example.com/a');
});

test('friendly errors never leak internals', () => {
  assert.equal(S.friendlyErrorKey({ stderr: 'ERROR: Unsupported URL: http://x' }), 'errUnsupported');
  assert.equal(S.friendlyErrorKey({ stderr: 'Video unavailable' }), 'errGone');
  assert.equal(S.friendlyErrorKey({ stderr: 'Private video' }), 'errPrivate');
  assert.equal(S.friendlyErrorKey({ stderr: 'Sign in to confirm you are not a bot' }), 'errLogin');
  assert.equal(S.friendlyErrorKey({ stderr: 'weird' }), 'errInfo');
});

test('/start and /help show the original Persian texts', async () => {
  const { send, msg, calls } = setup();
  await send(msg('/start'));
  assert.match(calls('sendMessage')[0].payload.text, /به ربات دانلود ویدیو خوش آمدید/);
  assert.equal(calls('sendMessage')[0].payload.reply_markup.inline_keyboard[0][0].text, '🎬 دانلود ویدیو');
  await send(msg('/help'));
  assert.match(calls('sendMessage')[1].payload.text, /راهنمای ربات/);
  assert.match(calls('sendMessage')[1].payload.text, /50 MB/);
});

test('invalid text is rejected with the original message', async () => {
  const { send, msg, lastText } = setup();
  await send(msg('not a link'));
  assert.match(lastText(), /لینک وارد شده معتبر نیست/);
  await send(msg('http://127.0.0.1/secret'));
  assert.match(lastText(), /لینک وارد شده معتبر نیست/);
});

test('URL -> info card with only really-available qualities + MP3', async () => {
  await withFake(FAKE_OK, async () => {
    const { send, msg, calls } = setup();
    await send(msg('https://example.com/watch?v=1'));
    const edits = calls('editMessageText');
    const card = edits[edits.length - 1].payload;
    assert.match(card.text, /اطلاعات ویدیو/);
    assert.match(card.text, /My &lt;Video&gt;/);          // HTML-escaped title
    assert.match(card.text, /2:05/);
    const labels = card.reply_markup.inline_keyboard.flat().map(b => b.text);
    assert.ok(labels.includes('🎥 360p') && labels.includes('🎥 720p') && labels.includes('🎵 MP3'));
    assert.ok(!labels.includes('🎥 1080p'));               // not offered: not in source
  });
});

test('full flow: quality -> background download -> video uploaded -> counters + cleanup', async () => {
  await withFake(FAKE_OK, async () => {
    const { send, msg, cb, calls, scoped, lastText } = setup();
    await send(msg('https://example.com/watch?v=1'));
    const kb = calls('editMessageText').pop().payload.reply_markup.inline_keyboard.flat();
    const q720 = kb.find(b => b.text === '🎥 720p').callback_data;
    await send(cb(q720));
    assert.ok(await waitFor(() => calls('sendVideo').length === 1), 'video was uploaded');
    const v = calls('sendVideo')[0].payload;
    assert.match(String(v.video), /Test Video\.mp4$/);
    assert.match(v.caption, /My &lt;Video&gt;/);
    assert.ok(await waitFor(() => /دانلود کامل شد/.test(lastText())), 'final message');
    const u = await scoped.get('user_42');
    assert.equal(u.downloads, 1);
    assert.equal(C.USER_ACTIVE.size, 0);
  });
});

test('MP3 quality uploads audio', async () => {
  await withFake(FAKE_OK, async () => {
    const { send, msg, cb, calls } = setup();
    await send(msg('https://example.com/a'));
    const kb = calls('editMessageText').pop().payload.reply_markup.inline_keyboard.flat();
    await send(cb(kb.find(b => b.text === '🎵 MP3').callback_data));
    assert.ok(await waitFor(() => calls('sendAudio').length === 1));
    assert.match(String(calls('sendAudio')[0].payload.audio), /\.mp3$/);
  });
});

test('another user cannot press someone else\'s quality button', async () => {
  await withFake(FAKE_OK, async () => {
    const { send, msg, cb, calls } = setup();
    await send(msg('https://example.com/a', 42));
    const data = calls('editMessageText').pop().payload.reply_markup.inline_keyboard.flat().find(b => b.text === '🎥 360p').callback_data;
    await send(cb(data, 99));
    const a = calls('answerCallbackQuery').pop().payload;
    assert.match(a.text, /دسترسی غیرمجاز/);
    assert.equal(calls('sendVideo').length, 0);
  });
});

test('oversized file is refused with the original message and not uploaded', async () => {
  await withFake(FAKE_OK, async () => {
    const { send, msg, cb, calls, scoped, lastText } = setup();
    await scoped.set('settings', { maxMb: 1 });
    // make the fake write > 1MB
    const big = FAKE_OK.replace('head -c 4096', 'head -c 2000000');
    await withFake(big, async () => {
      await send(msg('https://example.com/big'));
      const kb = calls('editMessageText').pop().payload.reply_markup.inline_keyboard.flat();
      await send(cb(kb.find(b => b.text === '🎥 360p').callback_data));
      assert.ok(await waitFor(() => /حجم فایل بیشتر از حد مجاز/.test(lastText())));
      assert.equal(calls('sendVideo').length, 0);
    });
  });
});

test('cancel button aborts a running download', async () => {
  const SLOW = FAKE_OK.replace('echo "PROG 100 1000 NA 500 1"', 'echo "PROG 10 1000 NA 5 9"; sleep 5');
  await withFake(SLOW, async () => {
    const { send, msg, cb, calls, lastText } = setup();
    await send(msg('https://example.com/slow'));
    const kb = calls('editMessageText').pop().payload.reply_markup.inline_keyboard.flat();
    await send(cb(kb.find(b => b.text === '🎥 360p').callback_data));
    const cancelBtn = calls('editMessageText').pop().payload.reply_markup.inline_keyboard[0][0];
    assert.match(cancelBtn.callback_data, /^vd:cancel:/);
    await send(cb(cancelBtn.callback_data));
    assert.ok(await waitFor(() => /دانلود لغو شد/.test(lastText()), 5000), 'cancelled message');
    assert.equal(calls('sendVideo').length, 0);
    assert.equal(C.USER_ACTIVE.size, 0);
  });
});

test('second URL while a download is active is blocked (one per user)', async () => {
  const SLOW = FAKE_OK.replace('echo "PROG 100 1000 NA 500 1"', 'sleep 2');
  await withFake(SLOW, async () => {
    const { send, msg, cb, calls, lastText } = setup();
    await send(msg('https://example.com/slow'));
    const kb = calls('editMessageText').pop().payload.reply_markup.inline_keyboard.flat();
    await send(cb(kb.find(b => b.text === '🎥 360p').callback_data));
    await send(msg('https://example.com/other'));
    assert.match(lastText(), /یک دانلود برای شما در حال انجام است/);
    assert.ok(await waitFor(() => calls('sendVideo').length === 1, 6000));
  });
});

test('engine missing gives a clear message instead of crashing', async () => {
  const { send, msg, lastText } = setup();
  const old = process.env.PATH; process.env.PATH = '/nonexistent';
  try { await send(msg('https://example.com/a')); } finally { process.env.PATH = old; }
  assert.match(lastText(), /موتور دانلود روی سرور نصب نیست/);
});

test('banned users are blocked; admin can ban/unban via panel', async () => {
  await withFake(FAKE_OK, async () => {
    const { send, msg, cb, lastText, scoped } = setup();
    await send(msg('/start', 42));
    await send(cb('vd:ad:ban:42', OWNER));
    assert.equal((await scoped.get('user_42')).banned, true);
    await send(msg('https://example.com/a', 42));
    assert.match(lastText(), /مسدود شده‌اید/);
    await send(cb('vd:ad:unban:42', OWNER));
    assert.equal((await scoped.get('user_42')).banned, false);
  });
});

test('admin panel is owner-only (commands and buttons)', async () => {
  const { send, msg, cb, calls, lastText } = setup();
  await send(msg('/admin', 42));
  assert.match(lastText(), /دسترسی غیرمجاز/);
  await send(cb('vd:ad:stats', 42));
  assert.match(calls('answerCallbackQuery').pop().payload.text, /دسترسی غیرمجاز/);
  await send(msg('/admin', OWNER));
  assert.match(lastText(), /پنل مدیریت/);
  await send(msg('/stats', OWNER));
  assert.match(lastText(), /آمار سیستم/);
});

test('admin settings: size cap is clamped to the Telegram 50MB limit; concurrency validated', async () => {
  const { send, msg, cb, scoped, lastText } = setup();
  await send(cb('vd:ad:set:size', OWNER));
  await send(msg('2000', OWNER));
  assert.match(lastText(), /عدد بین ۱ تا 50/);
  await send(msg('20', OWNER));
  assert.equal((await scoped.get('settings')).maxMb, 20);
  await send(cb('vd:ad:set:conc', OWNER));
  await send(msg('99', OWNER));
  assert.match(lastText(), /عدد بین ۱ تا ۱۰/);
  await send(msg('3', OWNER));
  assert.equal((await scoped.get('settings')).concurrency, 3);
});

test('broadcast: preview -> confirm -> delivered to non-banned users only', async () => {
  const { send, msg, cb, calls } = setup();
  await send(msg('/start', 42)); await send(msg('/start', 43));
  await send(cb('vd:ad:ban:43', OWNER));
  clearMockCalls();
  await send(cb('vd:ad:bcast', OWNER));
  await send(msg('hello <b>all</b>', OWNER));
  await send(cb('vd:ad:bcyes', OWNER));
  const to = calls('sendMessage').filter(c => /hello/.test(c.payload.text)).map(c => c.payload.chat_id).filter(id => id !== OWNER);
  assert.deepEqual(to.sort(), [42]);
});

test('force join: non-member is blocked, member passes and the pending URL resumes', async () => {
  await withFake(FAKE_OK, async () => {
    const { send, msg, cb, calls, scoped, lastText, bot } = setup();
    await scoped.set('settings', { forceJoin: true });
    await scoped.set('force_join', [{ id: 'a1', chat_id: '@chan', title: 'MyChan', username: 'chan', active: true }]);

    // The mock always says "member", so override getChatMember to simulate a real non-member.
    const tg = require('../src/telegram');
    const realApi = tg.createTelegramApi('123456789:ABCdefGHIjklMNOpqrsTUVwxyZ12345', { mock: true });
    let isMember = false;
    const api = { ...realApi, getChatMember: async () => ({ ok: true, result: { status: isMember ? 'member' : 'left' } }) };
    const h = update => template.handle({ update, bot, db: scoped, api });

    await h(msg('https://example.com/a', 42));
    assert.match(lastText(), /عضویت اجباری/);
    assert.match(lastText(), /MyChan/);
    assert.equal(calls('editMessageText').filter(x => /اطلاعات ویدیو/.test(x.payload.text)).length, 0, 'no info card for non-member');
    const kb = calls('sendMessage').pop().payload.reply_markup.inline_keyboard.flat();
    assert.ok(kb.some(b => b.url === 'https://t.me/chan'));
    assert.ok(kb.some(b => b.callback_data === 'vd:fjcheck'));

    // pressing "check" while still not a member keeps them blocked
    await h(cb('vd:fjcheck', 42));
    assert.match(calls('answerCallbackQuery').pop().payload.text, /هنوز در همه کانال/);

    // after joining, "check" resumes the saved URL and shows the info card
    isMember = true;
    await h(cb('vd:fjcheck', 42));
    assert.ok(await waitFor(() => calls('editMessageText').some(x => /اطلاعات ویدیو/.test(x.payload.text))), 'info card after joining');
  });
});

test('force join is skipped when the system is switched off', async () => {
  await withFake(FAKE_OK, async () => {
    const { send, msg, calls, scoped } = setup();
    await scoped.set('settings', { forceJoin: false });
    await scoped.set('force_join', [{ id: 'a1', chat_id: '@chan', title: 'MyChan', active: true }]);
    await send(msg('https://example.com/a', 42));
    assert.ok(calls('editMessageText').some(x => /اطلاعات ویدیو/.test(x.payload.text)));
  });
});

test('force join admin: add / list / toggle / remove', async () => {
  const { send, msg, cb, scoped, lastText } = setup();
  await send(cb('vd:fja:add', OWNER));
  await send(msg('bad value!', OWNER));
  assert.match(lastText(), /فرمت نامعتبر/);
  await send(msg('@mychannel', OWNER));
  let list = await scoped.get('force_join');
  assert.equal(list.length, 1);
  assert.equal(list[0].active, true);
  await send(cb(`vd:fja:en:${list[0].id}`, OWNER));
  assert.equal((await scoped.get('force_join'))[0].active, false);
  await send(cb(`vd:fja:rm:${list[0].id}`, OWNER));
  assert.equal((await scoped.get('force_join')).length, 0);
});

test('/cancel with nothing running', async () => {
  const { send, msg, lastText } = setup();
  await send(msg('/cancel'));
  assert.match(lastText(), /چیزی برای لغو وجود ندارد/);
});
