'use strict';

const { escapeHtml } = require('../../utils/html');
const C = require('./video_downloader');
const { TG_LIMIT_MB } = require('./services');

async function allUsers(db) {
  const ids = (await db.get('user_index')) || [];
  const users = [];
  for (const id of ids) { const u = await db.get(`user_${id}`); if (u) users.push(u); }
  return users;
}

async function statsText(db) {
  const users = await allUsers(db);
  const log = (await db.get('log_count')) || { ok: 0, fail: 0 };
  const banned = users.filter(u => u.banned).length;
  return '📊 <b>آمار سیستم</b>\n\n' +
    `👥 کاربران: ${users.length}\n🚫 مسدودشده: ${banned}\n` +
    `✅ دانلود موفق: ${log.ok}\n❌ دانلود ناموفق: ${log.fail}\n` +
    `⏳ دانلود فعال: ${C.USER_ACTIVE.size}`;
}

async function settingsText(db) {
  const s = await C.getSettings(db);
  return '⚙️ <b>تنظیمات</b>\n\n' +
    `🔗 Force Join: ${s.forceJoin ? '✅ فعال' : '⛔️ غیرفعال'}\n` +
    `📦 حداکثر حجم فایل: <b>${s.maxMb} MB</b> (سقف تلگرام: ${TG_LIMIT_MB} MB)\n` +
    `⚡ دانلود همزمان: <b>${s.concurrency}</b>`;
}

function userCardText(u) {
  return '👤 <b>اطلاعات کاربر</b>\n\n' +
    `🆔 شناسه: <code>${u.id}</code>\n` +
    `📛 نام: ${escapeHtml(u.first_name || '-')}\n` +
    `🔗 یوزرنیم: ${u.username ? '@' + escapeHtml(u.username) : '-'}\n` +
    `📥 دانلودها: ${u.downloads || 0}\n📅 عضویت: ${u.joined || '-'}\n` +
    `🚫 وضعیت: ${u.banned ? 'مسدود' : 'فعال'}`;
}
const userCardKb = u => ({ inline_keyboard: [
  [u.banned ? { text: '♻️ رفع مسدودی', callback_data: `vd:ad:unban:${u.id}` } : { text: '🚫 مسدودسازی', callback_data: `vd:ad:ban:${u.id}`, style: 'danger' }],
  [{ text: '🔙 بازگشت', callback_data: 'vd:ad:uman' }]
] });

async function showPanel(ctx, chatId, mid) {
  const text = '👑 <b>پنل مدیریت</b>';
  return mid ? C.edit(ctx.api, chatId, mid, text, C.adminPanelKb()) : C.send(ctx.api, chatId, text, C.adminPanelKb());
}

async function doBroadcast(ctx, text) {
  const users = (await allUsers(ctx.db)).filter(u => !u.banned);
  let ok = 0, fail = 0;
  for (const u of users) {
    const res = await ctx.api.sendMessage(u.id, text, { parse_mode: 'HTML' }).catch(() => null);
    if (res && res.ok !== false) ok++; else fail++;
    await new Promise(r => setTimeout(r, 40)); // stay under Telegram flood limits
  }
  return `📢 ارسال پایان یافت.\n✅ موفق: ${ok}\n❌ ناموفق: ${fail}`;
}

async function fjListText(db) {
  const list = await C.listForceJoin(db);
  if (!list.length) return '📋 هیچ کانال/گروهی ثبت نشده است.';
  return '📋 <b>لیست عضویت اجباری</b>\n\n' + list.map(e => `${e.active ? '✅' : '⛔️'} ${escapeHtml(e.title || e.chat_id)} (<code>${escapeHtml(String(e.chat_id))}</code>)`).join('\n');
}
const fjPickKb = (list, prefix, mark) => ({ inline_keyboard: [
  ...list.map(e => [{ text: `${mark(e)} ${String(e.title || e.chat_id).slice(0, 24)}`, callback_data: `vd:fja:${prefix}:${e.id}` }]),
  [{ text: '🔙 بازگشت', callback_data: 'vd:ad:fj' }]
] });

