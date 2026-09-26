'use strict';

const { escapeHtml } = require('../../utils/html');

// Telegram does NOT support real button colors for regular bots —
// "colors" are emoji indicators only (🔴🟢🔵🟡⚪).
const COLORS = ['🔴', '🟢', '🔵', '🟡', '⚪️'];

module.exports = {
  id: 'post_composer',
  category: 'publishing',
  name: 'پست‌ساز (Post Composer)',
  description: 'چیدمان پست با دکمه شیشه‌ای، پیش‌نمایش و انتشار در کانالی که ربات ادمین آن است.',
  features: ['دکمه‌های شیشه‌ای با «رنگ» نمایشی (ایموجی)', 'پیش‌نمایش قبل از انتشار', 'تأیید صریح قبل از انتشار'],
  async handle({ update, bot, api, db }) {
    const msg = update.message;
    const cb = update.callback_query;
    const isOwner = (id) => Number(id) === Number(bot.owner_id);

    if (cb) {
      const chatId = cb.message?.chat?.id;
      const data = cb.data || '';
      if (data === 'post:publish') {
        const draft = await db.get('draft');
        if (!draft) return api.answerCallbackQuery(cb.id, { text: 'پیش‌نمایشی وجود ندارد.', show_alert: true });
        const settings = (await db.get('settings')) || {};
        if (!settings.channel) return api.answerCallbackQuery(cb.id, { text: 'ابتدا با /setchannel کانال را تنظیم کنید.', show_alert: true });
        try {
          await api.sendMessage(settings.channel, draft.text, { parse_mode: 'HTML', reply_markup: draft.keyboard ? { inline_keyboard: draft.keyboard } : undefined });
          await api.answerCallbackQuery(cb.id, { text: '✅ منتشر شد' });
          await api.sendMessage(chatId, '✅ پست در کانال منتشر شد.');
          await db.set('draft', null);
        } catch (e) {
          await api.answerCallbackQuery(cb.id, { text: '❌ انتشار ناموفق: ربات ادمین کانال نیست؟', show_alert: true });
        }
        return;
      }
      if (data === 'post:discard') {
        await db.set('draft', null);
        await api.answerCallbackQuery(cb.id, { text: 'پیش‌نمایش حذف شد.' });
        return;
      }
      return;
    }

    if (!msg || !isOwner(msg.from.id)) return;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (text.startsWith('/start') || text === '/help') {
      return api.sendMessage(chatId,
        `✍️ <b>پست‌ساز</b>\n\n• <code>/setchannel @channel</code> — تنظیم کانال هدف (ربات باید ادمین باشد)\n• متن پست را بفرستید تا پیش‌نمایش ساخته شود\n• <code>/button 🔴 عنوان | https://link</code> — افزودن دکمه (۵ دکمه)\n\nℹ️ «رنگ» دکمه‌ها فقط نمایشی است (ایموجی 🔴🟢🔵🟡⚪)؛ تلگرام رنگ واقعی برای بات‌های معمولی ندارد.`,
        { parse_mode: 'HTML' });
    }

    if (text.startsWith('/setchannel')) {
      const ch = text.replace('/setchannel', '').trim();
      if (!ch) return api.sendMessage(chatId, 'فرمت: <code>/setchannel @channel</code>', { parse_mode: 'HTML' });
      const s = (await db.get('settings')) || {};
      await db.set('settings', { ...s, channel: ch });
      return api.sendMessage(chatId, `✅ کانال هدف: ${escapeHtml(ch)}`);
    }

    if (text.startsWith('/button')) {
      // /button 🔴 عنوان | https://link
      const body = text.replace('/button', '').trim();
      const [colorPart, rest] = body.split(/\s+(.+)/, 2);
      const [label, url] = (rest || '').split('|').map((x) => x && x.trim());
      if (!label || !url || !/^https?:\/\//.test(url) || !COLORS.includes(colorPart)) {
        return api.sendMessage(chatId, 'فرمت: <code>/button 🔴 عنوان | https://link</code>', { parse_mode: 'HTML' });
      }
      const draft = (await db.get('draft')) || { text: '...', keyboard: [] };
      if (draft.keyboard.length >= 5) return api.sendMessage(chatId, 'حداکثر ۵ دکمه مجاز است.');
      draft.keyboard.push([{ text: `${colorPart} ${label}`, url }]);
      await db.set('draft', draft);
      return api.sendMessage(chatId, `✅ دکمه اضافه شد. پیش‌نمایش فعلی:\n\n${draft.text}\n(برای انتشار /publish را بزنید)`, { parse_mode: 'HTML' });
    }

    if (text === '/publish') {
      const draft = await db.get('draft');
      if (!draft) return api.sendMessage(chatId, 'پیش‌نمایشی برای انتشار وجود ندارد. ابتدا متن پست را بفرستید.');
      return api.sendMessage(chatId, draft.text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            ...(draft.keyboard || []),
            [{ text: '✅ تأیید و انتشار', callback_data: 'post:publish' }, { text: '❌ انصراف', callback_data: 'post:discard' }]
          ]
        }
      });
    }

    // plain text => draft + preview
    if (text && !text.startsWith('/')) {
      const draft = { text: escapeHtml(text), keyboard: [] };
      await db.set('draft', draft);
      return api.sendMessage(chatId, '👀 <b>پیش‌نمایش پست شما:</b>\n\n' + draft.text +
        '\n\nبرای انتشار: /publish — برای افزودن دکمه: /button', { parse_mode: 'HTML' });
    }
  }
};
