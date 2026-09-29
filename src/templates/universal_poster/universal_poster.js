'use strict';

const { escapeHtml } = require('../../utils/html');
const { validateUrl } = require('../../utils/ssrf');

const DEFAULT_SETTINGS = {
  caption: '⚡️ <b>کانفیگ اختصاصی جدید</b>\n\n' +
    '<b>پروتکل:</b> <code>{protocol}</code>\n' +
    '<b>نام / رمارک:</b> <code>{remark}</code>\n\n' +
    '<i>جهت اتصال، کانفیگ زیر را کپی کرده و در برنامه وارد کنید.</i>',
  showChannelBranding: true,
  channelBranding: '@MyChannel',
  channelBtnLabel: '📢 عضویت در کانال',
  channelBtnUrl: 'https://t.me/telegram',
  copyLabel: '📋 کپی کانفیگ',
  configsPerRequest: 1,
  ovpnWinUrl: 'https://openvpn.net/client-connect-vpn-for-windows/',
  ovpnAndroidUrl: 'https://play.google.com/store/apps/details?id=net.openvpn.openvpn',
  ovpnIosUrl: 'https://apps.apple.com/us/app/openvpn-connect/id590379981'
};

/**
 * Multi-protocol V2Ray/WireGuard/OpenVPN/JSON config parser
 */
function parseConfig(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = rawText.trim();

  // 1. Check JSON config
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const obj = JSON.parse(text);
      const protocol = obj.protocol || obj.outbounds?.[0]?.protocol || 'JSON/V2Ray';
      const remark = obj.remark || obj.tag || obj.name || 'JSON-Config';
      return {
        protocol: String(protocol).toUpperCase(),
        remark: String(remark),
        raw: text,
        type: 'json'
      };
    } catch (_) {}
  }

  // 2. WireGuard config text
  if (text.includes('[Interface]') || text.includes('[Peer]')) {
    const addressMatch = text.match(/Address\s*=\s*([^\n]+)/i);
    const remark = addressMatch ? `WG (${addressMatch[1].trim()})` : 'WireGuard Config';
    return {
      protocol: 'WIREGUARD',
      remark,
      raw: text,
      type: 'wireguard'
    };
  }

  // 3. OpenVPN config text
  if (text.includes('client') && (text.includes('<ca>') || text.includes('remote '))) {
    const remoteMatch = text.match(/remote\s+([^\s\n]+)/i);
    const remark = remoteMatch ? `OVPN (${remoteMatch[1].trim()})` : 'OpenVPN Config';
    return {
      protocol: 'OPENVPN',
      remark,
      raw: text,
      type: 'openvpn'
    };
  }

  // 4. URI-based protocols (vless, vmess, trojan, ss, hy2, hysteria, tuic)
  const uriMatch = text.match(/^(vless|vmess|trojan|ss|hysteria|hy2|tuic):\/\/(.+)$/i);
  if (uriMatch) {
    const scheme = uriMatch[1].toLowerCase();
    const body = uriMatch[2];
    let remark = 'Config';

    if (scheme === 'vmess') {
      try {
        const decoded = Buffer.from(body.split('#')[0], 'base64').toString('utf8');
        const vmessObj = JSON.parse(decoded);
        remark = vmessObj.ps || vmessObj.add || 'VMess';
      } catch (_) {
        remark = 'VMess Config';
      }
    } else {
      // Check for fragment remark (#remark)
      const hashIndex = body.indexOf('#');
      if (hashIndex !== -1) {
        try {
          remark = decodeURIComponent(body.substring(hashIndex + 1)) || 'Config';
        } catch (_) {
          remark = body.substring(hashIndex + 1) || 'Config';
        }
      } else {
        remark = `${scheme.toUpperCase()} Config`;
      }
    }

    return {
      protocol: scheme.toUpperCase(),
      remark,
      raw: text,
      type: 'uri'
    };
  }

  return null;
}

/**
 * Get merged settings from DB or defaults
 */