/** Handle every admin callback. Returns true if consumed. */
async function handleAdminCallback(ctx, cb, data) {
  const { api, db } = ctx;
  const chatId = cb.message.chat.id, mid = cb.message.message_id, uid = cb.from.id;
  await api.answerCallbackQuery(cb.id).catch(() => {});
  const key = C.k(ctx.bot, uid);
  const edit = (t, kb) => C.edit(api, chatId, mid, t, kb);

  if (data === 'vd:ad:panel') { C.ADMIN_PENDING.delete(key); return showPanel(ctx, chatId, mid); }
  if (data === 'vd:ad:cancel') { C.ADMIN_PENDING.delete(key); return showPanel(ctx, chatId, mid); }
  if (data === 'vd:ad:stats') return edit(await statsText(db), C.adminBackKb());
  if (data === 'vd:ad:users') {
    const users = (await allUsers(db)).slice(-15).reverse();
    const t = '👥 <b>آخرین کاربران</b>\n\n' + (users.map(u => `• <code>${u.id}</code> ${escapeHtml(u.first_name || '')} ${u.banned ? '🚫' : ''}`).join('\n') || 'کاربری وجود ندارد.');
    return edit(t, C.adminBackKb());
  }
  if (data === 'vd:ad:uman') {
    C.ADMIN_PENDING.set(key, { action: 'user_lookup' });
    return edit('🚫 <b>مدیریت کاربران</b>\n\nشناسه عددی یا @یوزرنیم کاربر را ارسال کنید:', C.adminCancelKb());
  }
  let m;
  if ((m = data.match(/^vd:ad:(ban|unban):(\d+)$/))) {
    const u = await C.getUser(db, Number(m[2]));
    if (!u) return edit('❌ کاربر پیدا نشد.', C.adminBackKb());
    u.banned = m[1] === 'ban';
    await db.set(`user_${u.id}`, u);
    return edit(userCardText(u), userCardKb(u));
  }
  if (data === 'vd:ad:bcast') {
    C.ADMIN_PENDING.set(key, { action: 'broadcast' });
    return edit('📢 <b>پیام همگانی</b>\n\nمتن پیام را ارسال کنید (HTML مجاز است):', C.adminCancelKb());
  }
  if (data === 'vd:ad:bcyes') {
    const p = C.ADMIN_PENDING.get(key);
    if (!p || p.action !== 'broadcast_confirm') return edit('⏳ این درخواست منقضی شده است.', C.adminBackKb());
    C.ADMIN_PENDING.delete(key);
    await edit('⏳ در حال ارسال پیام همگانی...');
    const result = await doBroadcast(ctx, p.data.text);
    return C.send(api, chatId, result, C.adminBackKb());
  }
  if (data === 'vd:ad:bcno') { C.ADMIN_PENDING.delete(key); return showPanel(ctx, chatId, mid); }
  if (data === 'vd:ad:settings') { const s = await C.getSettings(db); return edit(await settingsText(db), C.settingsKb(s.forceJoin)); }
  if (data === 'vd:ad:set:fj') {
    const s = await C.getSettings(db);
    await C.setSettings(db, { forceJoin: !s.forceJoin });
    return edit(await settingsText(db), C.settingsKb(!s.forceJoin));
  }
  if (data === 'vd:ad:set:size') {
    C.ADMIN_PENDING.set(key, { action: 'set_size' });
    return edit(`📦 حداکثر حجم فایل را به مگابایت ارسال کنید (۱ تا ${TG_LIMIT_MB}):`, C.adminCancelKb());
  }
  if (data === 'vd:ad:set:conc') {
    C.ADMIN_PENDING.set(key, { action: 'set_conc' });
    return edit('⚡ تعداد دانلود همزمان را ارسال کنید (۱ تا ۱۰):', C.adminCancelKb());
  }
  if (data === 'vd:ad:fj') return edit('🔗 <b>مدیریت عضویت اجباری</b>', C.fjAdminKb());

  // ---- force-join admin (vd:fja:*) ----
  if (data === 'vd:fja:add') {
    C.ADMIN_PENDING.set(key, { action: 'fj_add' });
    return edit('➕ شناسه کانال/گروه را ارسال کنید (مثل <code>@channel</code> یا <code>-100123...</code>).\nربات باید در آن ادمین/عضو باشد.', C.adminCancelKb());
  }
  if (data === 'vd:fja:list') return edit(await fjListText(db), { inline_keyboard: [[{ text: '🔙 بازگشت', callback_data: 'vd:ad:fj' }]] });
  if (data === 'vd:fja:remove') {
    const list = await C.listForceJoin(db);
    return edit(list.length ? '❌ کدام حذف شود؟' : '📋 هیچ موردی ثبت نشده است.', fjPickKb(list, 'rm', () => '🗑'));
  }
  if (data === 'vd:fja:toggle') {
    const list = await C.listForceJoin(db);
    const s = await C.getSettings(db);
    return edit(`🔗 سیستم: ${s.forceJoin ? '✅ فعال' : '⛔️ غیرفعال'}\nبرای فعال/غیرفعال کردن هر مورد روی آن بزنید:`, {
      inline_keyboard: [
        [{ text: `🔗 سیستم: ${s.forceJoin ? '✅ فعال' : '⛔️ غیرفعال'}`, callback_data: 'vd:fja:global' }],
        ...list.map(e => [{ text: `${e.active ? '✅' : '⛔️'} ${String(e.title || e.chat_id).slice(0, 22)}`, callback_data: `vd:fja:en:${e.id}` }]),
        [{ text: '🔙 بازگشت', callback_data: 'vd:ad:fj' }]
      ]
    });
  }
  if (data === 'vd:fja:global') {
    const s = await C.getSettings(db);
    await C.setSettings(db, { forceJoin: !s.forceJoin });
    return handleAdminCallback(ctx, { ...cb, id: cb.id }, 'vd:fja:toggle');
  }
  if ((m = data.match(/^vd:fja:(rm|en):(\w+)$/))) {
    let list = await C.listForceJoin(db);
    if (m[1] === 'rm') list = list.filter(e => e.id !== m[2]);
    else list = list.map(e => e.id === m[2] ? { ...e, active: !e.active } : e);
    await C.saveForceJoin(db, list);
    return handleAdminCallback(ctx, cb, m[1] === 'rm' ? 'vd:fja:remove' : 'vd:fja:toggle');
  }
  return false;
}

