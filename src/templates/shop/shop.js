'use strict';

const { escapeHtml } = require('../../utils/html');

const DEFAULT_PRODUCTS = [
  {
    id: 'p1',
    title: 'محصول نمونه ۱',
    price: 150000,
    description: 'این یک محصول نمونه جهت تست کاتالوگ فروشگاه است.'
  },
  {
    id: 'p2',
    title: 'محصول نمونه ۲',
    price: 280000,
    description: 'محصول نمونه دوم با توضیحات کامل.'
  }
];

/**
 * Helper to retrieve products from DB or default list.
 */
async function getProducts(db) {
  let products = await db.find('products', {});
  if (!products || products.length === 0) {
    for (const p of DEFAULT_PRODUCTS) {
      await db.save('products', p);
    }
    products = DEFAULT_PRODUCTS;
  }
  return products;
}

/**
 * Shop Bot Handler
 */
async function handle({ update, bot, api, db }) {
  const message = update.message;
  const callback = update.callback_query;

  // 1. Handle Callback Queries (Inline Button Clicks)
  if (callback) {
    const chatId = callback.message?.chat?.id;
    const data = callback.data || '';
    const queryId = callback.id;

    if (data === 'shop:catalog') {
      await api.answerCallbackQuery(queryId);
      const products = await getProducts(db);
      const keyboard = products.map(p => ([
        { text: `📦 ${p.title} - ${p.price.toLocaleString('fa-IR')} تومان`, callback_data: `shop:product:${p.id}` }
      ]));

      const text = '<b>🛍 کاتالوگ محصولات</b>\n\nلطفاً یک محصول را برای مشاهده جزئیات یا ثبت سفارش انتخاب کنید:';
      return api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    if (data.startsWith('shop:product:')) {
      await api.answerCallbackQuery(queryId);
      const prodId = data.replace('shop:product:', '');
      const products = await getProducts(db);
      const product = products.find(p => String(p.id) === String(prodId));

      if (!product) {
        return api.sendMessage(chatId, '❌ محصول مورد نظر یافت نشد.', { parse_mode: 'HTML' });
      }

      const text = `<b>📦 ${escapeHtml(product.title)}</b>\n\n` +
        `<b>قیمت:</b> ${product.price.toLocaleString('fa-IR')} تومان\n` +
        `<b>توضیحات:</b>\n${escapeHtml(product.description)}\n\n` +
        `<i>ℹ️ جهت ثبت درخواست سفارش بدون نیاز به درگاه آنلاین، دکمه زیر را بزنید.</i>`;

      const keyboard = [
        [{ text: '🛒 ثبت درخواست سفارش', callback_data: `shop:order:${product.id}` }],
        [{ text: '🔙 بازگشت به کاتالوگ', callback_data: 'shop:catalog' }]
      ];

      return api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    if (data.startsWith('shop:order:')) {
      await api.answerCallbackQuery(queryId, { text: 'درخواست سفارش دریافت شد.' });
      const prodId = data.replace('shop:order:', '');
      const products = await getProducts(db);
      const product = products.find(p => String(p.id) === String(prodId));

      if (!product) {
        return api.sendMessage(chatId, '❌ محصول یافت نشد.');
      }

      const user = callback.from || {};
      const order = {
        userId: user.id,
        username: user.username || `${user.first_name || 'کاربر'}`,
        productId: product.id,
        productTitle: product.title,
        price: product.price,
        status: 'pending',
        createdAt: new Date().toISOString()
      };

      const savedOrder = await db.save('orders', order);

      // Notify Owner
      if (bot.owner_id) {
        const adminText = `<b>🔔 درخواست سفارش جدید #${savedOrder.id}</b>\n\n` +
          `<b>خریدار:</b> ${escapeHtml(order.username)} (ID: <code>${order.userId}</code>)\n` +
          `<b>محصول:</b> ${escapeHtml(order.productTitle)}\n` +
          `<b>مبلغ:</b> ${order.price.toLocaleString('fa-IR')} تومان\n` +
          `<b>وضعیت:</b> در انتظار بررسی ادمین`;
        await api.sendMessage(bot.owner_id, adminText, { parse_mode: 'HTML' }).catch(() => {});
      }

      const userText = `<b>✅ درخواست سفارش شما با موفقیت ثبت شد!</b>\n\n` +
        `<b>شماره سفارش:</b> <code>${savedOrder.id}</code>\n` +
        `<b>محصول:</b> ${escapeHtml(product.title)}\n` +
        `<b>مبلغ:</b> ${product.price.toLocaleString('fa-IR')} تومان\n\n` +
        `<i>ادمین به‌زودی جهت هماهمگی ارسال و پرداخت با شما تماس خواهد گرفت.</i>\n\n` +
        `⚠️ <i>توضیحات: این ربات کاتالوگ بدون درگاه پرداخت مستقیم است.</i>`;

      return api.sendMessage(chatId, userText, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🛍 بازگشت به کاتالوگ', callback_data: 'shop:catalog' }]]
        }
      });
    }
  }

  // 2. Handle Message Commands
  if (message) {
    const chatId = message.chat?.id;
    const text = (message.text || '').trim();
    const fromId = message.from?.id;

    if (text.startsWith('/start') || text === '/catalog') {
      const welcome = `<b>🛍 به فروشگاه آنلاین خوش آمدید!</b>\n\n` +
        `شما می‌توانید کاتالوگ محصولات را مشاهده کرده و درخواست سفارش خود را ثبت کنید.\n\n` +
        `⚠️ <b>محدودیت و شفافیت:</b> این ربات مجهز به درگاه پرداخت آنلاین متمرکز نیست. ثبت سفارش به صورت درخواست پیش‌سفارش ثبت شده و هماهمگی نهایی توسط مدیریت صورت می‌پذیرد.`;

      const products = await getProducts(db);
      const keyboard = products.map(p => ([
        { text: `📦 ${p.title} - ${p.price.toLocaleString('fa-IR')} تومان`, callback_data: `shop:product:${p.id}` }
      ]));

      return api.sendMessage(chatId, welcome, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    if (text.startsWith('/addproduct')) {
      if (fromId !== bot.owner_id) {
        return api.sendMessage(chatId, '⛔️ فقط ادمین ربات مجاز به افزودن محصول است.', { parse_mode: 'HTML' });
      }

      const body = text.slice(11).trim();
      const parts = body.split('|').map(s => s.trim());
      if (parts.length < 3 || !parts[0] || isNaN(Number(parts[1]))) {
        return api.sendMessage(chatId, '❌ فرمت نادرست.\nفرمت صحیح:\n<code>/addproduct عنوان | قیمت | توضیحات</code>', { parse_mode: 'HTML' });
      }

      const newProduct = {
        title: parts[0],
        price: Number(parts[1]),
        description: parts.slice(2).join('|')
      };

      const saved = await db.save('products', newProduct);
      return api.sendMessage(chatId, `✅ محصول با موفقیت اضافه شد:\n<b>${escapeHtml(saved.title)}</b> (${saved.price.toLocaleString('fa-IR')} تومان)`, { parse_mode: 'HTML' });
    }

    if (text === '/orders') {
      if (fromId !== bot.owner_id) {
        return api.sendMessage(chatId, '⛔️ فقط ادمین مجاز به مشاهده لیست سفارشات است.', { parse_mode: 'HTML' });
      }

      const orders = await db.find('orders', {});
      if (!orders || orders.length === 0) {
        return api.sendMessage(chatId, '📋 هیچ درخواستی تا کنون ثبت نشده است.', { parse_mode: 'HTML' });
      }

      const listStr = orders.slice(-10).map(o =>
        `• <b>#${o.id}</b> | خریدار: ${escapeHtml(o.username)} | ${escapeHtml(o.productTitle)} (${o.price.toLocaleString('fa-IR')} تومان)`
      ).join('\n');

      return api.sendMessage(chatId, `<b>📋 ۱۰ سفارش اخیر:</b>\n\n${listStr}`, { parse_mode: 'HTML' });
    }

    if (text === '/help') {
      const helpText = `<b>📖 راهنمای ربات فروشگاهی</b>\n\n` +
        `/start - شروع و مشاهده کاتالوگ\n` +
        `/catalog - لیست محصولات\n` +
        `/help - راهنما\n\n` +
        `<b>دستورات ادمین:</b>\n` +
        `<code>/addproduct عنوان | قیمت | توضیحات</code>\n` +
        `<code>/orders</code> - مشاهده سفارش‌ها`;
      return api.sendMessage(chatId, helpText, { parse_mode: 'HTML' });
    }
  }
}

module.exports = { handle, getProducts };
