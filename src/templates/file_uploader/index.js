'use strict';

const { escapeHtml } = require('../../utils/html');

// Telegram Bot API: 20MB download limit for bots, 50MB max file reference.
const DOWNLOAD_LIMIT_MB = 20;
const REF_LIMIT_MB = 50;

module.exports = {
  id: 'file_uploader',
  category: 'storage',
  name: 'آپلودر فایل (File Uploader)',
  description: 'ذخیره و دریافت فایل در تلگرام، در محدوده حجمی خود تلگرام (دانلود ۲۰ مگابایت / ارجاع ۵۰ مگابایت).',
  features: ['ذخیره فایل با نام', 'جستجو و دریافت مجدد', 'شفافیت کامل درباره محدودیت‌های حجم'],
  async handle({ update, bot, api, db }) {
    const msg = update.message;
    const cb = update.callback_query;
    const isOwner = (id) => Number(id) === Number(bot.owner_id);

    if (cb) {
      const chatId = cb.message?.chat?.id;
      if (cb.data.startsWith('file:get:')) {
        const id = cb.data.split(':')[2];
        const files = await db.find('files', {});
        const f = files.find((x) => String(x.id) === id);
        if (!f) return api.answerCallbackQuery(cb.id, { text: 'فایل یافت نشد', show_alert: true });
        await api.answerCallbackQuery(cb.id, { text: 'در حال ارسال...' });
        return api.call('sendDocument', { chat_id: chatId, document: f.file_id })
          .catch(() => api.sendMessage(chatId, '❌ ارسال فایل ناموفق بود (احتمالاً حجم بیش از حد مجاز).'));
      }
      return;
    }

    if (!msg) return;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (text.startsWith('/start') || text === '/help') {
      return api.sendMessage(chatId,
        `📁 <b>ربات ذخیره فایل</b>\n\nفایل را با کپشن (به‌عنوان نام) ارسال کنید تا ذخیره شود.\nبا /list آخرین فایل‌ها را ببینید و با ارسال نام، فایل را بازیابی کنید.\n\n⚠️ محدودیت‌های تلگرام: دانلود فایل تا <b>۲۰ مگابایت</b> و ارجاع تا <b>۵۰ مگابایت</b>. این ربات یک فضای ابری نامحدود نیست.`,
        { parse_mode: 'HTML' });
    }

    if (text === '/list') {
      const files = await db.find('files', {});
      if (!files.length) return api.sendMessage(chatId, 'هنوز فایلی ذخیره نشده است.');
      return api.sendMessage(chatId, '<b>📁 فایل‌های ذخیره‌شده:</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: files.slice(-20).reverse().map((f) => ([{ text: `📄 ${f.name} (${(f.size / 1024 / 1024).toFixed(1)}MB)`, callback_data: `file:get:${f.id}` }])) }
      });
    }

    if (text && !text.startsWith('/')) {
      const files = await db.find('files', {});
      const matched = files.filter((f) => String(f.name).toLowerCase().includes(text.toLowerCase())).slice(-10);
      if (!matched.length) return api.sendMessage(chatId, `فایلی با نام «${escapeHtml(text)}» یافت نشد. با /list همه فایل‌ها را ببینید.`, { parse_mode: 'HTML' });
      return api.sendMessage(chatId, `<b>نتایج برای «${escapeHtml(text)}»:</b>`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: matched.map((f) => ([{ text: `📄 ${f.name}`, callback_data: `file:get:${f.id}` }])) }
      });
    }

    if (msg.document) {
      const doc = msg.document;
      if (doc.file_size > REF_LIMIT_MB * 1024 * 1024) {
        return api.sendMessage(chatId, `❌ حجم فایل بیش از ${REF_LIMIT_MB} مگابایت است و قابل ذخیره نیست.`);
      }
      if (!isOwner(msg.from.id)) {
        return api.sendMessage(chatId, '⛔️ فقط مالک ربات می‌تواند فایل ذخیره کند.');
      }
      const name = (msg.caption || doc.file_name || 'file').slice(0, 100);
      await db.save('files', { name, file_id: doc.file_id, size: doc.file_size });
      return api.sendMessage(chatId, `✅ فایل «${escapeHtml(name)}» ذخیره شد. برای دریافت، نامش را بفرستید یا /list را بزنید.`, { parse_mode: 'HTML' });
    }
  }
};
