'use strict';

const { escapeHtml } = require('../../utils/html');

const SUPPORTED_EMOJIS = ['🔴', '🟢', '🔵', '🟡', '⚪', '🟣', '🟠'];

async function handle({ update, bot, api, db }) {
  const message = update.message;
  const callback = update.callback_query;

  // Handle Callbacks (e.g. Publish click)
  if (callback) {
    if (Number(callback.from?.id) !== Number(bot.owner_id) || (callback.message?.chat?.type && callback.message.chat.type !== 'private')) return api.answerCallbackQuery(callback.id,{text:'فقط مالک ربات مجاز است'});
    const chatId = callback.message?.chat?.id;
    const data = callback.data || '';
    const userId = callback.from?.id;

    if (data === 'composer:publish') {
      await api.answerCallbackQuery(callback.id);
      const stateKey = `composer_${userId}`;
    if (Number(userId) !== Number(bot.owner_id)) return api.sendMessage(chatId,'این دستور فقط برای مالک ربات است.');
      const state = await db.get(stateKey);

      if (!state || !state.text || !state.channelId) {
        return api.sendMessage(chatId, '❌ پیش‌نویس ناقص است. متن پست و کانال مقصد را مشخص کنید.', { parse_mode: 'HTML' });
      }

      // Check Admin Rights in Channel
      try {
        const me=await api.getMe();
        if (!me?.ok || !me.result?.id) throw new Error('Could not verify bot ID');
        const member = await api.getChatMember(state.channelId,me.result.id);
        const status = member?.result?.status || member?.status;
        const canPost = member?.result?.can_post_messages !== false && member?.can_post_messages !== false;

        if (status !== 'administrator' && status !== 'creator') {
          return api.sendMessage(chatId, `❌ دسترسی ادمین یافت نشد!\nربات در کانال <code>${escapeHtml(state.channelId)}</code> ادمین نیست. ابتدا ربات را ادمین کانال کنید.`, { parse_mode: 'HTML' });
        }
        if (!canPost) {
          return api.sendMessage(chatId, `❌ دسترسی انتشار پیام وجود ندارد!\nربات در کانال <code>${escapeHtml(state.channelId)}</code> حق انتشار پیام (can_post_messages) ندارد.`, { parse_mode: 'HTML' });
        }
      } catch (err) {
        return api.sendMessage(chatId, `❌ خطا در بررسی دسترسی‌های ربات در کانال <code>${escapeHtml(state.channelId)}</code>: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
      }

      // Build inline buttons
      const inlineKeyboard = [];
      if (state.buttons && state.buttons.length > 0) {
        for (const btn of state.buttons) {
          inlineKeyboard.push([{ text: `${btn.emoji} ${btn.text}`, url: btn.url }]);
        }
      }

      // Publish to target channel explicitly
      const publishRes = await api.sendMessage(state.channelId, escapeHtml(state.text), {
        parse_mode: 'HTML',
        reply_markup: inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined
      });

      if (publishRes && publishRes.ok !== false) {
        return api.sendMessage(chatId, `🚀 <b>پست با موفقیت در کانال ${escapeHtml(state.channelId)} منتشر شد!</b>`, { parse_mode: 'HTML' });
      } else {
        return api.sendMessage(chatId, '❌ خطا در ارسال پست به کانال.', { parse_mode: 'HTML' });
      }
    }

    if (data === 'composer:clear') {
      await api.answerCallbackQuery(callback.id, { text: 'پیش‌نویس پاک شد.' });
      await db.delete(`composer_${userId}`);
      return api.sendMessage(chatId, '🗑 پیش‌نویس پست شما با موفقیت پاک شد.', { parse_mode: 'HTML' });
    }
  }

  // Handle Messages
  if (message) {
    if (message.chat?.type && message.chat.type !== 'private') return;
    const chatId = message.chat?.id;
    const text = (message.text || '').trim();
    const userId = message.from?.id;
    const stateKey = `composer_${userId}`;
    if (Number(userId) !== Number(bot.owner_id)) return api.sendMessage(chatId,'این دستور فقط برای مالک ربات است.');

    if (text.startsWith('/start') || text === '/compose') {
      const welcome = `<b>📝 ربات پست‌ساز صریح با دکمه‌های شیشه‌ای</b>\n\n` +
        `طراحی و ارسال پست‌های سفارشی به کانال تلگرام.\n\n` +
        `🎨 <b>محدودیت و شفافیت رنگ دکمه‌ها:</b>\n` +
        `در API تلگرام، دکمه‌های شیشه‌ای (Inline Keyboard) قابلیت تغییر رنگ مستقیم CSS ندارند. تفکیک رنگ دکمه‌ها در این ربات <b>منحصراً از طریق ایموجی‌های رنگی</b> (🔴 🟢 🔵 🟡 ⚪ 🟣 🟠) صورت می‌پذیرد.\n\n` +
        `🔐 <b>پیش‌نیاز:</b> ربات باید در کانال مقصد دسترسی <b>ادمین (Administrator)</b> با مجوز ارسال پیام داشته باشد.\n\n` +
        `<b>دستورات ساخت پست:</b>\n` +
        `<code>/settext متن پست</code> - تنظیم متن پست\n` +
        `<code>/addbutton 🟢 عنوان | https://link.com</code> - افزودن دکمه شیشه‌ای (با ایموجی رنگی)\n` +
        `<code>/setchannel @channel_id</code> - تنظیم کانال مقصد\n` +
        `<code>/preview</code> - پیش‌نمایش و انتشار صریح پست\n` +
        `<code>/clear</code> - پاکسازی پیش‌نویس`;
      return api.sendMessage(chatId, welcome, { parse_mode: 'HTML' });
    }

    let state = (await db.get(stateKey)) || { text: '', buttons: [], channelId: '' };

    if (text.startsWith('/settext')) {
      const body = text.slice(8).trim();
      if (!body) {
        return api.sendMessage(chatId, '❌ لطفاً متن پست را وارد کنید.\nمثال: <code>/settext سلام به کانال ما خوش آمدید</code>', { parse_mode: 'HTML' });
      }
      state.text = body;
      await db.set(stateKey, state);
      return api.sendMessage(chatId, `✅ متن پست تنظیم شد:\n\n${escapeHtml(state.text)}`, { parse_mode: 'HTML' });
    }

    if (text.startsWith('/addbutton')) {
      const body = text.slice(10).trim();
      // Format: /addbutton 🔴 متن دکمه | https://example.com
      const parts = body.split('|').map(s => s.trim());
      if (parts.length < 2) {
        return api.sendMessage(chatId, '❌ فرمت نادرست.\nفرمت صحیح:\n<code>/addbutton 🟢 عنوان دکمه | https://link.com</code>', { parse_mode: 'HTML' });
      }

      let rawLabel = parts[0];
      const url = parts[1];

      // Extract emoji if present at start
      let emoji = '🔵';
      for (const e of SUPPORTED_EMOJIS) {
        if (rawLabel.startsWith(e)) {
          emoji = e;
          rawLabel = rawLabel.slice(e.length).trim();
          break;
        }
      }

      if (!rawLabel || rawLabel.length > 60 || state.buttons.length >= 8 || !/^https:\/\/[^\s/@]+(?:\:[0-9]+)?(?:\/[^\s]*)?$/i.test(url)) return api.sendMessage(chatId,'عنوان یا لینک HTTPS دکمه نامعتبر است.');
      state.buttons.push({ emoji, text: rawLabel, url });
      await db.set(stateKey, state);

      return api.sendMessage(chatId, `✅ دکمه اضافه شد: [ ${emoji} ${escapeHtml(rawLabel)} ] -> ${escapeHtml(url)}`, { parse_mode: 'HTML' });
    }

    if (text.startsWith('/setchannel')) {
      const channel = text.slice(11).trim();
      if (!channel) {
        return api.sendMessage(chatId, '❌ لطفاً شناسه یا آیدی کانال را وارد کنید.\nمثال: <code>/setchannel @mychannel</code>', { parse_mode: 'HTML' });
      }
      if (!/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(channel)) return api.sendMessage(chatId,'شناسه کانال نامعتبر است.');
      state.channelId = channel;
      await db.set(stateKey, state);
      return api.sendMessage(chatId, `✅ کانال مقصد روی <code>${escapeHtml(channel)}</code> تنظیم شد.`, { parse_mode: 'HTML' });
    }

    if (text === '/preview') {
      if (!state.text) {
        return api.sendMessage(chatId, '⚠️ متن پست هنوز تنظیم نشده است. از <code>/settext</code> استفاده کنید.', { parse_mode: 'HTML' });
      }

      const channelStr = state.channelId ? `<code>${escapeHtml(state.channelId)}</code>` : '<i>تعیین نشده</i>';

      const keyboard = [];
      if (state.buttons && state.buttons.length > 0) {
        for (const btn of state.buttons) {
          keyboard.push([{ text: `${btn.emoji} ${btn.text}`, url: btn.url }]);
        }
      }

      keyboard.push([
        { text: '🚀 انتشار صریح در کانال', callback_data: 'composer:publish' },
        { text: '🗑 پاکسازی', callback_data: 'composer:clear' }
      ]);

      const previewText = `<b>👁‍🗨 پیش‌نمایش پست شما:</b>\n` +
        `📌 <b>کانال مقصد:</b> ${channelStr}\n` +
        `----------------------------------------\n` +
        `${escapeHtml(state.text)}\n` +
        `----------------------------------------\n` +
        `<i>🎨 رنگ دکمه‌ها صرفاً با ایموجی‌های (🔴 🟢 🔵) مشخص شده‌اند.</i>\n` +
        `<i>جهت ارسال نهایی، دکمه «انتشار صریح در کانال» را کلیک کنید.</i>`;

      return api.sendMessage(chatId, previewText, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    if (text === '/clear') {
      await db.delete(stateKey);
      return api.sendMessage(chatId, '🗑 پیش‌نویس پاک شد.', { parse_mode: 'HTML' });
    }
  }
}

module.exports = { handle, SUPPORTED_EMOJIS };