async function getSettings(db) {
  const custom = (await db.get('settings')) || {};
  return { ...DEFAULT_SETTINGS, ...custom };
}

/**
 * Main Template Handler
 */
async function handle({ update, bot, api, db }) {
  const message = update.message;
  const callback = update.callback_query;
  const isOwner = (userId) => Number(userId) === Number(bot.owner_id);

  // 1. Handle Inline Callbacks
  if (callback) {
    const chatId = callback.message?.chat?.id;
    const data = callback.data || '';
    const queryId = callback.id;
    const userId = callback.from?.id;

    if (data === 'poster:get_config') {
      await api.answerCallbackQuery(queryId);
      const settings = await getSettings(db);
      const pool = await db.find('configs', {});

      if (!pool || pool.length === 0) {
        return api.sendMessage(chatId, '❌ در حال حاضر کانفیگ رایگانی در استخر موجود نیست.', { parse_mode: 'HTML' });
      }

      // Pick available configs up to limit
      const count = Math.min(settings.configsPerRequest || 1, pool.length);
      const selected = pool.slice(0, count);

      for (const item of selected) {
        const parsed = parseConfig(item.raw) || { protocol: 'VPN', remark: 'Free Config', raw: item.raw };
        const caption = settings.caption
          .replace('{protocol}', escapeHtml(parsed.protocol))
          .replace('{remark}', escapeHtml(parsed.remark))
          .replace('{channel}', escapeHtml(settings.channelBranding));

        const keyboard = [
          [{ text: settings.copyLabel, callback_data: `poster:copy:${item.id}` }]
        ];

        if (settings.showChannelBranding && settings.channelBtnUrl) {
          keyboard.push([{ text: settings.channelBtnLabel, url: settings.channelBtnUrl }]);
        }

        await api.sendMessage(chatId, `${caption}\n\n<code>${escapeHtml(parsed.raw)}</code>`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard }
        });
      }
      return;
    }

    if (data.startsWith('poster:copy:')) {
      const configId = data.replace('poster:copy:', '');
      const configs = await db.find('configs', { id: configId });
      const configItem = configs[0];

      if (configItem) {
        await api.answerCallbackQuery(queryId, { text: '📋 کانفیگ آماده کپی است!', show_alert: false });
        return api.sendMessage(chatId, `<b>📋 جهت کپی، متن زیر را لمس کنید:</b>\n\n<code>${escapeHtml(configItem.raw)}</code>`, {
          parse_mode: 'HTML'
        });
      } else {
        return api.answerCallbackQuery(queryId, { text: '❌ کانفیگ یافت نشد.', show_alert: true });
      }
    }

    if (data === 'poster:settings') {
      await api.answerCallbackQuery(queryId);
      if (!isOwner(userId)) {
        return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز به دسترسی به تنظیمات است.');
      }
      const settings = await getSettings(db);
      const pool = await db.find('configs', {});

      const settingsText = `<b>⚙️ پنل تنظیمات پست‌ساز جامع (Universal Poster)</b>\n\n` +
        `<b>تعداد کانفیگ موجود در استخر:</b> ${pool.length}\n` +
        `<b>برندینگ کانال:</b> ${escapeHtml(settings.channelBranding)}\n` +
        `<b>لینک کانال:</b> <code>${escapeHtml(settings.channelBtnUrl)}</code>\n` +
        `<b>عنوان دکمه کپی:</b> ${escapeHtml(settings.copyLabel)}\n` +
        `<b>تعداد کانفیگ در هر درخواست:</b> ${settings.configsPerRequest}\n\n` +
        `<b>دستورات مدیریت:</b>\n` +
        `• <code>/setcaption متن</code> - تغییر کپشن پست\n` +
        `• <code>/setbranding @channel</code> - تغییر نام برند کانال\n` +
        `• <code>/setchannelurl لینک</code> - تغییر لینک کانال\n` +
        `• <code>/setcopylabel عنوان</code> - تغییر عنوان دکمه کپی\n` +
        `• <code>/addconfig لینک_یا_متن</code> - افزودن کانفیگ به استخر\n` +
        `• <code>/clearconfigs</code> - پاکسازی استخر کانفیگ`;

      return api.sendMessage(chatId, settingsText, { parse_mode: 'HTML' });
    }
  }

  // 2. Handle Text Messages
  if (message) {
    const chatId = message.chat?.id;
    const text = (message.text || '').trim();
    const userId = message.from?.id;

    // Commands: /start, /help
    if (text.startsWith('/start') || text === '/help') {
      const settings = await getSettings(db);
      const welcome = `<b>⚡️ به ربات پست‌ساز جامع و دریافت کانفیگ خوش آمدید!</b>\n\n` +
        `این ربات قابلیت پارس و فرمت کانفیگ‌های multi-protocol (VLESS, VMess, Trojan, SS, Hysteria, Tuic, WireGuard, OpenVPN) را داراست.\n\n` +
        `• <b>دریافت کانفیگ رایگان:</b> دستور /getconfig را ارسال کنید.\n` +
        `• <b>پارس و ساخت پست:</b> متن یا لینک کانفیگ را مستقیماً ارسال کنید.`;

      const keyboard = [
        [{ text: '🆓 دریافت کانفیگ رایگان', callback_data: 'poster:get_config' }]
      ];

      if (isOwner(userId)) {
        keyboard.push([{ text: '⚙️ پنل مدیریت و تنظیمات مالک', callback_data: 'poster:settings' }]);
      }

      return api.sendMessage(chatId, welcome, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    // Owner Commands
    if (text.startsWith('/setcaption')) {
      if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز است.');
      const val = text.replace('/setcaption', '').trim();
      if (!val) return api.sendMessage(chatId, '❌ لطفاً متن کپشن را وارد کنید.');
      const current = await getSettings(db);
      await db.set('settings', { ...current, caption: val });
      return api.sendMessage(chatId, '✅ کپشن با موفقیت بروزرسانی شد.');
    }

    if (text.startsWith('/setbranding')) {
      if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز است.');
      const val = text.replace('/setbranding', '').trim();
      if (!val) return api.sendMessage(chatId, '❌ لطفاً نام برندینگ کانال را وارد کنید.');
      const current = await getSettings(db);
      await db.set('settings', { ...current, channelBranding: val });
      return api.sendMessage(chatId, '✅ برندینگ کانال با موفقیت بروزرسانی شد.');
    }

    if (text.startsWith('/setchannelurl')) {
      if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز است.');
      const val = text.replace('/setchannelurl', '').trim();
      const validation = validateUrl(val);
      if (!validation.safe) {
        return api.sendMessage(chatId, `❌ لینک غیرمجاز است: ${escapeHtml(validation.reason)}`, { parse_mode: 'HTML' });
      }
      const current = await getSettings(db);
      await db.set('settings', { ...current, channelBtnUrl: val });
      return api.sendMessage(chatId, '✅ لینک کانال با موفقیت بروزرسانی شد.');
    }

    if (text.startsWith('/setcopylabel')) {
      if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز است.');
      const val = text.replace('/setcopylabel', '').trim();
      if (!val) return api.sendMessage(chatId, '❌ لطفاً عنوان دکمه را وارد کنید.');
      const current = await getSettings(db);
      await db.set('settings', { ...current, copyLabel: val });
      return api.sendMessage(chatId, '✅ عنوان دکمه کپی با موفقیت بروزرسانی شد.');
    }

    if (text.startsWith('/addconfig')) {
      if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز است.');
      const rawConfig = text.replace('/addconfig', '').trim();
      if (!rawConfig) return api.sendMessage(chatId, '❌ لطفاً متن یا لینک کانفیگ را وارد کنید.');

      const saved = await db.save('configs', { raw: rawConfig, addedAt: new Date().toISOString() });
      return api.sendMessage(chatId, `✅ کانفیگ جدید با شناسه <code>${saved.id}</code> به استخر اضافه شد.`, { parse_mode: 'HTML' });
    }

    if (text === '/clearconfigs') {
      if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز است.');
      const pool = await db.find('configs', {});
      for (const item of pool) {
        await db.delete('configs', item.id);
      }
      return api.sendMessage(chatId, '✅ استخر کانفیگ‌ها پاکسازی شد.');
    }

    if (text === '/settings' || text === '/admin') {
      if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز است.');
      const settings = await getSettings(db);
      const pool = await db.find('configs', {});

      const settingsText = `<b>⚙️ پنل تنظیمات مالک (Universal Poster)</b>\n\n` +
        `<b>تعداد کانفیگ موجود در استخر:</b> ${pool.length}\n` +
        `<b>برندینگ کانال:</b> ${escapeHtml(settings.channelBranding)}\n` +
        `<b>لینک کانال:</b> <code>${escapeHtml(settings.channelBtnUrl)}</code>\n` +
        `<b>عنوان دکمه کپی:</b> ${escapeHtml(settings.copyLabel)}\n` +
        `<b>تعداد در هر درخواست:</b> ${settings.configsPerRequest}\n\n` +
        `<b>دستورات تغییر تنظیمات:</b>\n` +
        `• <code>/setcaption متن</code>\n` +
        `• <code>/setbranding @channel</code>\n` +
        `• <code>/setchannelurl https://t.me/...</code>\n` +
        `• <code>/setcopylabel عنوان</code>\n` +
        `• <code>/addconfig لینک_کانفیگ</code>\n` +
        `• <code>/clearconfigs</code>`;

      return api.sendMessage(chatId, settingsText, { parse_mode: 'HTML' });
    }

    if (text === '/getconfig' || text === '🆓 دریافت کانفیگ رایگان') {
      const settings = await getSettings(db);
      const pool = await db.find('configs', {});

      if (!pool || pool.length === 0) {
        return api.sendMessage(chatId, '❌ در حال حاضر کانفیگ رایگانی در استخر موجود نیست.', { parse_mode: 'HTML' });
      }

      const item = pool[0];
      const parsed = parseConfig(item.raw) || { protocol: 'VPN', remark: 'Free Config', raw: item.raw };
      const caption = settings.caption
        .replace('{protocol}', escapeHtml(parsed.protocol))
        .replace('{remark}', escapeHtml(parsed.remark))
        .replace('{channel}', escapeHtml(settings.channelBranding));

      const keyboard = [
        [{ text: settings.copyLabel, callback_data: `poster:copy:${item.id}` }]
      ];

      if (settings.showChannelBranding && settings.channelBtnUrl) {
        keyboard.push([{ text: settings.channelBtnLabel, url: settings.channelBtnUrl }]);
      }

      return api.sendMessage(chatId, `${caption}\n\n<code>${escapeHtml(parsed.raw)}</code>`, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    // Config Parsing & Formatting for arbitrary text input
    const parsed = parseConfig(text);
    if (parsed) {
      const settings = await getSettings(db);
      const caption = settings.caption
        .replace('{protocol}', escapeHtml(parsed.protocol))
        .replace('{remark}', escapeHtml(parsed.remark))
        .replace('{channel}', escapeHtml(settings.channelBranding));

      const keyboard = [];
      if (settings.showChannelBranding && settings.channelBtnUrl) {
        keyboard.push([{ text: settings.channelBtnLabel, url: settings.channelBtnUrl }]);
      }

      const formattedPost = `<b>✅ کانفیگ شناسایی و پست ساخت داده شد:</b>\n\n` +
        `${caption}\n\n` +
        `<code>${escapeHtml(parsed.raw)}</code>`;

      return api.sendMessage(chatId, formattedPost, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    return api.sendMessage(chatId, '❌ متن وارد شده فرمت کانفیگ معتبری (VLESS/VMess/Trojan/WireGuard/OpenVPN/JSON) نیست.\nجهت راهنما /help را ارسال کنید.', { parse_mode: 'HTML' });
  }
}

module.exports = { handle, parseConfig, DEFAULT_SETTINGS };
