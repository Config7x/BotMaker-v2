'use strict';

/**
 * Containerized-template logic (§3.10 VPN Shop & §3.11 Config Auto-Scraper).
 *
 * These templates run as their own gVisor container per bot instance (via the
 * provisioner) — NOT as in-process webhook modules. Pre-built + code-reviewed:
 * no AI scan / no admin approval (unlike §6). Pro/VIP only — free/demo is
 * refused outright and the 60-minute demo cycle never applies.
 *
 * Creation wizards:
 *  • vpn_shop ('panel'): panel type → panel URL → panel user → panel password
 *    (stored AES-256-GCM encrypted, same scheme as bot tokens)
 *  • config_scraper ('telethon'): ToS ban-risk disclosure (must accept) →
 *    phone → OTP → optional 2FA password → session string (encrypted at rest)
 *
 * Per-bot panel: container status/start/stop/restart, wipe (container reset),
 * destroy; config_scraper additionally gets "manage source channels".
 */

function createContainerized(deps) {
  const {
    db, cfg, send, states, escapeHtml, fmt, encrypt, decrypt,
    provisioner, containerTemplates, telethon, clock, answerCallback
  } = deps;

  const state = (userId) => states.get(String(userId));
  const setState = (userId, s) => states.set(String(userId), s);
  const clearState = (userId) => states.delete(String(userId));

  // ------------------------------------------------------------ plan gating
  function planAllowed(planId) { return planId !== 'free'; }

  function refuseFree(userId) {
    return send(userId,
      '👑 این قالب <b>کانتینری</b> است و فقط روی پلن‌های <b>پرو / VIP</b> ارائه می‌شود (بدون دمو).');
  }

  // ------------------------------------------------------------- provisioning
  async function provisionBot(userId, bot) {
    const tpl = containerTemplates[bot.template_id];
    if (!tpl) return { ok: false };

    let env;
    if (tpl.wizard === 'panel') {
      const c = bot.config;
      env = {
        BM_BOT_TOKEN: decrypt(bot.token_encrypted, cfg.ENCRYPTION_KEY),
        BM_PANEL_TYPE: c.panel_type,
        BM_PANEL_URL: c.panel_url,
        BM_PANEL_USER: c.panel_user,
        BM_PANEL_PASS: decrypt(c.panel_pass_enc, cfg.ENCRYPTION_KEY),
        BM_BRAND_NAME: c.brand || 'BotMaker Shop'
      };
    } else {
      env = {
        BOT_TOKEN: decrypt(bot.token_encrypted, cfg.ENCRYPTION_KEY),
        TELETHON_SESSION_STRING: decrypt(bot.config.session_enc, cfg.ENCRYPTION_KEY),
        TELETHON_API_ID: String(cfg.TELETHON_API_ID || ''),
        TELETHON_API_HASH: cfg.TELETHON_API_HASH || '',
        OWNER_ID: String(userId),
        DEST_CHANNEL_USERNAME: bot.config.dest_channel || ''
      };
    }

    const r = await provisioner.provision({
      botId: bot.id, image: tpl.image, env, mem: tpl.mem, cpus: tpl.cpus, shm: tpl.shm
    });
    if (!r.ok) {
      db.updateBot(bot.id, { status: 'failed_provision' });
      return send(userId,
        r.reason === 'gvisor_missing'
          ? '🛑 راه‌اندازی کانتینر ممکن نیست: گارد امنیتی <b>gVisor</b> روی سرور فعال نیست و سیستم fail-closed است. بعد از نصب gVisor از پنل «راه‌اندازی مجدد» را بزنید.'
          : `❌ راه‌اندازی کانتینر ناموفق بود: <code>${escapeHtml(r.stderr || r.reason || '')}</code>`);
    }
    db.upsertContainer({ bot_id: bot.id, container_name: r.containerName, image: tpl.image, status: 'running' });
    db.updateBot(bot.id, { status: 'active' });
    return send(userId,
      `✅ کانتینر راه‌اندازی شد و ربات <b>@${escapeHtml(bot.username)}</b> فعال است!\n\n` +
      `🐳 وضعیت کانتینر: <code>${r.containerName}</code>\n` +
      (bot.template_id === 'config_scraper'
        ? '➕ از پنل این ربات می‌توانید <b>کانال‌های منبع</b> را اضافه/حذف کنید.'
        : '🛒 ربات فروشگاه حالا به پنل شما وصل است.'));
  }

  // ------------------------------------------------------------------ wizards
  function startWizard(userId, bot) {
    const tpl = containerTemplates[bot.template_id];
    if (tpl.wizard === 'panel') {
      setState(userId, { s: 'cw:panel_type', botId: bot.id });
      const rows = tpl.panelTypes.map((t) => [{ text: t.toUpperCase(), callback_data: `cw:ptype:${bot.id}:${t}` }]);
      return send(userId, '🔌 <b>پنل مدیریت VPN شما</b> از کدام نوع است؟', { reply_markup: { inline_keyboard: rows } });
    }
    // telethon wizard — ToS/ban-risk disclosure FIRST, explicit acceptance required
    setState(userId, { s: 'cw:tos', botId: bot.id });
    return send(userId, tpl.tosRisk, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ متوجه‌ام، ادامه می‌دهم', callback_data: `cw:tosaccept:${bot.id}` }],
          [{ text: '❌ انصراف', callback_data: 'cancel_flow' }]
        ]
      }
    });
  }

  async function stepPanelType(userId, botId, type) {
    const tpl = containerTemplates.vpn_shop;
    if (!tpl.panelTypes.includes(type)) return;
    const bot = db.getBot(botId);
    if (!bot) return;
    db.updateBot(botId, { config: { ...bot.config, panel_type: type } });
    setState(userId, { s: 'cw:panel_url', botId });
    return send(userId, '🌐 <b>آدرس پایه پنل</b> را ارسال کنید (مثال: <code>https://panel.example.com</code>)');
  }

  async function stepPanelUrl(userId, botId, url) {
    const u = String(url).trim();
    if (!/^https?:\/\/.+\..+/.test(u)) {
      return send(userId, '❌ آدرس معتبر نیست. باید با http یا https شروع شود.');
    }
    const bot = db.getBot(botId);
    if (!bot) return;
    db.updateBot(botId, { config: { ...bot.config, panel_url: u } });
    setState(userId, { s: 'cw:panel_user', botId });
    return send(userId, '👤 <b>نام کاربری ادمین / کاربر API پنل</b> را ارسال کنید.');
  }

  async function stepPanelUser(userId, botId, user) {
    const bot = db.getBot(botId);
    if (!bot) return;
    db.updateBot(botId, { config: { ...bot.config, panel_user: String(user).trim() } });
    setState(userId, { s: 'cw:panel_pass', botId });
    return send(userId,
      '🔑 <b>رمز عبور / کلید API پنل</b> را ارسال کنید.\n' +
      '<i>🔒 رمزنگاری‌شده (AES-256-GCM) ذخیره می‌شود و هرگز متن ساده نگه داشته نمی‌شود.</i>');
  }

  async function stepPanelPass(userId, botId, pass) {
    const bot = db.getBot(botId);
    if (!bot) return;
    // AES-256-GCM, same scheme as bot tokens — plaintext never stored
    db.updateBot(botId, { config: { ...bot.config, panel_pass_enc: encrypt(String(pass).trim(), cfg.ENCRYPTION_KEY) } });
    clearState(userId);
    await send(userId, '⏳ در حال راه‌اندازی کانتینر اختصاصی ربات (PHP + MySQL)... چند لحظه صبر کنید.');
    return provisionBot(userId, db.getBot(botId));
  }

  // -------------------------------------------------- telethon login wizard
  async function stepPhone(userId, botId, phone) {
    const ph = String(phone).trim();
    if (!/^\+?\d{7,15}$/.test(ph)) {
      return send(userId, '❌ شماره معتبر نیست. با فرمت بین‌المللی بفرستید، مثال: <code>+98912xxxxxxx</code>');
    }
    const r = await telethon.startLogin(ph);
    if (!r.ok) {
      return send(userId, `❌ شروع لاگین ناموفق بود: <code>${escapeHtml(r.error || '')}</code>`);
    }
    setState(userId, { s: 'cw:otp', botId, loginKey: r.loginKey });
    return send(userId, `📨 کد تأیید تلگرام برای <code>${escapeHtml(ph)}</code> را ارسال کنید.`);
  }

  async function stepOtp(userId, code) {
    const st = state(userId);
    const botId = st.botId;
    const r = await telethon.submitCode(st.loginKey, String(code).trim());
    if (!r.ok) return send(userId, `❌ کد پذیرفته نشد: <code>${escapeHtml(r.error || '')}</code>`);
    if (r.need === 'password') {
      setState(userId, { s: 'cw:twofa', botId, loginKey: st.loginKey });
      return send(userId, '🔐 این اکانت <b>رمز دو مرحله‌ای</b> دارد. رمز دوم را ارسال کنید.');
    }
    return finishSession(userId, botId, r.session);
  }

  async function stepTwofa(userId, pass) {
    const st = state(userId);
    const r = await telethon.submitPassword(st.loginKey, String(pass));
    if (!r.ok) return send(userId, `❌ رمز دوم پذیرفته نشد: <code>${escapeHtml(r.error || '')}</code>`);
    return finishSession(userId, st.botId, r.session);
  }

  async function finishSession(userId, botId, session) {
    if (!session) return send(userId, '❌ سشن ساخته نشد. دوباره تلاش کنید.');
    const bot = db.getBot(botId);
    if (!bot) return;
    // session string AES-256-GCM encrypted at rest — same scheme as tokens
    db.updateBot(botId, { config: { ...bot.config, session_enc: encrypt(session, cfg.ENCRYPTION_KEY) } });
    setState(userId, { s: 'cw:dest', botId });
    return send(userId,
      '✅ سشن اکانت رصد ساخته و رمزنگاری شد.\n\n' +
      '📢 حالا <b>آیدی کانال مقصد</b> خودتان را ارسال کنید (کانالی که ربات ادمین آن است، مثال: <code>@my_configs</code>).');
  }

  async function stepDest(userId, dest) {
    const d = String(dest).trim();
    if (!/^@[A-Za-z0-9_]{4,64}$/.test(d) && !/^-\d{5,}$/.test(d)) {
      return send(userId, '❌ فرمت کانال معتبر نیست. مثال: <code>@my_configs</code>');
    }
    const st = state(userId);
    const bot = db.getBot(st.botId);
    if (!bot) return;
    db.updateBot(bot.id, { config: { ...bot.config, dest_channel: d } });
    clearState(userId);
    await send(userId, '⏳ در حال راه‌اندازی کانتینر اختصاصی اسکرپر (Python + Telethon)...');
    return provisionBot(userId, db.getBot(bot.id));
  }

  // ------------------------------------------------------------- state router
  /** Returns true when a cw:* state consumed the text. */
  async function handleStateText(userId, text) {
    const st = state(userId);
    if (!st || !String(st.s).startsWith('cw:')) return false;
    const botId = st.botId;
    switch (st.s) {
      case 'cw:panel_url': await stepPanelUrl(userId, botId, text); return true;
      case 'cw:panel_user': await stepPanelUser(userId, botId, text); return true;
      case 'cw:panel_pass': await stepPanelPass(userId, botId, text); return true;
      case 'cw:phone': await stepPhone(userId, botId, text); return true;
      case 'cw:otp': await stepOtp(userId, text); return true;
      case 'cw:twofa': await stepTwofa(userId, text); return true;
      case 'cw:dest': await stepDest(userId, text); return true;
      default: return false;
    }
  }

  /** Returns true when a cw:* callback was handled here. */
  async function handleCallback(userId, data, cbId) {
    if (!data.startsWith('cw:')) return false;
    const [, action, botId, arg] = data.split(':');

    if (action === 'ptype') { await stepPanelType(userId, botId, arg); return true; }
    if (action === 'tosaccept') {
      setState(userId, { s: 'cw:phone', botId });
      await send(userId, '📱 شماره موبایل <b>اکانت رصد</b> (شماره دوم خودتان) را با فرمت بین‌المللی ارسال کنید: <code>+98912xxxxxxx</code>');
      return true;
    }
    if (action === 'retryprovision') {
      const bot = db.getBot(botId);
      if (!bot) return true;
      await send(userId, '⏳ تلاش مجدد راه‌اندازی کانتینر...');
      await provisionBot(userId, bot);
      return true;
    }
    if (action === 'status' || action === 'restart') return panelAction(userId, action, botId, cbId);
    if (action === 'channels') return showChannels(userId, botId);
    if (action === 'addchannel') {
      setState(userId, { s: 'cw:addchannel', botId });
      await send(userId, '➕ آیدی کانال منبع را ارسال کنید (مثال: <code>@source_channel</code>). برای پایان، /done بفرستید.');
      return true;
    }
    if (action === 'rmchannel') {
      const bot = db.getBot(botId);
      const list = (bot.config.source_channels || []);
      const idx = Number(arg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) return true;
      list.splice(idx, 1);
      db.updateBot(botId, { config: { ...bot.config, source_channels: list } });
      await answerCallback(cbId, { text: 'کانال منبع حذف شد' });
      return showChannels(userId, botId);
    }
    return true; // unknown cw: callback swallowed here
  }

  // add-channel state lives here too
  async function handleAddChannel(userId, text) {
    const st = state(userId);
    if (!st || st.s !== 'cw:addchannel') return false;
    if (text.trim() === '/done') {
      clearState(userId);
      await send(userId, '✅ فهرست کانال‌های منبع ذخیره شد. اسکرپر به‌زودی آن‌ها را رصد می‌کند.');
      return true;
    }
    const ch = text.trim();
    if (!/^@[A-Za-z0-9_]{4,64}$/.test(ch) && !/^-\d{5,}$/.test(ch)) {
      await send(userId, '❌ فرمت کانال معتبر نیست: <code>@name</code>');
      return true;
    }
    const bot = db.getBot(st.botId);
    const list = bot.config.source_channels || [];
    if (!list.includes(ch)) {
      list.push(ch);
      db.updateBot(st.botId, { config: { ...bot.config, source_channels: list } });
    }
    await send(userId, `✅ <code>${escapeHtml(ch)}</code> اضافه شد. کانال بعدی یا /done:`);
    return true;
  }

  function showChannels(userId, botId) {
    const bot = db.getBot(botId);
    if (!bot) return;
    const list = bot.config.source_channels || [];
    const rows = list.map((ch, i) => ([{ text: `❌ ${ch}`, callback_data: `cw:rmchannel:${botId}:${i}` }]));
    rows.push([{ text: '➕ افزودن کانال منبع', callback_data: `cw:addchannel:${botId}` }]);
    rows.push([{ text: '🔙 بازگشت به پنل', callback_data: `openpanel:${botId}` }]);
    return send(userId,
      `📡 <b>کانال‌های منبع اسکرپر</b>\n\n${list.length ? list.map((c) => `• <code>${escapeHtml(c)}</code>`).join('\n') : '(خالی)'}`,
      { reply_markup: { inline_keyboard: rows } });
  }

  // ---------------------------------------------------------- per-bot panel
  function panelKeyboard(bot) {
    const rows = [];
    const c = db.getContainer(bot.id);
    rows.push([{ text: '🔄 تمدید فوری', callback_data: `botpanel:renew:${bot.id}` },
      { text: bot.auto_renew ? '🔁 خاموش کردن تمدید خودکار' : '🔁 روشن کردن تمدید خودکار', callback_data: `botpanel:autorenew:${bot.id}` }]);
    rows.push([{ text: `🐳 وضعیت کانتینر${c ? `: ${c.status}` : ''}`, callback_data: `cw:status:${bot.id}` },
      { text: '🔁 راه‌اندازی مجدد کانتینر', callback_data: `cw:restart:${bot.id}` }]);
    rows.push([{ text: bot.status === 'paused' ? '▶️ روشن کردن ربات' : '⏸ توقف دستی ربات', callback_data: `botpanel:pause:${bot.id}` }]);
    if (bot.status === 'failed_provision') {
      rows.push([{ text: '🚀 تلاش مجدد راه‌اندازی', callback_data: `cw:retryprovision:${bot.id}` }]);
    }
    if (bot.template_id === 'config_scraper') {
      rows.push([{ text: '📡 مدیریت کانال‌های منبع', callback_data: `cw:channels:${bot.id}` }]);
    }
    rows.push([{ text: '❌ حذف ربات', callback_data: `botpanel:deleteconfirm:${bot.id}` }]);
    rows.push([{ text: '🔙 بازگشت به لیست', callback_data: 'back:bots' }]);
    return { inline_keyboard: rows };
  }

  async function panelAction(userId, action, botId, cbId) {
    const bot = db.getBot(botId);
    if (!bot || String(bot.owner_id) !== String(userId)) return;
    switch (action) {
      case 'status': {
        const r = await provisioner.status(botId);
        const c = db.getContainer(botId);
        return send(userId,
          `🐳 کانتینر: <code>${escapeHtml(c ? c.container_name : '-')}</code>\n` +
          `وضعیت: <b>${r.ok ? escapeHtml(r.state) : '❓ پیدا نشد'}</b>`);
      }
      case 'restart': {
        const r = await provisioner.restart(botId);
        await answerCallback(cbId, { text: r.ok ? 'کانتینر ری‌استارت شد' : 'ری‌استارت ناموفق' });
        if (r.ok) db.updateContainer(botId, { status: 'restarted' });
        return send(userId, r.ok ? '🔁 کانتینر با موفقیت ری‌استارت شد.' : '❌ ری‌استارت کانتینر ناموفق بود.');
      }
      default: return false;
    }
  }

  /** Container start/stop for pause/resume of containerized bots. */
  async function setRunning(botId, running) {
    const r = running ? await provisioner.start(botId) : await provisioner.stop(botId);
    if (r.ok) db.updateContainer(botId, { status: running ? 'running' : 'stopped' });
    return r.ok;
  }

  /** Full teardown on bot deletion: container + data volume + registry row. */
  async function destroyInstance(botId) {
    await provisioner.destroy(botId);
    db.deleteContainer(botId);
  }

  return {
    planAllowed, refuseFree, startWizard, provisionBot,
    handleStateText, handleCallback, handleAddChannel,
    panelKeyboard, panelAction, setRunning, destroyInstance
  };
}

module.exports = { createContainerized };
