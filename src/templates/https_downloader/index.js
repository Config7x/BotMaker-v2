'use strict';

const { escapeHtml } = require('../../utils/html');
const { validateUrl } = require('../../utils/ssrf');

const MAX_MB = 20; // Telegram Bot API download limit for bots

module.exports = {
  id: 'https_downloader',
  category: 'downloader',
  name: 'دانلودر مستقیم HTTPS (Direct HTTPS Downloader)',
  description: `دانلود فایل‌های کوچک از لینک مستقیم HTTPS و ارسال به‌صورت فایل تلگرام (حداکثر ${MAX_MB} مگابایت).`,
  features: ['دانلود لینک مستقیم', 'محافظت SSRF', 'محدودیت حجم ۲۰ مگابایت'],
  async handle({ update, bot, api, db }) {
    const msg = update.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (text.startsWith('/start') || text === '/help') {
      return api.sendMessage(chatId,
        `📥 <b>دانلودر مستقیم HTTPS</b>\n\nلینک مستقیم فایل را بفرستید تا به‌صورت فایل تلگرام برایتان ارسال شود.\n\n⚠️ محدودیت: حداکثر <b>۲۰ مگابایت</b> (محدودیت Bot API). لینک‌های شبکه داخلی مسدود هستند.`,
        { parse_mode: 'HTML' });
    }

    if (/^https?:\/\//i.test(text)) {
      const v = validateUrl(text);
      if (!v.safe) return api.sendMessage(chatId, `❌ ${escapeHtml(v.reason)}`, { parse_mode: 'HTML' });
      const status = await api.sendMessage(chatId, '⏳ در حال دریافت فایل...');
      try {
        const r = await api.sendDocument(chatId, text, { caption: '✅ فایل شما' });
        return api.editMessageText(chatId, status.result?.message_id, '✅ فایل ارسال شد.').catch(() => {});
      } catch (e) {
        const reason = /20MB/i.test(e.message || '')
          ? `حجم فایل بیش از ${MAX_MB} مگابایت است و ربات تلگرام امکان دانلودش را ندارد.`
          : 'دریافت فایل ناموفق بود (لینک معتبر است؟ فایل عمومی است؟)';
        return api.sendMessage(chatId, `❌ ${reason}\n\nلینک مستقیم: ${escapeHtml(text)}`, { parse_mode: 'HTML' });
      }
    }

    return api.sendMessage(chatId, 'لطفاً یک لینک مستقیم HTTPS ارسال کنید.');
  }
};
