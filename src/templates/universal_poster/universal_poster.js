'use strict';

const { escapeHtml } = require('../../utils/html');
const { validateUrl } = require('../../utils/ssrf');

// CopyTextButton payload limit is 256 characters — longer payloads are
// stored in an internal hash-based store keyed by a short id and resolved
// via callback (never a public web redirect).
const COPY_TEXT_LIMIT = 256;

const DEFAULT_SETTINGS = {
  caption: '⚡️ <b>کانفیگ اختصاصی جدید</b>\n\n<b>پروتکل:</b> <code>{protocol}</code>\n<b>نام / رمارک:</b> <code>{remark}</code>\n\n<i>جهت اتصال، کانفیگ زیر را کپی کرده و در برنامه وارد کنید.</i>',
  showChannelBranding: true,
  channelBranding: '@MyChannel',
  channelBtnLabel: '📢 عضویت در کانال',
  channelBtnUrl: 'https://t.me/telegram',
  copyLabel: '📋 کپی کانفیگ',
  copyAllLabel: '📋📋 کپی همه کانفیگ‌ها',
  configsPerRequest: 1,
  targetChannel: ''
};

/**
 * Multi-protocol config parser for a SINGLE line.
 * Batch parsing must call this per line — NO regex-based protocol splitting
 * across the whole text, to avoid mutating protocol strings (e.g. VLESS
 * misidentified as Shadowsocks inside a larger blob).
 */
function parseConfig(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = rawText.trim();
  if (!text) return null;

  // 1. JSON config
  if (text.startsWith('{') && text.endsWith('}')) {
    try {
      const obj = JSON.parse(text);
      const protocol = obj.protocol || obj.outbounds?.[0]?.protocol || 'JSON/V2Ray';
      const remark = obj.remark || obj.tag || obj.name || 'JSON-Config';
      return { protocol: String(protocol).toUpperCase(), remark: String(remark), raw: text, type: 'json' };
    } catch (_) { /* not valid JSON */ }
  }

  // 2. WireGuard
  if (text.includes('[Interface]') || text.includes('[Peer]')) {
    const addressMatch = text.match(/Address\s*=\s*([^\n]+)/i);
    const remark = addressMatch ? `WG (${addressMatch[1].trim()})` : 'WireGuard Config';
    return { protocol: 'WIREGUARD', remark, raw: text, type: 'wireguard' };
  }

  // 3. OpenVPN text (inline, single line unlikely but supported)
  if (/^client\b/im.test(text) && (text.includes('<ca>') || /\bremote\s+\S+/im.test(text))) {
    const remoteMatch = text.match(/remote\s+([^\s\n]+)/i);
    const remark = remoteMatch ? `OVPN (${remoteMatch[1].trim()})` : 'OpenVPN Config';
    return { protocol: 'OPENVPN', remark, raw: text, type: 'openvpn' };
  }

  // 4. URI-based protocols — single-line schemes only
  const uriMatch = text.match(/^(vless|vmess|trojan|ss|hysteria2?|hy2|tuic):\/\/(.+)$/i);
  if (uriMatch) {
    const scheme = uriMatch[1].toLowerCase();
    const body = uriMatch[2];
    let remark = 'Config';
    if (scheme === 'vmess') {
      try {
        const decoded = Buffer.from(body.split('#')[0], 'base64').toString('utf8');
        const vmessObj = JSON.parse(decoded);
        remark = vmessObj.ps || vmessObj.add || 'VMess';
      } catch (_) { remark = 'VMess Config'; }
    } else {
      const hashIndex = body.indexOf('#');
      if (hashIndex !== -1) {
        try { remark = decodeURIComponent(body.substring(hashIndex + 1)) || 'Config'; }
        catch (_) { remark = body.substring(hashIndex + 1) || 'Config'; }
      } else {
        remark = `${scheme.toUpperCase()} Config`;
      }
    }
    return { protocol: scheme.toUpperCase(), remark, raw: text, type: 'uri' };
  }
  return null;
}

/**
 * Batch multi-config parsing: line-by-line (spec §3.7).
 * Each line is parsed independently; unparseable lines are reported, not guessed.
 */