/** Handle admin free-text input. Returns true if consumed. */
async function handleAdminInput(ctx, message) {
  const { api, db, bot } = ctx;
  const chatId = message.chat.id, uid = message.from.id;
  const key = C.k(bot, uid);
  const pending = C.ADMIN_PENDING.get(key);
  if (!pending) return false;
  const text = (message.text || '').trim();

  if (pending.action === 'user_lookup') {
    const users = await allUsers(db);
    const q = text.replace(/^@/, '').toLowerCase();
    const u = users.find(x => String(x.id) === q || (x.username && x.username.toLowerCase() === q));
    C.ADMIN_PENDING.delete(key);
    if (!u) { await C.send(api, chatId, '❌ کاربر پیدا نشد.', C.adminBackKb()); return true; }
    await C.send(api, chatId, userCardText(u), userCardKb(u));
    return true;
  }
  if (pending.action === 'broadcast') {
    if (!text) return true;
    C.ADMIN_PENDING.set(key, { action: 'broadcast_confirm', data: { text } });
    await C.send(api, chatId, `📢 <b>پیش‌نمایش پیام همگانی:</b>\n\n${text}\n\nارسال شود؟`, C.broadcastConfirmKb());
    return true;
  }
  if (pending.action === 'set_size') {
    const n = parseInt(text, 10);
    if (!(n >= 1 && n <= TG_LIMIT_MB)) { await C.send(api, chatId, `❌ عدد بین ۱ تا ${TG_LIMIT_MB} وارد کنید.`); return true; }
    await C.setSettings(db, { maxMb: n });
    C.ADMIN_PENDING.delete(key);
    const s = await C.getSettings(db);
    await C.send(api, chatId, await settingsText(db), C.settingsKb(s.forceJoin));
    return true;
  }
  if (pending.action === 'set_conc') {
    const n = parseInt(text, 10);
    if (!(n >= 1 && n <= 10)) { await C.send(api, chatId, '❌ عدد بین ۱ تا ۱۰ وارد کنید.'); return true; }
    await C.setSettings(db, { concurrency: n });
    C.ADMIN_PENDING.delete(key);
    const s = await C.getSettings(db);
    await C.send(api, chatId, await settingsText(db), C.settingsKb(s.forceJoin));
    return true;
  }
  if (pending.action === 'fj_add') {
    const raw = text.replace(/^https?:\/\/t\.me\//i, '@');
    if (!/^(@[A-Za-z0-9_]{4,}|-?\d{5,})$/.test(raw)) { await C.send(api, chatId, '❌ فرمت نامعتبر است. مثل @channel یا -100123...'); return true; }
    const chat = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    const info = typeof api.getChat === 'function' ? await api.getChat(chat).catch(() => null) : null;
    const r = info && info.result;
    const list = await C.listForceJoin(db);
    list.push({
      id: Math.random().toString(36).slice(2, 8), chat_id: raw,
      title: (r && r.title) || raw, username: (r && r.username) || (raw.startsWith('@') ? raw.slice(1) : null),
      invite_link: (r && r.invite_link) || null, active: true
    });
    await C.saveForceJoin(db, list);
    C.ADMIN_PENDING.delete(key);
    await C.send(api, chatId, '✅ افزوده شد. (برای بررسی عضویت، ربات باید در آن ادمین/عضو باشد.)', C.fjAdminKb());
    return true;
  }
  C.ADMIN_PENDING.delete(key);
  return false;
}

module.exports = { handleAdminCallback, handleAdminInput, showPanel, statsText };
