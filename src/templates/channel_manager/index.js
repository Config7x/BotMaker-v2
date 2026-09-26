'use strict';

const { escapeHtml } = require('../../utils/html');

module.exports = {
  id: 'channel_manager',
  category: 'publishing',
  name: 'مدیریت کانال (Channel Manager)',
  description: 'دستورات متمرکز کانال: ارسال پست، پین کردن و اطلاعات کانال. این ربات جایگزین کامل دسترسی‌های ادمین نیست (بدون مدیریت بن/دسترسی).',
  features: ['پست سریع به کانال', 'پین کردن پیام', 'اطلاعات کانال'],
  async handle({ update, bot, api, db }) {
    const msg = update.message;
    if (!msg) return;
    const isOwner = (id) => Number(id) === Number(bot.owner_id);
    if (!isOwner(msg.from.id)) return api.sendMessage(msg.chat.id, '⛔️ فقط مالک ربات مجاز است.');
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    const settings = (await db.get('settings')) || {};
    const channel = settings.channel;

    if (text.startsWith('/start') || text === '/help') {
      return api.sendMessage(chatId,
        `📢 <b>مدیر کانال</b>\n\n• <code>/setchannel @channel</code> — تنظیم کانال (ربات باید ادمین باشد)\n• <code>/post متن</code> — ارسال پست به کانال\n• <code>/pin</code> — پین آخرین پست ربات در کانال\n• <code>/info</code> — اطلاعات کانال\n\n⚠️ این ربات فقط دستورات ارسال/پین/اطلاعات دارد و مدیریت بن و دسترسی‌ها را انجام نمی‌دهد.`,
        { parse_mode: 'HTML' });
    }

    if (text.startsWith('/setchannel')) {
      const ch = text.replace('/setchannel', '').trim();
      if (!ch) return api.sendMessage(chatId, 'فرمت: <code>/setchannel @channel</code>', { parse_mode: 'HTML' });
      await db.set('settings', { ...settings, channel: ch });
      return api.sendMessage(chatId, `✅ کانال تنظیم شد: ${escapeHtml(ch)}`);
    }

    if (!channel) return api.sendMessage(chatId, 'ابتدا با /setchannel کانال را تنظیم کنید.');

    if (text.startsWith('/post')) {
      const body = text.replace('/post', '').trim();
      if (!body) return api.sendMessage(chatId, 'فرمت: <code>/post متن</code>', { parse_mode: 'HTML' });
      try {
        const r = await api.sendMessage(channel, escapeHtml(body), { parse_mode: 'HTML' });
        await db.set('last_message_id', r.result?.message_id || null);
        return api.sendMessage(chatId, '✅ پست ارسال شد.');
      } catch (e) {
        return api.sendMessage(chatId, `❌ ارسال ناموفق: ${escapeHtml(e.message)} (ربات ادمین کانال است؟)`, { parse_mode: 'HTML' });
      }
    }

    if (text === '/pin') {
      const mid = await db.get('last_message_id');
      if (!mid) return api.sendMessage(chatId, 'ابتدا با /post یک پست ارسال کنید.');
      try {
        await api.pinChatMessage(channel, mid, { disable_notification: true });
        return api.sendMessage(chatId, '📌 پست پین شد.');
      } catch (e) {
        return api.sendMessage(chatId, `❌ پین ناموفق: ${escapeHtml(e.message)}`, { parse_mode: 'HTML' });
      }
    }

    if (text === '/info') {
      const me = await api.getMe();
      return api.sendMessage(chatId,
        `ℹ️ <b>اطلاعات</b>\nکانال: ${escapeHtml(channel)}\nربات: @${escapeHtml(me.result?.username || '')}\nآخرین ارسال ربات: <code>${mid || 'ندارد'}</code>`.replace('mid', await db.get('last_message_id') || 'ندارد'),
        { parse_mode: 'HTML' });
    }
  }
};
