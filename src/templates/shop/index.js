'use strict';

const { escapeHtml } = require('../../utils/html');

module.exports = {
  id: 'shop',
  category: 'commerce',
  name: 'فروشگاه / کاتالوگ (Shop)',
  description: 'مرور محصولات و ثبت سفارش (بدون درگاه پرداخت داخلی).',
  features: ['افزودن/حذف محصول توسط مالک', 'مرور و جستجو', 'ثبت درخواست سفارش برای مالک'],
  async handle({ update, bot, api, db }) {
    const msg = update.message;
    const cb = update.callback_query;
    const isOwner = (id) => Number(id) === Number(bot.owner_id);

    if (cb) {
      const chatId = cb.message?.chat?.id;
      const data = cb.data || '';
      if (data.startsWith('shop:view:')) {
        const items = await db.find('products', {});
        const p = items.find((x) => String(x.id) === data.split(':')[2]);
        if (!p) return api.answerCallbackQuery(cb.id, { text: 'محصول یافت نشد', show_alert: true });
        await api.answerCallbackQuery(cb.id);
        return api.sendMessage(chatId,
          `🛍 <b>${escapeHtml(p.title)}</b>\n📝 ${escapeHtml(p.description || '')}\n💰 قیمت: <b>${p.price}</b> تومان`,
          {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🧾 ثبت سفارش', callback_data: `shop:order:${p.id}` }]] }
          });
      }
      if (data.startsWith('shop:order:')) {
        const items = await db.find('products', {});
        const p = items.find((x) => String(x.id) === data.split(':')[2]);
        if (!p) return api.answerCallbackQuery(cb.id, { text: 'محصول یافت نشد', show_alert: true });
        await db.save('orders', { product_id: p.id, title: p.title, user_id: cb.from.id, user_name: cb.from.first_name || '', at: Date.now() });
        await api.answerCallbackQuery(cb.id, { text: '✅ سفارش شما ثبت شد' });
        await api.sendMessage(chatId, `✅ سفارش <b>${escapeHtml(p.title)}</b> ثبت شد. مالک فروشگاه با شما هماهنگ می‌کند.`, { parse_mode: 'HTML' });
        return api.sendMessage(bot.owner_id,
          `🧾 <b>سفارش جدید</b>\nمحصول: ${escapeHtml(p.title)}\nکاربر: <a href="tg://user?id=${cb.from.id}">${escapeHtml(cb.from.first_name || String(cb.from.id))}</a>`,
          { parse_mode: 'HTML' }).catch(() => {});
      }
      return;
    }

    if (msg) {
      const chatId = msg.chat.id;
      const text = (msg.text || '').trim();
      if (text.startsWith('/start') || text === '/help') {
        const kb = { reply_markup: { keyboard: [[{ text: '🛍 لیست محصولات' }, { text: '❓ راهنما' }]], resize_keyboard: true } };
        return api.sendMessage(chatId, '🛍 به فروشگاه خوش آمدید!\nبرای دیدن محصولات دکمه زیر یا /products را بزنید.', kb);
      }
      if (text === '🛍 لیست محصولات' || text === '/products') {
        const items = await db.find('products', {});
        if (!items.length) return api.sendMessage(chatId, 'فعلاً محصولی ثبت نشده است.');
        return api.sendMessage(chatId, '<b>🛍 محصولات:</b>', {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: items.slice(0, 20).map((p) => ([{ text: `${p.title} — ${p.price} ت`, callback_data: `shop:view:${p.id}` }])) }
        });
      }
      if (text.startsWith('/addproduct') && isOwner(msg.from.id)) {
        // /addproduct عنوان | قیمت | توضیحات
        const parts = text.replace('/addproduct', '').split('|').map((s) => s.trim());
        if (parts.length < 2) return api.sendMessage(chatId, 'فرمت: <code>/addproduct عنوان | قیمت | توضیح</code>', { parse_mode: 'HTML' });
        const saved = await db.save('products', { title: parts[0], price: Number(parts[1]) || 0, description: parts[2] || '' });
        return api.sendMessage(chatId, `✅ محصول «${escapeHtml(saved.title)}» اضافه شد.`);
      }
      if (text === '/myorders' && isOwner(msg.from.id)) {
        const orders = await db.find('orders', {});
        if (!orders.length) return api.sendMessage(chatId, 'سفارشی ثبت نشده است.');
        return api.sendMessage(chatId, '<b>سفارش‌ها:</b>\n' + orders.map((o) => `• ${escapeHtml(o.title)} — ${escapeHtml(o.user_name)}`).join('\n'), { parse_mode: 'HTML' });
      }
      return api.sendMessage(chatId, 'برای دیدن محصولات /products را بزنید.');
    }
  }
};
