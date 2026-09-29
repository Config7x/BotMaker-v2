'use strict';

const C = require('./video_downloader');
const Admin = require('./admin');
const S = require('./services');
const { T } = require('./texts');
const { escapeHtml } = require('../../utils/html');

async function maxMb(db) { return (await C.getSettings(db)).maxMb; }

async function handleCallback(ctx, cb) {
  const { api, db, bot } = ctx;
  const data = cb.data || '';
  if (!data.startsWith('vd:') || !cb.message) return;
  const chatId = cb.message.chat.id, mid = cb.message.message_id, uid = cb.from.id;
  const isOwner = uid === bot.owner_id;

  // admin-only areas
  if (data.startsWith('vd:ad:') || data.startsWith('vd:fja:')) {
    if (!isOwner) return api.answerCallbackQuery(cb.id, { text: T.notAdmin, show_alert: true }).catch(() => {});
    return Admin.handleAdminCallback(ctx, cb, data);
  }

  if (data.startsWith('vd:q:')) return C.handleQualitySelected(ctx, cb, data);
  if (data.startsWith('vd:cancel:')) return C.handleCancel(ctx, cb, data.slice('vd:cancel:'.length));

  await api.answerCallbackQuery(cb.id).catch(() => {});
  if (data === 'vd:menu') return C.edit(api, chatId, mid, T.welcome, C.mainMenu());
  if (data === 'vd:help') return C.edit(api, chatId, mid, T.help(await maxMb(db)), C.backMenu());
  if (data === 'vd:dl') return C.edit(api, chatId, mid, T.sendLink, C.backMenu());
  if (data === 'vd:stats') {
    const u = (await C.getUser(db, uid)) || (await C.upsertUser(db, cb.from));
    return C.edit(api, chatId, mid, T.stats(uid, u.downloads || 0, u.joined), C.backMenu());
  }
  if (data === 'vd:fjcheck') {
    const entries = (await C.listForceJoin(db)).filter(e => e.active);
    const { allowed, missing } = await C.checkMembership(api, uid, entries);
    if (!allowed) {
      await api.answerCallbackQuery(cb.id, { text: T.fjStillMissing, show_alert: true }).catch(() => {});
      return C.edit(api, chatId, mid, T.fjPage(missing), C.forceJoinKeyboard(missing));
    }
    const pending = C.PENDING_URL.get(C.k(bot, uid));
    if (pending) {
      C.PENDING_URL.delete(C.k(bot, uid));
      return C.processUrl(ctx, chatId, uid, pending.url, mid);
    }
    return C.edit(api, chatId, mid, T.fjOk, C.mainMenu());
  }
}

async function handleMessage(ctx, message) {
  const { api, db, bot } = ctx;
  const chatId = message.chat && message.chat.id;
  const from = message.from;
  if (!chatId || !from || message.chat.type !== 'private') return;
  const text = (message.text || '').trim();
  const isOwner = from.id === bot.owner_id;

  await C.upsertUser(db, from);
  const user = await C.getUser(db, from.id);

  // ---- commands ----
  if (/^\/start(\s|$)/.test(text)) return C.send(api, chatId, T.welcome, C.mainMenu());
  if (/^\/help(\s|$)/.test(text)) return C.send(api, chatId, T.help(await maxMb(db)), C.backMenu());
  if (/^\/(admin|stats)(\s|$)/.test(text)) {
    if (!isOwner) return C.send(api, chatId, T.notAdmin);
    return /^\/stats/.test(text) ? C.send(api, chatId, await Admin.statsText(db), C.adminBackKb()) : Admin.showPanel(ctx, chatId);
  }
  if (/^\/cancel(\s|$)/.test(text)) {
    const key = C.k(bot, from.id);
    const tok = C.USER_ACTIVE.get(key);
    const sess = tok && C.SESSIONS.get(tok);
    if (sess) {
      if (sess.state) sess.state.cancelled = true;
      sess.status = 'cancelled';
      return C.send(api, chatId, T.cancelRequestedWait);
    }
    if (C.ADMIN_PENDING.has(key)) { C.ADMIN_PENDING.delete(key); return C.send(api, chatId, '❌ عملیات فعلی لغو شد.'); }
    return C.send(api, chatId, T.nothingToCancel);
  }

  // ---- admin free-text input (settings, broadcast, ban lookup, force-join add) ----
  if (isOwner && (await Admin.handleAdminInput(ctx, message))) return;

  if (!text || text.startsWith('/')) return;

  // ---- URL flow ----
  const url = S.normalizeUrl(text);
  if (!S.isSafeHttpUrl(url)) return C.send(api, chatId, T.invalidUrl);
  if (user && user.banned) return C.send(api, chatId, T.banned);
  if (C.USER_ACTIVE.has(C.k(bot, from.id))) return C.send(api, chatId, T.activeExists);
  if (!(await C.gateForceJoin(ctx, chatId, from.id, url))) return;
  return C.processUrl(ctx, chatId, from.id, url);
}

async function handle({ update, bot, api, db }) {
  const ctx = { api, db, bot };
  if (update.callback_query) return handleCallback(ctx, update.callback_query);
  if (update.message) return handleMessage(ctx, update.message);
}

module.exports = { id: 'video_downloader', name: 'دانلودر ویدیو', handle };
