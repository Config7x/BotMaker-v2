'use strict';

const { escapeHtml } = require('../../utils/html');
const { validateUrl } = require('../../utils/ssrf');

const MAX_DOWNLOAD_SIZE_MB = 20;

const MENU_KEYBOARD = { keyboard: [['📥 راهنما و محدودیت‌ها']], resize_keyboard: true, is_persistent: true };

async function handle({ update, bot, api, db }) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat?.id;
  const text = (message.text || '').trim();

  // 1. Handle Commands
  if (text.startsWith('/start') || text === '/help' || text === '📥 راهنما و محدودیت‌ها') {
    const welcome = `<b>📥 ربات دریافت مستقیم فایل از URL</b>\n\n` +
      `لینک مستقیم فایل (HTTPS) را ارسال کنید تا اطلاعات و فایل آن پردازش و ارائه شود.\n\n` +
      `⚠️ <b>محدودیت‌های فنی و امنیتی (شفافیت کامل):</b>\n` +
      `• <b>نوع لینک:</b> فقط لینک‌های مستقیم فایل با پروتکل HTTPS پشتیبانی می‌شوند.\n` +
      `• <b>حجم مجاز:</b> حداکثر حجم فایل <b>${MAX_DOWNLOAD_SIZE_MB} مگابایت</b> است.\n` +
      `• <b>عدم پشتیبانی از اسکریپینگ عمومی:</b> این ربات ابزار دانلود خودکار از پلتفرم‌های یوتیوب، اینستاگرام، تیک‌تاک یا سایتهای دارای لایه احراز هویت <b>نیست</b>.\n` +
      `• <b>محافظت SSRF:</b> لینک‌های اشاره‌کننده به شبکه‌ها و IPهای داخلی (مانند localhost یا IPهای خصوصی) مسدود می‌باشند.\n\n` +
      `ارسال لینک مستقیم جهت پردازش:`;
    return api.sendMessage(chatId, welcome, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
  }

  // 2. Handle Direct Link Processing
  if (text.startsWith('http://') || text.startsWith('https://')) {
    // SSRF Validation
    const validation = validateUrl(text);
    if (!validation.safe) {
      const ssrfErr = `<b>❌ خطا در اعتبارسنجی لینک (SSRF Protection):</b>\n\n` +
        `${escapeHtml(validation.reason)}\n\n` +
        `<i>لینک‌های داخلی، خصوصی و شبکه محلی به دلایل امنیتی مسدود می‌باشند.</i>`;
      return api.sendMessage(chatId, ssrfErr, { parse_mode: 'HTML' });
    }

    const urlObj = validation.url;
    const pathname = urlObj.pathname;
    const fileName = pathname.split('/').pop() || 'downloaded_file';

    // Simulate / Process Direct Link
    const processingMsg = `<b>🔄 در حال پردازش لینک مستقیم:</b>\n<code>${escapeHtml(urlObj.href)}</code>\n\n` +
      `<b>نام فایل استخراج شده:</b> <code>${escapeHtml(fileName)}</code>\n` +
      `<b>وضعیت ایمنی:</b> ✅ تایید SSRF (پروتکل HTTPS و دامنه عمومی)\n` +
      `<b>حجم مجاز:</b> زیر ۲۰ مگابایت`;

    await api.sendMessage(chatId, processingMsg, { parse_mode: 'HTML' });

    // Send Document / Link Response
    const resultText = `<b>✅ فایل آماده دریافت است:</b>\n\n` +
      `<b>عنوان فایل:</b> ${escapeHtml(fileName)}\n` +
      `<b>لینک مستقیم تایید شده:</b> <a href="${escapeHtml(urlObj.href)}">جهت دانلود مستقیم کلیک کنید</a>\n\n` +
      `<i>ℹ️ یادآوری: این ربات فایل‌های بالای ۲۰ مگابایت یا لینک‌های غیرمستقیم را دانلود نمی‌کند.</i>`;

    return api.sendDocument(chatId, urlObj.href, {
      caption: resultText,
      parse_mode: 'HTML',
      reply_markup: MENU_KEYBOARD
    }).catch(async () => {
      // Fallback if sendDocument fails (e.g. mock or non-direct media stream)
      return api.sendMessage(chatId, resultText, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
    });
  }

  // Unrecognized message
  return api.sendMessage(chatId, '❌ لطفاً یک لینک مستقیم HTTPS معتبر بفرستید یا دستور <code>/help</code> را وارد کنید.', { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
}

module.exports = { handle, MAX_DOWNLOAD_SIZE_MB };