function parseConfigBatch(rawText) {
  const lines = String(rawText || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const configs = [];
  const invalid = [];
  for (const line of lines) {
    const parsed = parseConfig(line);
    if (parsed) configs.push(parsed);
    else invalid.push(line);
  }
  return { configs, invalid, total: lines.length };
}

/**
 * Copy button builder. Payloads <= 256 chars use the native CopyTextButton.
 * Longer payloads are stored in the internal hash store keyed by a short id
 * and resolved via callback (never a public web redirect).
 */
async function makeCopyButton(db, label, payload) {
  if (payload.length <= COPY_TEXT_LIMIT) {
    return { text: label, copy_text: { text: payload } }; // native CopyTextButton
  }
  const shortId = Math.random().toString(36).slice(2, 10);
  await db.save('copy_store', { short_id: shortId, content: payload });
  return { text: label, callback_data: `poster:copylong:${shortId}` };
}

async function getSettings(db) {
  const custom = (await db.get('settings')) || {};
  return { ...DEFAULT_SETTINGS, ...custom };
}

function brandingFooter(settings) {
  if (!settings.showChannelBranding) return '';
  // blockquote branding footer
  return `\n<blockquote>🎁 ارائه‌دهنده: ${escapeHtml(settings.channelBranding)}</blockquote>`;
}

module.exports = {
  id: 'universal_poster',
  category: 'publishing',
  name: 'پست‌ساز جامع (Universal Poster & Config Parser)',
  description: 'پست‌ساز کانال با پارس چندکانفیگی خط‌به‌خط، دکمه کپی بومی تلگرام (CopyText)، ارسال فایل ovpn/conf بدون تغییر، برندینگ بلاک‌کوت و پیش‌نمایش + تأیید قبل از انتشار.',
  features: [
    'پارس batch چندکانفیگ، خط به خط (بدون باگ تشخیص اشتباه پروتکل)',
    'کپی تکی و «کپی همه» با CopyTextButton بومی (سقف ۲۵۶ کاراکتر؛ payloads بلندتر در فروش هش داخلی)',
    'ارسال فایل .ovpn/.conf دقیقاً همان‌طور که هست (بدون پارس)',
    'برندینگ به‌صورت بلاک‌کوت + پیش‌نمایش و تأیید صریح قبل از انتشار'
  ],

  async handle({ update, bot, api, db }) {
    const message = update.message;
    const callback = update.callback_query;
    const isOwner = (userId) => Number(userId) === Number(bot.owner_id);

    // ---------------------------------------------------- .ovpn/.conf documents
    if (message?.document) {
      const fname = message.document.file_name || '';
      const chatId = message.chat?.id;
      if (/\.(ovpn|conf)$/i.test(fname)) {
        // files are sent AS-IS, never parsed (spec §3.7)
        const settings = await getSettings(db);
        if (isOwner(message.from?.id) && settings.targetChannel) {
          try {
            await api.copyMessage(settings.targetChannel, chatId, message.message_id);
            return api.sendMessage(chatId, `✅ فایل <code>${escapeHtml(fname)}</code> بدون هیچ تغییری در کانال منتشر شد.`, { parse_mode: 'HTML' });
          } catch (_) {
            return api.sendMessage(chatId, '❌ انتشار در کانال ناموفق بود؛ ربات ادمین کانال است؟');
          }
        }
        return api.sendMessage(chatId,
          `📎 فایل <code>${escapeHtml(fname)}</code> دریافت شد. این قالب فایل‌های ovpn/conf را بدون پارس، همان‌طور که هست منتشر می‌کند.` +
          (isOwner(message.from?.id) ? '\nبرای انتشار، ابتدا با /setchannel کانال هدف را تنظیم کنید.' : ''),
          { parse_mode: 'HTML' });
      }
      return api.sendMessage(chatId, '⚠️ فقط فایل‌های <code>.ovpn</code> و <code>.conf</code> در این قالب پشتیبانی می‌شوند.', { parse_mode: 'HTML' });
    }

    // ------------------------------------------------------------ callbacks
    if (callback) {
      const chatId = callback.message?.chat?.id;
      const data = callback.data || '';
      const queryId = callback.id;
      const userId = callback.from?.id;

      // free config pool
      if (data === 'poster:get_config') {
        await api.answerCallbackQuery(queryId);
        const settings = await getSettings(db);
        const pool = await db.find('configs', {});
        if (!pool.length) return api.sendMessage(chatId, '❌ در حال حاضر کانفیگ رایگانی در استخر موجود نیست.', { parse_mode: 'HTML' });
        const count = Math.min(settings.configsPerRequest || 1, pool.length);
        for (const item of pool.slice(0, count)) {
          const parsed = parseConfig(item.raw) || { protocol: 'VPN', remark: 'Free Config', raw: item.raw };
          const caption = settings.caption
            .replace('{protocol}', escapeHtml(parsed.protocol))
            .replace('{remark}', escapeHtml(parsed.remark))
            .replace('{channel}', escapeHtml(settings.channelBranding));
          const keyboard = [[await makeCopyButton(db, settings.copyLabel, item.raw)]];
          if (settings.showChannelBranding && settings.channelBtnUrl) {
            keyboard.push([{ text: settings.channelBtnLabel, url: settings.channelBtnUrl }]);
          }
          await api.sendMessage(chatId, `${caption}\n\n<code>${escapeHtml(parsed.raw)}</code>${brandingFooter(settings)}`, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard }
          });
        }
        return;
      }

      // long payload copy: resolve from internal hash store (never a web redirect)
      if (data.startsWith('poster:copylong:')) {
        const shortId = data.split(':')[2];
        const stored = await db.find('copy_store', { short_id: shortId });
        const item = stored[0];
        if (!item) return api.answerCallbackQuery(queryId, { text: '❌ محتوا یافت نشد.', show_alert: true });
        await api.answerCallbackQuery(queryId, { text: '📋 محتوا ارسال شد؛ متن را لمس و کپی کنید.' });
        return api.sendMessage(chatId, `<b>📋 جهت کپی، متن زیر را لمس کنید:</b>\n\n<code>${escapeHtml(item.content)}</code>`, { parse_mode: 'HTML' });
      }

      // publish confirmation
      if (data === 'poster:confirm_publish') {
        const draft = await db.get('publish_draft');
        if (!draft) return api.answerCallbackQuery(queryId, { text: 'پیش‌نمایشی برای انتشار نیست.', show_alert: true });
        const settings = await getSettings(db);
        if (!settings.targetChannel) {
          return api.answerCallbackQuery(queryId, { text: 'ابتدا /setchannel را تنظیم کنید.', show_alert: true });
        }
        await api.answerCallbackQuery(queryId, { text: 'در حال انتشار...' });
        let published = 0;
        for (const cfg of draft.configs) {
          const caption = settings.caption
            .replace('{protocol}', escapeHtml(cfg.protocol))
            .replace('{remark}', escapeHtml(cfg.remark))
            .replace('{channel}', escapeHtml(settings.channelBranding));
          const keyboard = [[await makeCopyButton(db, settings.copyLabel, cfg.raw)]];
          if (settings.showChannelBranding && settings.channelBtnUrl) {
            keyboard.push([{ text: settings.channelBtnLabel, url: settings.channelBtnUrl }]);
          }
          try {
            await api.sendMessage(settings.targetChannel, `${caption}\n\n<code>${escapeHtml(cfg.raw)}</code>${brandingFooter(settings)}`, {
              parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
            });
            published++;
          } catch (_) { }
        }
        await db.set('publish_draft', null);
        return api.sendMessage(chatId, `✅ <b>${published}</b> کانفیگ در کانال ${escapeHtml(settings.targetChannel)} منتشر شد.`, { parse_mode: 'HTML' });
      }

      if (data === 'poster:cancel_publish') {
        await db.set('publish_draft', null);
        await api.answerCallbackQuery(queryId, { text: 'انتشار لغو شد.' });
        return api.sendMessage(chatId, '❌ انتشار لغو شد.');
      }

      if (data === 'poster:settings') {
        await api.answerCallbackQuery(queryId);
        if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز به دسترسی به تنظیمات است.');
        const settings = await getSettings(db);
        const pool = await db.find('configs', {});
        return api.sendMessage(chatId,
          `<b>⚙️ پنل تنظیمات پست‌ساز جامع</b>\n\n` +
          `کانفیگ در استخر: <b>${pool.length}</b>\n` +
          `کانال انتشار: <code>${escapeHtml(settings.targetChannel || 'تنظیم نشده')}</code>\n` +
          `برندینگ: ${escapeHtml(settings.channelBranding)}\n\n` +
          `<b>دستورات:</b>\n` +
          `• <code>/setchannel @target</code> — کانال انتشار\n` +
          `• <code>/setcaption متن</code> — کپشن پست\n` +
          `• <code>/setbranding @channel</code>\n` +
          `• <code>/setchannelurl لینک</code>\n` +
          `• <code>/addconfig کانفیگ</code> — افزودن به استخر رایگان\n` +
          `• <code>/clearconfigs</code>`,
          { parse_mode: 'HTML' });
      }
      return;
    }

    // ------------------------------------------------------------ messages
    if (message) {
      const chatId = message.chat?.id;
      const text = (message.text || '').trim();
      const userId = message.from?.id;

      if (text.startsWith('/start') || text === '/help') {
        const keyboard = [[{ text: '🆓 دریافت کانفیگ رایگان', callback_data: 'poster:get_config' }]];
        if (isOwner(userId)) keyboard.push([{ text: '⚙️ پنل مدیریت', callback_data: 'poster:settings' }]);
        return api.sendMessage(chatId,
          `<b>⚡️ پست‌ساز جامع و پارسر کانفیگ</b>\n\nپشتیبانی از VLESS, VMess, Trojan, SS, Hysteria, Tuic, WireGuard, OpenVPN و JSON.\n\n` +
          `• چند کانفیگ را خط‌به‌خط بفرستید تا پیش‌نمایش پست ساخته شود\n` +
          `• فایل <code>.ovpn</code>/<code>.conf</code> بدون پارس، همان‌طور که هست منتشر می‌شود\n` +
          `• دکمه «کپی» بومی تلگرام (سقف ۲۵۶ کاراکتر؛ بلندتر از آن به‌صورت پیام کپی)`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
      }

      if (!isOwner(userId)) {
        return api.sendMessage(chatId, '🆓 برای دریافت کانفیگ رایگان دکمه زیر را بزنید.', { reply_markup: { inline_keyboard: [[{ text: '🆓 دریافت کانفیگ رایگان', callback_data: 'poster:get_config' }]] } });
      }

      // ----- owner commands
      if (text.startsWith('/setchannel')) {
        const val = text.replace('/setchannel', '').trim();
        if (!val) return api.sendMessage(chatId, 'فرمت: <code>/setchannel @target</code>', { parse_mode: 'HTML' });
        const cur = await getSettings(db);
        await db.set('settings', { ...cur, targetChannel: val });
        return api.sendMessage(chatId, `✅ کانال انتشار: <code>${escapeHtml(val)}</code>`, { parse_mode: 'HTML' });
      }
      if (text.startsWith('/setcaption')) {
        const val = text.replace('/setcaption', '').trim();
        if (!val) return api.sendMessage(chatId, '❌ لطفاً متن کپشن را وارد کنید.');
        const cur = await getSettings(db);
        await db.set('settings', { ...cur, caption: val });
        return api.sendMessage(chatId, '✅ کپشن بروزرسانی شد.');
      }
      if (text.startsWith('/setbranding')) {
        const val = text.replace('/setbranding', '').trim();
        if (!val) return api.sendMessage(chatId, '❌ نام برندینگ را وارد کنید.');
        const cur = await getSettings(db);
        await db.set('settings', { ...cur, channelBranding: val });
        return api.sendMessage(chatId, '✅ برندینگ بروزرسانی شد.');
      }
      if (text.startsWith('/setchannelurl')) {
        const val = text.replace('/setchannelurl', '').trim();
        const validation = validateUrl(val);
        if (!validation.safe) return api.sendMessage(chatId, `❌ لینک غیرمجاز: ${escapeHtml(validation.reason)}`, { parse_mode: 'HTML' });
        const cur = await getSettings(db);
        await db.set('settings', { ...cur, channelBtnUrl: val });
        return api.sendMessage(chatId, '✅ لینک کانال بروزرسانی شد.');
      }
      if (text.startsWith('/addconfig')) {
        const rawConfig = text.replace('/addconfig', '').trim();
        if (!rawConfig) return api.sendMessage(chatId, '❌ کانفیگ را بعد از دستور بنویسید.');
        const saved = await db.save('configs', { raw: rawConfig, addedAt: new Date().toISOString() });
        return api.sendMessage(chatId, `✅ کانفیگ با شناسه <code>${saved.id}</code> به استخر اضافه شد.`, { parse_mode: 'HTML' });
      }
      if (text === '/clearconfigs') {
        const pool = await db.find('configs', {});
        for (const item of pool) await db.delete('configs', item.id);
        return api.sendMessage(chatId, '✅ استخر کانفیگ‌ها پاکسازی شد.');
      }

      // ----- free config fetch
      if (text === '/getconfig') {
        const settings = await getSettings(db);
        const pool = await db.find('configs', {});
        if (!pool.length) return api.sendMessage(chatId, '❌ استخر کانفیگ خالی است.', { parse_mode: 'HTML' });
        const item = pool[0];
        const parsed = parseConfig(item.raw) || { protocol: 'VPN', remark: 'Free Config', raw: item.raw };
        const caption = settings.caption
          .replace('{protocol}', escapeHtml(parsed.protocol))
          .replace('{remark}', escapeHtml(parsed.remark))
          .replace('{channel}', escapeHtml(settings.channelBranding));
        const keyboard = [[await makeCopyButton(db, settings.copyLabel, item.raw)]];
        if (settings.showChannelBranding && settings.channelBtnUrl) keyboard.push([{ text: settings.channelBtnLabel, url: settings.channelBtnUrl }]);
        return api.sendMessage(chatId, `${caption}\n\n<code>${escapeHtml(parsed.raw)}</code>${brandingFooter(settings)}`, {
          parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
        });
      }

      // ----- batch config text => preview + confirm-before-publish
      const batch = parseConfigBatch(text);
      if (batch.configs.length > 0) {
        const settings = await getSettings(db);
        // store long payloads in hash store keyed by short id
        const previewLines = [];
        for (const cfg of batch.configs) {
          if (cfg.raw.length > COPY_TEXT_LIMIT) {
            const shortId = Math.random().toString(36).slice(2, 10);
            await db.save('copy_store', { short_id: shortId, content: cfg.raw });
            cfg.copyLongId = shortId;
          }
        }
        for (const cfg of batch.configs) {
          previewLines.push(`• <b>${escapeHtml(cfg.protocol)}</b> — ${escapeHtml(cfg.remark)}`);
        }
        const combined = batch.configs.map((c) => c.raw).join('\n');
        const keyboard = [
          [{ text: '✅ تأیید و انتشار', callback_data: 'poster:confirm_publish' }, { text: '❌ انصراف', callback_data: 'poster:cancel_publish' }]
        ];
        if (combined.length <= COPY_TEXT_LIMIT) {
          keyboard.push([{ text: settings.copyAllLabel, copy_text: { text: combined } }]);
        } else {
          const shortId = Math.random().toString(36).slice(2, 10);
          await db.save('copy_store', { short_id: shortId, content: combined });
          keyboard.push([{ text: settings.copyAllLabel, callback_data: `poster:copylong:${shortId}` }]);
        }
        await db.set('publish_draft', { configs: batch.configs, createdAt: Date.now() });
        const invalidNote = batch.invalid.length
          ? `\n\n⚠️ <b>${batch.invalid.length}</b> خط قابل شناسایی نبود و نادیده گرفته شد.` : '';
        return api.sendMessage(chatId,
          `<b>👀 پیش‌نمایش پست (${batch.configs.length} کانفیگ):</b>\n\n${previewLines.join('\n')}${invalidNote}\n\nقبل از انتشار، تأیید کنید:`,
          { parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } });
      }

      if (/^vless:|^vmess:|^trojan:|^ss:|^hy2:|^hysteria2?:|^tuic:/i.test(text)) {
        const parsed = parseConfig(text);
        if (parsed) {
          const settings = await getSettings(db);
          const caption = settings.caption
            .replace('{protocol}', escapeHtml(parsed.protocol))
            .replace('{remark}', escapeHtml(parsed.remark))
            .replace('{channel}', escapeHtml(settings.channelBranding));
          const keyboard = [[await makeCopyButton(db, settings.copyLabel, parsed.raw)]];
          if (settings.showChannelBranding && settings.channelBtnUrl) keyboard.push([{ text: settings.channelBtnLabel, url: settings.channelBtnUrl }]);
          return api.sendMessage(chatId, `${caption}\n\n<code>${escapeHtml(parsed.raw)}</code>${brandingFooter(settings)}`, {
            parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard }
          });
        }
      }

      return api.sendMessage(chatId,
        '❌ فرمت کانفیگ معتبر نیست (VLESS/VMess/Trojan/SS/Hysteria/Tuic/WireGuard/OpenVPN/JSON).\nراهنما: /help',
        { parse_mode: 'HTML' });
    }
  }
};

// also export helpers for tests
module.exports.makeCopyButton = makeCopyButton;
module.exports.parseConfig = parseConfig;
module.exports.parseConfigBatch = parseConfigBatch;
module.exports.COPY_TEXT_LIMIT = COPY_TEXT_LIMIT;
