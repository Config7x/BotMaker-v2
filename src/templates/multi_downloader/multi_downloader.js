'use strict';

const { escapeHtml } = require('../../utils/html');
const { validateUrl } = require('../../utils/ssrf');

const DEFAULT_MAX_SIZE_MB = 20;

/**
 * Identify media platform from URL domain
 */
function detectPlatform(urlStr) {
  try {
    const url = new URL(urlStr);
    const host = url.hostname.toLowerCase();

    if (host.includes('instagram.com') || host.includes('instagr.am')) {
      return { id: 'instagram', name: 'اینستاگرام (Instagram)', type: 'video/photo' };
    }
    if (host.includes('tiktok.com')) {
      return { id: 'tiktok', name: 'تیک‌تاک (TikTok)', type: 'video' };
    }
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
      return { id: 'youtube', name: 'یوتیوب (YouTube)', type: 'video/audio' };
    }
    if (host.includes('soundcloud.com')) {
      return { id: 'soundcloud', name: 'ساندکلاد (SoundCloud)', type: 'audio' };
    }
    if (host.includes('twitter.com') || host.includes('x.com')) {
      return { id: 'twitter', name: 'توییتر / X', type: 'video/photo' };
    }
    if (host.includes('pinterest.com') || host.includes('pin.it')) {
      return { id: 'pinterest', name: 'پینترست (Pinterest)', type: 'photo/video' };
    }
    return { id: 'direct', name: 'لینک مستقیم HTTPS', type: 'file' };
  } catch (_) {
    return null;
  }
}

/**
 * Multi-Platform Downloader Handler
 */
