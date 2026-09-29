'use strict';

const { escapeHtml } = require('../../utils/html');

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB Telegram Bot API limit

const MENU_KEYBOARD = { keyboard: [['📁 فایل‌های من']], resize_keyboard: true, is_persistent: true };

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function handle({ update, bot, api, db }) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat?.id;
  const text = (message.text || '').trim();
  const userId = message.from?.id;

  // 1. Handle Commands
  if (text.startsWith('/start')) {
    const welcome = `<b>📥 ربات آپلود و ذخیره فایل</b>\n\n` +
      `فایل، عکس یا ویدیو خود را ارسال کنید تا شناسه و کد دسترسی اختصاصی آن را دریافت کنید.\n\n` +
      `⚠️ <b>محدودیت‌ها و شفافیت:</b>\n` +
      `• حداکثر حجم مجاز فایل: <b>۲۰ مگابایت</b> (مطابق قوانین تلگرام ربات‌ها).\n` +
      `• فایل‌ها روی سرور تلگرام میزبانی می‌شوند و این ربات <b>هیچ ادعایی مبنی بر فضای ذخیره‌سازی نامحدود اختصاصی ندارد</b>.\n\n` +
      `دستورات:\n` +
      `📁 «فایل‌های من» - لیست فایل‌های ذخیره‌شده شما\n` +
      `/get &lt;کد_فایل&gt; - دریافت فایل بر اساس کد`;
    return api.sendMessage(chatId, welcome, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
  }

  if (text === '/myfiles' || text === '📁 فایل‌های من') {
    const files = await db.find('uploads', { userId });
    if (!files || files.length === 0) {
      return api.sendMessage(chatId, '📭 شما هنوز هیچ فایلی آپلود نکرده‌اید.', { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
    }

    const fileList = files.slice(-10).map(f =>
      `• <code>${f.code}</code> | ${escapeHtml(f.fileName)} (${formatBytes(f.fileSize)})`
    ).join('\n');

    return api.sendMessage(chatId, `<b>📁 ۱۰ فایل اخیر شما:</b>\n\n${fileList}\n\n<i>جهت دریافت، دستور <code>/get کد</code> را ارسال کنید.</i>`, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
  }

  if (text.startsWith('/get')) {
    const code = text.slice(4).trim();
    if (!code) {
      return api.sendMessage(chatId, '❌ لطفاً کد فایل را وارد کنید.\nمثال: <code>/get 12345</code>', { parse_mode: 'HTML' });
    }

    const files = await db.find('uploads', { code });
    const fileRecord = files && files[0];

    if (!fileRecord) {
      return api.sendMessage(chatId, '❌ فایلی با این کد یافت نشد یا پاک شده است.', { parse_mode: 'HTML' });
    }

    const caption = `<b>📄 فایل دریافت شد:</b> ${escapeHtml(fileRecord.fileName)}\n<b>حجم:</b> ${formatBytes(fileRecord.fileSize)}`;

    if (fileRecord.type === 'photo') {
      return api.sendPhoto(chatId, fileRecord.fileId, { caption, parse_mode: 'HTML' });
    } else {
      return api.sendDocument(chatId, fileRecord.fileId, { caption, parse_mode: 'HTML' });
    }
  }

  // 2. Handle File / Media Submissions
  const doc = message.document;
  const photo = message.photo ? message.photo[message.photo.length - 1] : null;
  const video = message.video;
  const audio = message.audio || message.voice;

  const mediaObj = doc || photo || video || audio;

  if (mediaObj) {
    const fileSize = mediaObj.file_size || 0;
    const fileId = mediaObj.file_id;

    // Check size limit
    if (fileSize > MAX_FILE_SIZE) {
      const errText = `<b>❌ خطا در پردازش فایل!</b>\n\n` +
        `حجم فایل شما <b>${formatBytes(fileSize)}</b> است که از سقف مجاز <b>۲۰ مگابایت</b> بیشتر می‌باشد.\n` +
        `<i>ربات قادر به ذخیره‌سازی فایل‌های سنگین‌تر از ۲۰ مگابایت نیست.</i>`;
      return api.sendMessage(chatId, errText, { parse_mode: 'HTML' });
    }

    let fileName = 'محتوای رسانه‌ای';
    let type = 'document';

    if (doc) {
      fileName = doc.file_name || 'سند بدون نام';
      type = 'document';
    } else if (photo) {
      fileName = 'تصویر_' + Date.now() + '.jpg';
      type = 'photo';
    } else if (video) {
      fileName = video.file_name || 'ویدیو_' + Date.now() + '.mp4';
      type = 'video';
    } else if (audio) {
      fileName = audio.file_name || 'فایل_صوتی_' + Date.now() + '.mp3';
      type = 'audio';
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    const uploadRecord = {
      code,
      userId,
      fileId,
      fileUniqueId: mediaObj.file_unique_id || '',
      fileName,
      fileSize,
      type,
      uploadedAt: new Date().toISOString()
    };

    await db.save('uploads', uploadRecord);

    // Forward to forward_chat_id or owner if configured
    const targetChat = bot.config?.forward_chat_id || bot.owner_id;
    if (targetChat) {
      await api.forwardMessage(targetChat, chatId, message.message_id).catch(() => {});
    }

    const responseText = `<b>✅ فایل شما با موفقیت ذخیره شد!</b>\n\n` +
      `<b>نام فایل:</b> ${escapeHtml(fileName)}\n` +
      `<b>حجم:</b> ${formatBytes(fileSize)}\n` +
      `<b>کد دسترسی:</b> <code>${code}</code>\n\n` +
      `<i>جهت دریافت این فایل در آینده، دستور زیر را ارسال کنید:</i>\n` +
      `<code>/get ${code}</code>\n\n` +
      `⚠️ <i>توجه: فایل‌های تلگرام تحت سیاست‌های نگهداری تلگرام ذخیره می‌شوند (بدون ادعای ذخیره نامحدود).</i>`;

    return api.sendMessage(chatId, responseText, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
  }
}

module.exports = { handle, MAX_FILE_SIZE, formatBytes };
