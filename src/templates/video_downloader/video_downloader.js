'use strict';

const crypto = require('crypto');
const { escapeHtml } = require('../../utils/html');
const S = require('./services');
const { T, QUALITY_LABELS } = require('./texts');

// ---------------------------------------------------------------------------
// In-memory state (per process). Downloads are short-lived, so this is fine;
// persistent things (users, bans, settings, force-join) live in the bot's db.
// ---------------------------------------------------------------------------
const SESSIONS = new Map();      // token -> session
const USER_ACTIVE = new Map();   // key(botId:userId) -> token
const USER_EXTRACTING = new Set();
const PENDING_URL = new Map();   // key -> { url, ts }
const ADMIN_PENDING = new Map(); // key -> { action, data }
let globalActive = 0;            // concurrent downloads across the process
const waiters = [];              // queue for the concurrency limiter

const SESSION_TTL = 45 * 60 * 1000;
const PENDING_URL_TTL = 30 * 60 * 1000;
const PROGRESS_INTERVAL = 2000;
const DEFAULT_MAX_MB = S.TG_LIMIT_MB;
const DEFAULT_CONCURRENCY = 2;

const k = (bot, uid) => `${bot.id}:${uid}`;

setInterval(() => {
  const now = Date.now();
  for (const [tok, s] of SESSIONS) {
    if (s.status !== 'downloading' && now - s.created > SESSION_TTL) SESSIONS.delete(tok);
  }
  for (const [key, v] of PENDING_URL) if (now - v.ts > PENDING_URL_TTL) PENDING_URL.delete(key);
  for (const [key, tok] of USER_ACTIVE) if (!SESSIONS.has(tok)) USER_ACTIVE.delete(key);
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Settings / users / bans / force-join (persisted via the scoped db)
// ---------------------------------------------------------------------------
async function getSettings(db) {
  const s = (await db.get('settings')) || {};
  return {
    maxMb: Math.min(Number(s.maxMb) || DEFAULT_MAX_MB, S.TG_LIMIT_MB),
    concurrency: Math.max(1, Number(s.concurrency) || DEFAULT_CONCURRENCY),
    forceJoin: s.forceJoin === true
  };
}
async function setSettings(db, patch) {
  const cur = (await db.get('settings')) || {};
  await db.set('settings', { ...cur, ...patch });
}
async function getUser(db, id) { return (await db.get(`user_${id}`)) || null; }
async function upsertUser(db, from) {
  const cur = await getUser(db, from.id);
  const user = cur || { id: from.id, downloads: 0, joined: new Date().toISOString().slice(0, 10), banned: false };
  user.username = from.username || null;
  user.first_name = from.first_name || null;
  await db.set(`user_${from.id}`, user);
  if (!cur) {
    const idx = (await db.get('user_index')) || [];
    idx.push(from.id);
    await db.set('user_index', idx);
  }
  return user;
}
async function listForceJoin(db) { return (await db.get('force_join')) || []; }
async function saveForceJoin(db, list) { await db.set('force_join', list); }

async function checkMembership(api, userId, entries) {
  const missing = [];
  for (const e of entries) {
    if (!e.active) continue;
    try {
      const chat = /^-?\d+$/.test(String(e.chat_id)) ? Number(e.chat_id) : e.chat_id;
      const res = await api.getChatMember(chat, userId);
      const st = res && res.result && res.result.status;
      const ok = st && (['member', 'administrator', 'creator'].includes(st) || (st === 'restricted' && res.result.is_member));
      if (!ok) missing.push(e);
    } catch (_) { missing.push(e); }
  }
  return { allowed: missing.length === 0, missing };
}

function forceJoinKeyboard(entries) {
  const rows = [];
  for (const e of entries) {
    const link = e.invite_link || (e.username ? `https://t.me/${String(e.username).replace(/^@/, '')}` : null);
    if (!link) continue;
    rows.push([{ text: `🔗 عضویت | ${String(e.title || 'کانال').slice(0, 20)}`, url: link }]);
  }
  rows.push([{ text: '✅ بررسی عضویت', callback_data: 'vd:fjcheck', style: 'primary' }]);
  return { inline_keyboard: rows };
}

// ---------------------------------------------------------------------------
// Keyboards (labels identical to the original)
// ---------------------------------------------------------------------------
const mainMenu = () => ({ inline_keyboard: [
  [{ text: '🎬 دانلود ویدیو', callback_data: 'vd:dl', style: 'primary' }],
  [{ text: '📊 آمار من', callback_data: 'vd:stats' }, { text: 'ℹ️ راهنما', callback_data: 'vd:help' }]
] });
const backMenu = () => ({ inline_keyboard: [[{ text: '🔙 منوی اصلی', callback_data: 'vd:menu' }]] });
const cancelKb = tok => ({ inline_keyboard: [[{ text: '❌ لغو دانلود', callback_data: `vd:cancel:${tok}`, style: 'danger' }]] });

function qualitiesKb(tok, qualities, includeMp3) {
  const all = [...qualities, ...(includeMp3 ? ['mp3'] : [])];
  const rows = [];
  for (let i = 0; i < all.length; i += 2) {
    rows.push(all.slice(i, i + 2).map(q => ({ text: QUALITY_LABELS[q] || q, callback_data: `vd:q:${tok}:${q}`, style: 'primary' })));
  }
  rows.push([{ text: '❌ انصراف', callback_data: `vd:cancel:${tok}` }]);
  return { inline_keyboard: rows };
}

const adminPanelKb = () => ({ inline_keyboard: [
  [{ text: '📊 آمار', callback_data: 'vd:ad:stats' }, { text: '👥 کاربران', callback_data: 'vd:ad:users' }],
  [{ text: '🚫 مدیریت کاربران', callback_data: 'vd:ad:uman' }],
  [{ text: '📢 پیام همگانی', callback_data: 'vd:ad:bcast' }],
  [{ text: '🔗 Force Join', callback_data: 'vd:ad:fj' }],
  [{ text: '⚙️ تنظیمات', callback_data: 'vd:ad:settings' }],
  [{ text: '🔙 منوی اصلی', callback_data: 'vd:menu' }]
] });
const adminBackKb = () => ({ inline_keyboard: [[{ text: '🔙 بازگشت', callback_data: 'vd:ad:panel' }]] });
const adminCancelKb = () => ({ inline_keyboard: [[{ text: '❌ لغو', callback_data: 'vd:ad:cancel' }]] });
const settingsKb = fj => ({ inline_keyboard: [
  [{ text: `🔗 Force Join: ${fj ? '✅ فعال' : '⛔️ غیرفعال'}`, callback_data: 'vd:ad:set:fj' }],
  [{ text: '📦 تغییر حداکثر حجم', callback_data: 'vd:ad:set:size' }],
  [{ text: '⚡ تغییر دانلود همزمان', callback_data: 'vd:ad:set:conc' }],
  [{ text: '🔙 بازگشت', callback_data: 'vd:ad:panel' }]
] });
const fjAdminKb = () => ({ inline_keyboard: [
  [{ text: '➕ افزودن', callback_data: 'vd:fja:add' }],
  [{ text: '📋 لیست', callback_data: 'vd:fja:list' }],
  [{ text: '❌ حذف', callback_data: 'vd:fja:remove' }],
  [{ text: '🔄 فعال/غیرفعال', callback_data: 'vd:fja:toggle' }],
  [{ text: '🔙 بازگشت', callback_data: 'vd:ad:panel' }]
] });
const broadcastConfirmKb = () => ({ inline_keyboard: [[
  { text: '✅ ارسال', callback_data: 'vd:ad:bcyes', style: 'primary' },
  { text: '❌ لغو', callback_data: 'vd:ad:bcno' }
]] });

// ---------------------------------------------------------------------------
// Small send helpers
// ---------------------------------------------------------------------------
const HTML = { parse_mode: 'HTML' };
const send = (api, chat, text, kb) => api.sendMessage(chat, text, { ...HTML, ...(kb ? { reply_markup: kb } : {}) });
async function edit(api, chat, mid, text, kb) {
  const res = await api.editMessageText(chat, mid, text, { ...HTML, ...(kb ? { reply_markup: kb } : {}) }).catch(() => null);
  if (!res || res.ok === false) {
    const d = (res && res.description) || '';
    if (/not modified/i.test(d)) return res;
    return send(api, chat, text, kb);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Concurrency limiter (asyncio.Semaphore equivalent)
// ---------------------------------------------------------------------------
async function acquire(limit) {
  if (globalActive < limit) { globalActive++; return; }
  await new Promise(resolve => waiters.push(resolve));
  globalActive++;
}
function release() {
  globalActive = Math.max(0, globalActive - 1);
  const next = waiters.shift();
  if (next) next();
}

// ---------------------------------------------------------------------------
// Download worker (runs in background; never blocks the webhook)
// ---------------------------------------------------------------------------
function progressText(state) {
  if (state.phase === 'processing') return '⚙️ در حال پردازش فایل...';
  if (state.phase === 'uploading') return '📤 در حال ارسال فایل به تلگرام...';
  const pct = state.percent || 0;
  let t = `⏬ <b>در حال دانلود...</b>\n\n${S.progressBar(pct)} ${pct.toFixed(1)}%`;
  if (state.total) t += `\n📦 ${S.formatSize(state.downloaded) || '0 B'} / ${S.formatSize(state.total)}`;
  if (state.speed) t += `\n🚀 سرعت: ${S.formatSize(state.speed)}/s`;
  if (state.eta) t += `\n⏱ زمان باقی‌مانده: ${S.formatDuration(state.eta)}`;
  return t;
}

async function downloadWorker({ api, db, bot }, session, progressMsgId) {
  const { token, chatId, userId } = session;
  const state = session.state;
  let file = null, finalSize = null, outcome = 'failed', finalText = T.unexpected;

  const settings = await getSettings(db);
  let lastText = '';
  const updater = setInterval(() => {
    if (state.finished) return;
    const text = progressText(state);
    if (text !== lastText) {
      lastText = text;
      api.editMessageText(chatId, progressMsgId, text, { ...HTML, reply_markup: cancelKb(token) }).catch(() => {});
    }
  }, PROGRESS_INTERVAL);

  try {
    await acquire(settings.concurrency);
    try {
      if (state.cancelled) throw new S.CancelledError();
      file = await S.download(session.url, session.quality, state);
    } finally { release(); }

    finalSize = file.size;
    if (finalSize > settings.maxMb * 1024 * 1024) {
      finalText = T.tooBig;
    } else {
      state.phase = 'uploading';
      const caption = T.caption(escapeHtml(session.title), S.formatSize(finalSize));
      const res = session.quality === 'mp3'
        ? await api.sendAudio(chatId, { path: file.path }, { caption, ...HTML, title: String(session.title || 'audio').slice(0, 60) })
        : await api.sendVideo(chatId, { path: file.path }, { caption, ...HTML, supports_streaming: true });
      if (res && res.ok === false) { finalText = T.uploadFailed; }
      else outcome = 'completed';
    }
  } catch (err) {
    if (err && err.code === 'CANCELLED') { outcome = 'cancelled'; finalText = T.cancelled; }
    else if (err && (err.message === 'ENGINE_MISSING')) finalText = T.errEngine;
    else if (err && err.message === 'FFMPEG_MISSING') finalText = T.noFfmpeg;
    else finalText = T[S.friendlyErrorKey(err)] || T.unexpected;
  } finally {
    state.finished = true;
    clearInterval(updater);
    if (file) file.cleanup();
  }

  if (outcome === 'completed') {
    try {
      const u = (await getUser(db, userId)) || {};
      u.downloads = (u.downloads || 0) + 1;
      await db.set(`user_${userId}`, { id: userId, joined: u.joined, banned: !!u.banned, username: u.username, first_name: u.first_name, downloads: u.downloads });
      const log = (await db.get('log_count')) || { ok: 0, fail: 0 };
      log.ok++; await db.set('log_count', log);
    } catch (_) { /* counters are best-effort */ }
    finalText = T.done(escapeHtml(session.title), S.formatSize(finalSize));
  } else {
    try { const log = (await db.get('log_count')) || { ok: 0, fail: 0 }; log.fail++; await db.set('log_count', log); } catch (_) {}
  }

  USER_ACTIVE.delete(k(bot, userId));
  SESSIONS.delete(token);
  await edit(api, chatId, progressMsgId, finalText);
}

// ---------------------------------------------------------------------------
// URL processing
// ---------------------------------------------------------------------------
async function gateForceJoin(ctx, chatId, userId, url, editMsgId) {
  const { api, db, bot } = ctx;
  const settings = await getSettings(db);
  if (!settings.forceJoin) return true;
  const entries = (await listForceJoin(db)).filter(e => e.active);
  if (!entries.length) return true;
  const { allowed, missing } = await checkMembership(api, userId, entries);
  if (allowed) return true;
  if (url) PENDING_URL.set(k(bot, userId), { url, ts: Date.now() });
  const text = T.fjPage(missing);
  if (editMsgId) await edit(api, chatId, editMsgId, text, forceJoinKeyboard(missing));
  else await send(api, chatId, text, forceJoinKeyboard(missing));
  return false;
}

async function processUrl(ctx, chatId, userId, url, statusMsgId) {
  const { api, db, bot } = ctx;
  const key = k(bot, userId);
  const user = await getUser(db, userId);
  if (user && user.banned) return send(api, chatId, T.banned);
  if (USER_ACTIVE.has(key)) return send(api, chatId, T.activeExistsShort);
  if (USER_EXTRACTING.has(key)) return send(api, chatId, T.extractingBusy);

  USER_EXTRACTING.add(key);
  let statusId = statusMsgId;
  if (statusId) await edit(api, chatId, statusId, T.extracting);
  else {
    const m = await send(api, chatId, T.extracting);
    statusId = m && m.result && m.result.message_id;
  }
  let info;
  try {
    info = await S.extractInfo(url);
  } catch (err) {
    const msg = err && err.message === 'ENGINE_MISSING' ? T.errEngine : (T[S.friendlyErrorKey(err)] || T.errInfo);
    USER_EXTRACTING.delete(key);
    return edit(api, chatId, statusId, msg);
  }
  USER_EXTRACTING.delete(key);

  const qualities = S.availableQualities(info);
  const includeMp3 = S.ffmpegAvailable();
  if (!qualities.length && !includeMp3) return edit(api, chatId, statusId, T.noQuality);

  const token = crypto.randomBytes(5).toString('hex');
  const title = String(info.title || 'بدون عنوان');
  SESSIONS.set(token, {
    token, userId, chatId, url, title, status: 'ready', created: Date.now(), state: null, quality: null
  });
  const uploader = info.uploader || info.channel || info.uploader_id;
  const text = T.info(escapeHtml(title), S.formatDuration(info.duration), uploader ? escapeHtml(String(uploader)) : null, S.formatSize(S.estimateSize(info)));
  return edit(api, chatId, statusId, text, qualitiesKb(token, qualities, includeMp3));
}

async function handleQualitySelected(ctx, cb, data) {
  const { api, db, bot } = ctx;
  const chatId = cb.message.chat.id, userId = cb.from.id, mid = cb.message.message_id;
  const parts = data.split(':'); // vd:q:<token>:<quality>
  if (parts.length !== 4) return api.answerCallbackQuery(cb.id).catch(() => {});
  const [, , token, quality] = parts;
  const session = SESSIONS.get(token);

  if (!session) {
    await api.answerCallbackQuery(cb.id, { text: T.expiredToast, show_alert: true }).catch(() => {});
    return edit(api, chatId, mid, T.expired);
  }
  if (session.userId !== userId) return api.answerCallbackQuery(cb.id, { text: T.forbidden, show_alert: true }).catch(() => {});
  if (session.status !== 'ready') return api.answerCallbackQuery(cb.id, { text: T.alreadyProcessed }).catch(() => {});
  if (!S.QUALITY_FORMATS[quality]) return api.answerCallbackQuery(cb.id, { text: T.badQuality, show_alert: true }).catch(() => {});

  const user = await getUser(db, userId);
  if (user && user.banned) {
    await api.answerCallbackQuery(cb.id, { text: T.banned, show_alert: true }).catch(() => {});
    return edit(api, chatId, mid, T.banned);
  }
  const settings = await getSettings(db);
  if (settings.forceJoin) {
    const entries = (await listForceJoin(db)).filter(e => e.active);
    if (entries.length) {
      const { allowed, missing } = await checkMembership(api, userId, entries);
      if (!allowed) {
        PENDING_URL.set(k(bot, userId), { url: session.url, ts: Date.now() });
        await api.answerCallbackQuery(cb.id, { text: T.needJoinToast, show_alert: true }).catch(() => {});
        return edit(api, chatId, mid, T.fjPage(missing), forceJoinKeyboard(missing));
      }
    }
  }
  if (USER_ACTIVE.has(k(bot, userId))) {
    return api.answerCallbackQuery(cb.id, { text: T.activeExistsShort, show_alert: true }).catch(() => {});
  }
  if (quality === 'mp3' && !S.ffmpegAvailable()) {
    await api.answerCallbackQuery(cb.id, { text: T.noFfmpeg, show_alert: true }).catch(() => {});
    return edit(api, chatId, mid, T.noFfmpeg);
  }

  await api.answerCallbackQuery(cb.id, { text: T.preparing }).catch(() => {});
  session.status = 'downloading';
  session.quality = quality;
  session.state = { phase: 'downloading', percent: 0, downloaded: 0, total: 0, speed: 0, eta: 0, cancelled: false, finished: false };
  USER_ACTIVE.set(k(bot, userId), token);

  await edit(api, chatId, mid, progressText(session.state), cancelKb(token));
  // Fire-and-forget: the webhook must answer Telegram quickly.
  downloadWorker(ctx, session, mid).catch(err => console.error('video_downloader worker error:', err && err.message));
}

async function handleCancel(ctx, cb, token) {
  const { api } = ctx;
  const session = SESSIONS.get(token);
  if (!session) return api.answerCallbackQuery(cb.id, { text: T.nothingToCancelToast }).catch(() => {});
  if (session.userId !== cb.from.id) return api.answerCallbackQuery(cb.id, { text: T.forbidden, show_alert: true }).catch(() => {});
  if (session.state) session.state.cancelled = true;
  const wasReady = session.status === 'ready';
  session.status = 'cancelled';
  await api.answerCallbackQuery(cb.id, { text: T.cancelRequested }).catch(() => {});
  if (wasReady) {
    SESSIONS.delete(token);
    return edit(api, cb.message.chat.id, cb.message.message_id, T.cancelled);
  }
}

module.exports = {
  // state (exported for tests / admin module)
  SESSIONS, USER_ACTIVE, USER_EXTRACTING, PENDING_URL, ADMIN_PENDING,
  // helpers shared with the admin module
  getSettings, setSettings, getUser, upsertUser, listForceJoin, saveForceJoin, checkMembership, forceJoinKeyboard,
  mainMenu, backMenu, adminPanelKb, adminBackKb, adminCancelKb, settingsKb, fjAdminKb, broadcastConfirmKb,
  send, edit, k, gateForceJoin, processUrl, handleQualitySelected, handleCancel, T
};