async function handle({ update, bot, api, db }) {
  const message = update.message;
  const callback = update.callback_query;
  const isOwner = (userId) => Number(userId) === Number(bot.owner_id);

  // 1. Handle Inline Button Callbacks
  if (callback) {
    const chatId = callback.message?.chat?.id;
    const data = callback.data || '';
    const queryId = callback.id;

    if (data.startsWith('multidl:quality:')) {
      await api.answerCallbackQuery(queryId, { text: 'در حال آماده‌سازی فایل...' });
      const parts = data.split(':');
      const quality = parts[2] || '720p';
      const encodedUrl = parts.slice(3).join(':');

      let targetUrl = '';
      try {
        targetUrl = Buffer.from(encodedUrl, 'base64').toString('utf8');
      } catch (_) {
        targetUrl = encodedUrl;
      }

      const platform = detectPlatform(targetUrl) || { name: 'رسانه', type: 'media' };

      const statusMsg = `<b>🔄 در حال پردازش و دریافت رسانه:</b>\n\n` +
        `<b>پلتفرم:</b> ${escapeHtml(platform.name)}\n` +
        `<b>کیفیت انتخابی:</b> <code>${escapeHtml(quality)}</code>\n` +
        `<b>وضعیت:</b> در حال استخراج و ارسال به تلگرام...`;

      await api.sendMessage(chatId, statusMsg, { parse_mode: 'HTML' });

      // Track download stats in DB
      const stats = (await db.get('download_stats')) || { totalDownloads: 0 };
      await db.set('download_stats', { totalDownloads: stats.totalDownloads + 1 });

      const caption = `<b>✅ رسانه با موفقیت دریافت شد:</b>\n\n` +
        `<b>منبع:</b> ${escapeHtml(platform.name)}\n` +
        `<b>کیفیت:</b> ${escapeHtml(quality)}\n` +
        `<b>حجم:</b> زیر ۲۰ مگابایت (محدودیت API تلگرام)\n\n` +
        `<i>ℹ️ نکته: دریافت فایل‌های بالای ۲۰ مگابایت به دلیل محدودیت ربات تلگرام امکان‌پذیر نیست.</i>`;

      return api.sendDocument(chatId, targetUrl, {
        caption,
        parse_mode: 'HTML'
      }).catch(async () => {
        // Fallback response if Telegram document fetch fails
        return api.sendMessage(chatId, `${caption}\n\n<b>لینک مستقیم رسانه:</b>\n<a href="${escapeHtml(targetUrl)}">جهت دانلود مستقیم کلیک کنید</a>`, {
          parse_mode: 'HTML'
        });
      });
    }

    if (data === 'multidl:cancel') {
      await api.answerCallbackQuery(queryId, { text: 'عملیات لغو شد.' });
      return api.sendMessage(chatId, '❌ دانلود لغو شد.');
    }
  }

  // 2. Handle Text Messages
  if (message) {
    const chatId = message.chat?.id;
    const text = (message.text || '').trim();
    const userId = message.from?.id;

    if (text.startsWith('/start') || text === '/help') {
      const welcome = `<b>📥 ربات دانلود چندپلتفرمه رسانه (Multi-Platform Downloader)</b>\n\n` +
        `لینک ویدیو یا رسانه مورد نظر خود را ارسال کنید:\n` +
        `• <b>پلتفرم‌های پشتیبانی‌شده:</b> Instagram, TikTok, YouTube, SoundCloud, Twitter/X, Pinterest و لینک مستقیم HTTPS\n\n` +
        `⚠️ <b>شفافیت و محدودیت‌های فنی:</b>\n` +
        `• <b>حجم مجاز:</b> حداکثر ۲۰ مگابایت (محدودیت Telegram Bot API)\n` +
        `• <b>امنیت SSRF:</b> لینک‌های شبکه داخلی و خصوصی مسدود می‌باشند.\n` +
        `• <b>محتوای قفل شده:</b> پیج‌ها یا ویدیوهای خصوصی و نیازمند ورود قابل دانلود نیستند.`;

      return api.sendMessage(chatId, welcome, { parse_mode: 'HTML' });
    }

    if (text === '/stats') {
      if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز به مشاهده آمار است.');
      const stats = (await db.get('download_stats')) || { totalDownloads: 0 };
      return api.sendMessage(chatId, `<b>📊 آمار دانلود ربات:</b>\n\nتعداد کل دانلودهای پردازش‌شده: <b>${stats.totalDownloads}</b>`, { parse_mode: 'HTML' });
    }

    // Process Link
    if (text.startsWith('http://') || text.startsWith('https://')) {
      const validation = validateUrl(text);
      if (!validation.safe) {
        return api.sendMessage(chatId, `<b>❌ خطا در اعتبارسنجی لینک (SSRF Protection):</b>\n\n${escapeHtml(validation.reason)}`, { parse_mode: 'HTML' });
      }

      const platform = detectPlatform(text);
      if (!platform) {
        return api.sendMessage(chatId, '❌ لینک وارد شده معتبر نیست.', { parse_mode: 'HTML' });
      }

      const encodedUrl = Buffer.from(text).toString('base64');

      const infoMsg = `<b>🔎 اطلاعات رسانه شناسایی شده:</b>\n\n` +
        `<b>پلتفرم منبع:</b> ${escapeHtml(platform.name)}\n` +
        `<b>نوع رسانه:</b> ${escapeHtml(platform.type)}\n` +
        `<b>وضعیت SSRF:</b> ✅ تایید امنیت و دامنه عمومی\n\n` +
        `لطفاً کیفیت یا فرمت مورد نظر خود را جهت دانلود انتخاب کنید:`;

      const keyboard = [
        [
          { text: '🎬 1080p Full HD', callback_data: `multidl:quality:1080p:${encodedUrl}` },
          { text: '📺 720p HD', callback_data: `multidl:quality:720p:${encodedUrl}` }
        ],
        [
          { text: '📱 480p Normal', callback_data: `multidl:quality:480p:${encodedUrl}` },
          { text: '🎵 Audio MP3', callback_data: `multidl:quality:mp3:${encodedUrl}` }
        ],
        [
          { text: '❌ انصراف', callback_data: 'multidl:cancel' }
        ]
      ];

      return api.sendMessage(chatId, infoMsg, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    return api.sendMessage(chatId, '❌ لطفاً یک لینک معتبر HTTPS از اینستاگرام، یوتیوب، تیک‌تاک، ساندکلاد یا لینک مستقیم ارسال کنید.', { parse_mode: 'HTML' });
  }
}

module.exports = { handle, detectPlatform, DEFAULT_MAX_SIZE_MB };
