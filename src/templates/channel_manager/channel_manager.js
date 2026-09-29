'use strict';

const { escapeHtml } = require('../../utils/html');

const MENU_KEYBOARD = { keyboard: [['ℹ️ اطلاعات کانال', '🔐 بررسی دسترسی ادمین']], resize_keyboard: true, is_persistent: true };

async function handle({ update, bot, api, db }) {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat?.id;
  const text = (message.text || '').trim();
  const userId = message.from?.id;

  const channelKey = `channel_mgr_${userId}`;
  if (message.chat?.type && message.chat.type !== 'private') return;
  if (Number(userId) !== Number(bot.owner_id)) return api.sendMessage(chatId,'این دستور فقط برای مالک ربات است.');

  if (text.startsWith('/start') || text === '/help') {
    const welcome = `<b>📢 ربات مدیریت محدود کانال</b>\n\n` +
      `این ربات برای تسهیل انجام دستورات منتخب مدیریت کانال طراحی شده است.\n\n` +
      `⚠️ <b>حدود وظایف و عدم ادعای مدیریت کامل:</b>\n` +
      `این ربات دارا به قابلیت‌های متمرکز و محدود نظیر <i>ارسال پست، پین کردن پیام و سنجش دسترسی ادمین</i> می‌باشد. این ربات <b>هیچ ادعایی مبنی بر مدیریت کامل کانال، بن/آن‌بن اعضا، تغییر تنظیمات یا مدیریت حقوقی کانال ندارد</b>.\n\n` +
      `<b>دستورات کاربری:</b>\n` +
      `<code>/setchannel @channel_id</code> - تنظیم کانال تحت مدیریت\n` +
      `🔐 «بررسی دسترسی ادمین» - بررسی دسترسی‌های ادمین ربات در کانال\n` +
      `<code>/post متن پیام</code> - ارسال مستقیم پست به کانال\n` +
      `<code>/pin شماره_پیام</code> - پین کردن پیام در کانال\n` +
      `ℹ️ «اطلاعات کانال» - مشاهده وضعیت کانال فعال`;
    return api.sendMessage(chatId, welcome, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
  }

  let activeChannel = await db.get(channelKey);

  if (text.startsWith('/setchannel')) {
    const channel = text.slice(11).trim();
    if (!channel) {
      return api.sendMessage(chatId, '❌ فرمت نادرست. مثال: <code>/setchannel @mychannel</code>', { parse_mode: 'HTML' });
    }
    if (!/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(channel)) return api.sendMessage(chatId,'شناسه کانال نامعتبر است.');
    await db.set(channelKey, channel);
    return api.sendMessage(chatId, `✅ کانال تحت مدیریت روی <code>${escapeHtml(channel)}</code> تنظیم شد.\nجهت بررسی دسترسی‌ها دکمه «🔐 بررسی دسترسی ادمین» را بزنید.`, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
  }

  if (text === '/info' || text === 'ℹ️ اطلاعات کانال') {
    if (!activeChannel) {
      return api.sendMessage(chatId, '⚠️ هنوز کانالی تنظیم نشده است. از دستور <code>/setchannel @channel_id</code> استفاده کنید.', { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
    }
    return api.sendMessage(chatId, `<b>ℹ️ اطلاعات مدیریت کانال:</b>\n\n<b>کانال فعال:</b> <code>${escapeHtml(activeChannel)}</code>\n<b>امکانات فعال:</b> ارسال پست، پین پیام\n<b>محدودیت:</b> فاقد دسترسی‌های مدیریتی اعضا و بن کاربر.`, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
  }

  if (text === '/checkadmin' || text === '🔐 بررسی دسترسی ادمین') {
    if (!activeChannel) {
      return api.sendMessage(chatId, '⚠️ ابتدا با <code>/setchannel @channel_id</code> کانال را مشخص کنید.', { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
    }

    try {
      const me=await api.getMe();
      if (!me?.ok || !me.result?.id) throw new Error('Could not verify bot ID');
      const member = await api.getChatMember(activeChannel, me.result.id);
      const status = member?.result?.status || member?.status;
      const canPost = member?.result?.can_post_messages !== false && member?.can_post_messages !== false;
      const canPin = member?.result?.can_pin_messages !== false && member?.can_pin_messages !== false;

      if (status === 'administrator' || status === 'creator') {
        const msg = `<b>✅ دسترسی ادمین تایید شد!</b>\n\n` +
          `<b>کانال:</b> <code>${escapeHtml(activeChannel)}</code>\n` +
          `<b>مقام:</b> ${status === 'creator' ? 'سازنده' : 'ادمین'}\n` +
          `<b>حق ارسال پست:</b> ${canPost ? '✅ دارد' : '❌ ندارد'}\n` +
          `<b>حق پین پیام:</b> ${canPin ? '✅ دارد' : '❌ ندارد'}`;
        return api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
      } else {
        return api.sendMessage(chatId, `❌ ربات ادمین نیست!\nمقام فعلی ربات در <code>${escapeHtml(activeChannel)}</code> برابر <code>${escapeHtml(status)}</code> می‌باشد.`, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
      }
    } catch (err) {
      return api.sendMessage(chatId, `❌ خطا در استعلام دسترسی از تلگرام: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  }

  if (text.startsWith('/post')) {
    if (!activeChannel) {
      return api.sendMessage(chatId, '⚠️ ابتدا با <code>/setchannel @channel_id</code> کانال را مشخص کنید.', { parse_mode: 'HTML' });
    }

    const postContent = text.slice(5).trim();
    if (!postContent) {
      return api.sendMessage(chatId, '❌ متن پست خالی است.\nمثال: <code>/post متن اطلاع‌رسانی</code>', { parse_mode: 'HTML' });
    }

    // Verify Admin Status
    try {
      const me=await api.getMe();
      if (!me?.ok || !me.result?.id) throw new Error('Could not verify bot ID');
      const member = await api.getChatMember(activeChannel, me.result.id);
      const status = member?.result?.status || member?.status;
      if (status !== 'administrator' && status !== 'creator') {
        return api.sendMessage(chatId, `❌ ربات در کانال <code>${escapeHtml(activeChannel)}</code> دسترسی ادمین ندارد.`, { parse_mode: 'HTML' });
      }
    } catch (e) {
      return api.sendMessage(chatId, `❌ عدم امکان تایید دسترسی ادمین در کانال.`, { parse_mode: 'HTML' });
    }

    const sendRes = await api.sendMessage(activeChannel, escapeHtml(postContent), { parse_mode: 'HTML' });
    if (sendRes && sendRes.ok !== false) {
      return api.sendMessage(chatId, `✅ پیام با موفقیت به کانال <code>${escapeHtml(activeChannel)}</code> ارسال شد.`, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
    } else {
      return api.sendMessage(chatId, '❌ خطا در ارسال پیام به کانال.', { parse_mode: 'HTML' });
    }
  }

  if (text.startsWith('/pin')) {
    if (!activeChannel) {
      return api.sendMessage(chatId, '⚠️ ابتدا با <code>/setchannel @channel_id</code> کانال را مشخص کنید.', { parse_mode: 'HTML' });
    }

    const msgId = Number(text.slice(4).trim());
    if (!Number.isSafeInteger(msgId) || msgId < 1) {
      return api.sendMessage(chatId, '❌ لطفاً شناسه (Message ID) پیام را به صورت عدد وارد کنید.\nمثال: <code>/pin 42</code>', { parse_mode: 'HTML' });
    }

    try {
      const pinResult=await api.pinChatMessage(activeChannel,msgId);
      if (!pinResult?.ok) throw new Error('Telegram rejected pin');
      return api.sendMessage(chatId, `📌 پیام شماره <code>${msgId}</code> در کانال <code>${escapeHtml(activeChannel)}</code> پین شد.`, { parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
    } catch (err) {
      return api.sendMessage(chatId, `❌ خطا در پین کردن پیام: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
    }
  }
}

module.exports = { handle };
