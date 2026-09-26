'use strict';

const crypto = require('crypto');
const { escapeHtml } = require('./utils/html');
const wallet = require('./wallet');
const lifecycle = require('./lifecycle');
const support = require('./support');
const customsource = require('./customsource');
const { createProvisioner } = require('./provisioner');
const { createContainerized } = require('./containerized');
const { createTelethonDriver } = require('./telethon');
const { encrypt, decrypt } = require('./cryptoutil');

/**
 * Control Bot: the single Telegram bot the end user talks to.
 * Persian UI, reply-keyboard main menu + inline "glass" keyboards.
 * Stateless handlers over an in-memory per-user flow state.
 */
function createControlBot(deps) {
  const { db, cfg, registry, apiFor, clock, notifier } = deps;
  const api = deps.controlApi; // TelegramApi for the control bot
  const states = new Map(); // userId -> { s, ...data }

  const isAdmin = (userId) => String(userId) === String(cfg.OWNER_TELEGRAM_ID);
  const fmt = (n) => Number(n).toLocaleString('fa-IR');

  // -------- containerized templates (§3.10-11): own gVisor container per bot
  const containerTemplates = registry.__containerTemplates || require('./templates/registry').containerTemplates;
  const provisioner = deps.provisioner || createProvisioner(deps.provisionerOpts || {});
  const telethon = deps.telethon || createTelethonDriver({ provisioner, cfg });
  const cont = createContainerized({
    db, cfg, send, states, escapeHtml, fmt, encrypt, decrypt,
    provisioner, containerTemplates, telethon, clock,
    answerCallback: (id, o) => api.answerCallbackQuery(id, o)
  });

  const mainMenuKeyboard = {
    keyboard: [
      [{ text: '➕ ساخت ربات جدید' }, { text: '📋 ربات‌های من' }],
      [{ text: '💰 کیف پول و شارژ' }, { text: '🎫 پشتیبانی و تیکت' }],
      [{ text: '🎁 دریافت دمو رایگان' }],
      [{ text: 'ℹ️ راهنما' }]
    ],
    resize_keyboard: true
  };
  function getMainMenu(userId) {
    const kb = { keyboard: mainMenuKeyboard.keyboard.map((r) => [...r]) };
    if (isAdmin(userId)) {
      kb.keyboard.push([{ text: '🧪 آزمایشگاه سورس سفارشی' }, { text: '👑 کنسول مدیریت' }]);
    }
    kb.resize_keyboard = true;
    return kb;
  }

  async function send(userId, text, opts = {}) {
    try {
      return await api.sendMessage(userId, text, { parse_mode: 'HTML', ...opts });
    } catch (_) { /* blocked bot */ }
  }

  function templateKeyboard(cbPrefix = 'tpl') {
    const rows = Object.values(registry).map((t) => ([{
      text: `🤖 ${t.name}`,
      callback_data: `${cbPrefix}:${t.id}`
    }]));
    // containerized templates (Pro/VIP only) get their own badge
    for (const t of Object.values(containerTemplates)) {
      rows.push([{ text: `🐳 ${t.name} — 👑 Pro/VIP`, callback_data: `${cbPrefix}:${t.id}` }]);
    }
    return { inline_keyboard: rows };
  }

  function planKeyboard(templateId, forUserId) {
    // containerized templates are Pro/VIP ONLY — free/demo never offered
    const paidOnly = !!containerTemplates[templateId];
    const plans = db.listPlans().filter((p) => {
      if (p.id !== 'free') return true;
      return !paidOnly && !db.hasUsedDemo(forUserId, templateId); // one demo per template type
    });
    return {
      inline_keyboard: plans.map((p) => ([{
        text: p.id === 'free' ? `🎁 ${p.name} — ۶۰ دقیقه` : `${p.id === 'vip' ? '👑' : '⭐'} ${p.name} — ${fmt(p.price)} تومان / ${p.duration_days} روز`,
        callback_data: `plan:${templateId}:${p.id}`
      }]))
    };
  }

  // ------------------------------------------------------------ bot creation
  async function createBotInstance(userId, templateId, planId) {
    const template = registry[templateId] || containerTemplates[templateId];
    const plan = db.getPlan(planId);
    if (!template || !plan) return { ok: false, reason: 'invalid_selection' };
    const user = db.upsertUser(userId);

    // containerized templates are Pro/VIP only — refuse forged free-plan callbacks
    if (containerTemplates[templateId] && !cont.planAllowed(planId)) {
      await cont.refuseFree(userId);
      return { ok: false, reason: 'paid_only' };
    }

    if (plan.id === 'free') {
      if (db.hasUsedDemo(userId, templateId)) return { ok: false, reason: 'demo_already_used' };
      db.markDemoUsed(userId, templateId);
    } else {
      const r = debitLater(db, userId, plan.price, templateId);
      if (!r.ok) return { ok: false, reason: 'insufficient_balance', shortfall: r.shortfall, plan };
    }

    const state = { s: 'create:token', templateId, planId };
    states.set(String(userId), state);
    const planLine = plan.id === 'free'
      ? 'پلن: <b>رایگان / دمو (۶۰ دقیقه)</b>'
      : `پلن: <b>${escapeHtml(plan.name)}</b> — ${fmt(plan.price)} تومان`;
    await send(userId,
      `🛠 قالب: <b>${escapeHtml(template.name)}</b>\n${planLine}\n\n` +
      `🔑 حالا <b>توکن ربات</b> را از @BotFather ارسال کنید.\n` +
      `⚠️ ربات باید جدید باشد و توکن در جای دیگری استفاده نشده باشد.`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'cancel_flow' }]] } });
    return { ok: true };
  }

  // charge at final creation success; helper resolves shortfall pre-check
  function debitLater(dbx, userId, price, templateId) {
    const bal = wallet.getBalance(dbx, userId);
    return bal >= price ? { ok: true } : { ok: false, shortfall: price - bal };
  }

  async function finishBotCreation(userId, token) {
    const state = states.get(String(userId));
    if (!state || state.s !== 'create:token') return;
    const { templateId, planId } = state;
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token.trim())) {
      return send(userId, '❌ فرمت توکن معتبر نیست. توکن را دقیقاً از @BotFather کپی کنید.');
    }
    let newApi = deps.makeApi(token.trim());
    let me;
    try {
      const r = await newApi.getMe();
      me = r.result;
    } catch (_) {
      return send(userId, '❌ توکن نامعتبر است (getMe ناموفق). یک توکن معتبر از @BotFather بفرستید.');
    }

    const plan = db.getPlan(planId);
    // enforce per-plan bot limit
    const userPlan = db.getPlan(db.getUser(userId).plan_id || plan.id) || plan;
    const maxBots = plan.id !== 'free' ? plan.max_bots : (userPlan.max_bots || 1);
    const activeBots = db.listBotsByOwner(userId).filter((b) => b.plan_id !== 'free');
    if (plan.id !== 'free' && activeBots.length >= plan.max_bots) {
      states.delete(String(userId));
      return send(userId, `❌ سقف ربات‌های پلن <b>${escapeHtml(plan.name)}</b> (${plan.max_bots} ربات) پر است.`);
    }

    // charge wallet for paid plans now that creation will succeed
    if (plan.price > 0) {
      const r = wallet.debit(db, userId, plan.price, 'purchase', `ساخت ربات ${templateId} روی پلن ${plan.name}`);
      if (!r.ok) {
        states.delete(String(userId));
        return send(userId, `❌ موجودی کافی نیست. کمبود: <b>${fmt(r.shortfall)}</b> تومان`, {
          reply_markup: { inline_keyboard: [[{ text: '💰 شارژ کیف پول', callback_data: 'wallet:topup' }]] }
        });
      }
    }

    const botId = `bot_${crypto.randomBytes(6).toString('hex')}`;
    const secret = crypto.randomBytes(24).toString('hex');
    const now = clock.now();
    const expires = plan.duration_days > 0 ? now + plan.duration_days * 86400000 : null;

    // ---- containerized template (§3.10-11): own gVisor container, no platform webhook
    if (containerTemplates[templateId]) {
      db.createBot({
        id: botId, owner_id: userId,
        token_encrypted: encrypt(token.trim(), cfg.ENCRYPTION_KEY),
        secret_token: secret, username: me.username, template_id: templateId, plan_id: planId,
        status: 'provisioning', config: { containerized: true },
        expires_at: expires
      });
      states.delete(String(userId));
      await send(userId,
        `🐳 ربات <b>@${escapeHtml(me.username)}</b> ثبت شد (قالب کانتینری). حالا اطلاعات راه‌اندازی را جمع می‌کنیم:`,
        { reply_markup: getMainMenu(userId) });
      return cont.startWizard(userId, db.getBot(botId));
    }

    db.createBot({
      id: botId, owner_id: userId,
      token_encrypted: encrypt(token.trim(), cfg.ENCRYPTION_KEY),
      secret_token: secret, username: me.username, template_id: templateId, plan_id: planId,
      status: 'active', config: plan.id === 'free' ? { demo: true, warned: false } : {},
      expires_at: expires
    });
    if (plan.id !== 'free' && plan.max_bots >= (db.getPlan(db.getUser(userId).plan_id)?.max_bots || 0)) {
      db.upsertUser(userId, {});
    }
    // register webhook
    const botApi = deps.makeApi(token.trim());
    let webhookOk = true;
    try {
      await botApi.setWebhook(`${cfg.PUBLIC_URL}/webhook/${secret}`, secret);
    } catch (_) { webhookOk = false; }
    states.delete(String(userId));

    const demoNote = plan.id === 'free'
      ? '\n\n🎁 این ربات <b>۶۰ دقیقه دمو</b> فعال دارد. در دقیقه ۵۰ هشدار دریافت می‌کنید و بعد از آن ۵ ساعت فرصت ارتقا دارید.\n⚠️ دمو برای هر نوع قالب فقط <b>یک بار</b> قابل استفاده است.'
      : `\n⏳ اعتبار: ${plan.duration_days} روز`;
    await send(userId,
      `✅ ربات <b>@${escapeHtml(me.username)}</b> ساخته و فعال شد!\n\n🛠 قالب: ${escapeHtml(registry[templateId].name)}\n🌐 وب‌هوک: ${webhookOk ? '✅ ثبت شد' : '⚠️ ناموفق (از پنل «ثبت مجدد وب‌هوک» بزنید)'}${demoNote}`,
      { reply_markup: getMainMenu(userId) });
  }

  // ------------------------------------------------------------ per-bot panel
  function panelKeyboard(bot) {
    const rows = [];
    rows.push([{ text: '🔄 تمدید فوری', callback_data: `botpanel:renew:${bot.id}` },
      { text: bot.auto_renew ? '🔁 خاموش کردن تمدید خودکار' : '🔁 روشن کردن تمدید خودکار', callback_data: `botpanel:autorenew:${bot.id}` }]);
    rows.push([{ text: '🌐 ثبت مجدد وب‌هوک', callback_data: `botpanel:resetwebhook:${bot.id}` },
      { text: '🔧 تغییر توکن', callback_data: `botpanel:changetoken:${bot.id}` }]);
    rows.push([{ text: '🩺 بررسی سلامت و عیب‌یابی', callback_data: `botpanel:health:${bot.id}` }]);
    rows.push([{ text: '🗑 پاک‌سازی داده‌های ربات', callback_data: `botpanel:wipeconfirm:${bot.id}` }]);
    rows.push([{ text: bot.status === 'paused' ? '▶️ روشن کردن ربات' : '⏸ توقف دستی ربات', callback_data: `botpanel:pause:${bot.id}` }]);
    if (bot.plan_id === 'free' || bot.status === 'grace') {
      rows.push([{ text: '🚀 ارتقا به پلن پرداختی', callback_data: `botpanel:upgrade:${bot.id}` }]);
    }
    rows.push([{ text: '❌ حذف ربات', callback_data: `botpanel:deleteconfirm:${bot.id}` }]);
    rows.push([{ text: '🔙 بازگشت به لیست', callback_data: 'back:bots' }]);
    return { inline_keyboard: rows };
  }

  async function showBotPanel(userId, botId) {
    const bot = db.getBot(botId);
    if (!bot || String(bot.owner_id) !== String(userId)) return;
    const plan = db.getPlan(bot.plan_id);
    const statusMap = { active: '🟢 فعال', paused: '⏸ متوقف', grace: '🟠 در مهلت ارتقا', deleted: '❌ حذف شده' };
    let extra = '';
    if (bot.plan_id === 'free' && bot.status !== 'grace') {
      const leftMin = Math.max(0, 60 - Math.floor((clock.now() - bot.created_at) / 60000));
      extra = `\n⏳ دقایق باقی‌مانده دمو: <b>${leftMin}</b>`;
    } else if (bot.status === 'grace') {
      const leftMin = Math.max(0, 300 - Math.floor((clock.now() - (bot.config.grace_start || 0)) / 60000));
      extra = `\n⏳ دقایق باقی‌مانده مهلت: <b>${leftMin}</b> (بعد از آن حذف دائمی)`;
    } else if (bot.expires_at) {
      const days = Math.max(0, Math.ceil((bot.expires_at - clock.now()) / 86400000));
      extra = `\n⏳ روزهای باقی‌مانده: <b>${days}</b>`;
    }
    await send(userId,
      `🤖 <b>@${escapeHtml(bot.username || bot.id)}</b>\n\n` +
      `قالب: ${escapeHtml(registry[bot.template_id]?.name || bot.template_id)}\n` +
      `پلن: ${escapeHtml(plan?.name || bot.plan_id)}\n` +
      `وضعیت: ${statusMap[bot.status] || bot.status}\n` +
      `تمدید خودکار: ${bot.auto_renew ? '✅ روشن' : '⛔️ خاموش'}${extra}`,
      { reply_markup: bot.config.containerized ? cont.panelKeyboard(bot) : panelKeyboard(bot) });
  }

  async function botPanelAction(userId, action, botId) {
    const bot = db.getBot(botId);
    if (!bot || String(bot.owner_id) !== String(userId)) return;
    const botApi = apiFor(bot);

    switch (action) {
      case 'renew': {
        if (bot.plan_id === 'free') {
          return send(userId, '⚠️ ربات دمو قابل تمدید نیست؛ ابتدا به پلن پرداختی ارتقا دهید.');
        }
        const plan = db.getPlan(bot.plan_id);
        const r = wallet.debit(db, userId, plan.price, 'renew', `تمدید دستی ربات ${bot.id}`);
        if (!r.ok) {
          return send(userId, `❌ موجودی کافی نیست. کمبود: <b>${fmt(r.shortfall)}</b> تومان`,
            { reply_markup: { inline_keyboard: [[{ text: '💰 شارژ کیف پول', callback_data: 'wallet:topup' }]] } });
        }
        db.updateBot(bot.id, { expires_at: clock.now() + plan.duration_days * 86400000, status: 'active' });
        if (!bot.config.containerized) {
          try { await botApi.setWebhook(`${cfg.PUBLIC_URL}/webhook/${bot.secret_token}`, bot.secret_token); } catch (_) { }
        }
        await send(userId, `✅ ربات @${escapeHtml(bot.username)} برای ${plan.duration_days} روز تمدید شد.`);
        return showBotPanel(userId, botId);
      }
      case 'autorenew': {
        db.updateBot(bot.id, { auto_renew: !bot.auto_renew });
        await send(userId, `✅ تمدید خودکار ${!bot.auto_renew ? 'روشن' : 'خاموش'} شد.`);
        return showBotPanel(userId, botId);
      }
      case 'resetwebhook': {
        if (bot.config.containerized) return send(userId, 'ℹ️ ربات‌های کانتینری از وب‌هوک پلتفرم استفاده نمی‌کنند.');
        try {
          await botApi.setWebhook(`${cfg.PUBLIC_URL}/webhook/${bot.secret_token}`, bot.secret_token);
          await send(userId, '✅ وب‌هوک با موفقیت مجدداً ثبت شد.');
        } catch (_) { await send(userId, '❌ ثبت وب‌هوک ناموفق بود؛ توکن معتبر است؟ (تغییر توکن را امتحان کنید)'); }
        return showBotPanel(userId, botId);
      }
      case 'changetoken': {
        if (bot.config.containerized) return send(userId, 'ℹ️ برای تغییر توکن ربات کانتینری، ربات را حذف و دوباره بسازید.');
        states.set(String(userId), { s: 'panel:changetoken', botId });
        return send(userId, '🔑 توکن جدید را از @BotFather ارسال کنید (یا /cancel برای انصراف):');
      }
      case 'health': {
        if (bot.config.containerized) {
          const c = db.getContainer(bot.id);
          const r = await provisioner.status(bot.id);
          return send(userId,
            `<b>🩺 گزارش سلامت ربات کانتینری @${escapeHtml(bot.username || '')}</b>\n\n` +
            `🐳 کانتینر: <code>${escapeHtml(c ? c.container_name : '-')}</code>\n` +
            `وضعیت: <b>${r.ok ? escapeHtml(r.state) : '❓ کانتینر پیدا نشد'}</b>\n` +
            `🛠 قالب: ${escapeHtml((containerTemplates[bot.template_id] || {}).name || bot.template_id)}\n` +
            `📊 وضعیت ربات: ${bot.status} | پلن: ${bot.plan_id}`);
        }
        const report = [];
        let tokenOk = false;
        try { const me = await botApi.getMe(); tokenOk = true; report.push(`✅ توکن معتبر — @${escapeHtml(me.result.username)}`); }
        catch (_) { report.push('❌ توکن نامعتبر یا منقضی شده است'); }
        if (tokenOk) {
          let whOk = false;
          try { const w = await botApi.call('getWebhookInfo'); whOk = !!(w.result && w.result.url); } catch (_) { }
          report.push(whOk ? '✅ وب‌هوک تنظیم است' : '⚠️ وب‌هوک تنظیم نیست — «ثبت مجدد وب‌هوک» را بزنید');
        }
        report.push(`📊 وضعیت: ${bot.status} | پلن: ${bot.plan_id}`);
        await send(userId, `<b>🩺 گزارش سلامت ربات @${escapeHtml(bot.username || '')}</b>\n\n${report.join('\n')}`);
        return;
      }
      case 'wipeconfirm':
        return send(userId, '⚠️ همه داده‌های این ربات (بلاک کانفیگ‌ها/فایل‌ها) حذف می‌شود؛ خودِ ربات باقی می‌ماند. مطمئنید؟',
          { reply_markup: { inline_keyboard: [[{ text: '✅ بله، پاک کن', callback_data: `botpanel:wipe:${bot.id}` }, { text: '❌ انصراف', callback_data: `botpanel:back:${bot.id}` }]] } });
      case 'wipe': {
        db.wipeBotData(botId);
        await send(userId, '✅ داده‌های ربات پاک‌سازی شد (ثبت ربات دست‌نخورده ماند).');
        return showBotPanel(userId, botId);
      }
      case 'pause': {
        if (bot.config.containerized) {
          const resume = bot.status === 'paused';
          db.updateBot(bot.id, { status: resume ? 'active' : 'paused' });
          const ok = await cont.setRunning(bot.id, resume);
          await send(userId, resume
            ? (ok ? '▶️ کانتینر ربات دوباره راه‌اندازی شد.' : '⚠️ وضعیت ربات فعال شد اما استارت کانتینر ناموفق بود.')
            : (ok ? '⏸ کانتینر ربات متوقف شد (داده‌ها سالم است).' : '⚠️ وضعیت ربات متوقف شد اما توقف کانتینر ناموفق بود.'));
          return showBotPanel(userId, botId);
        }
        if (bot.status === 'paused') {
          db.updateBot(bot.id, { status: 'active' });
          try { await botApi.setWebhook(`${cfg.PUBLIC_URL}/webhook/${bot.secret_token}`, bot.secret_token); } catch (_) { }
          await send(userId, '▶️ ربات دوباره فعال شد.');
        } else {
          db.updateBot(bot.id, { status: 'paused' });
          try { await botApi.deleteWebhook(); } catch (_) { }
          await send(userId, '⏸ ربات به‌صورت دستی متوقف شد (وب‌هوک حذف شد؛ داده‌ها سالم است).');
        }
        return showBotPanel(userId, botId);
      }
      case 'upgrade': {
        states.set(String(userId), { s: 'upgrade:plan', botId });
        const plans = db.listPlans().filter((p) => p.id !== 'free');
        return send(userId, 'پلن پرداختی مورد نظر را انتخاب کنید:',
          { reply_markup: { inline_keyboard: plans.map((p) => ([{ text: `${p.id === 'vip' ? '👑' : '⭐'} ${p.name} — ${fmt(p.price)} ت`, callback_data: `upgrade:${bot.id}:${p.id}` }])) } });
      }
      case 'deleteconfirm':
        return send(userId, '❌ ربات به همراه تمام داده‌هایش حذف می‌شود و بازگشت ندارد. مطمئنید؟',
          { reply_markup: { inline_keyboard: [[{ text: '✅ بله، حذف کن', callback_data: `botpanel:delete:${bot.id}` }, { text: '❌ انصراف', callback_data: `botpanel:back:${bot.id}` }]] } });
      case 'delete': {
        if (bot.config.containerized) {
          // full teardown: container + its data volume + container registry row
          await cont.destroyInstance(botId);
        }
        try { await botApi.deleteWebhook(); } catch (_) { }
        db.updateBot(botId, { status: 'deleted' });
        db.deleteBot(botId);
        await send(userId, '✅ ربات حذف شد.');
        return listBots(userId);
      }
      case 'back':
        return showBotPanel(userId, botId);
    }
  }

  async function listBots(userId) {
    const bots = db.listBotsByOwner(userId);
    if (!bots.length) {
      return send(userId, 'هنوز رباتی نساخته‌اید. از «➕ ساخت ربات جدید» شروع کنید.', { reply_markup: getMainMenu(userId) });
    }
    const kb = bots.map((b) => ([{ text: `🤖 @${b.username || b.id} — ${b.status}`, callback_data: `openpanel:${b.id}` }]));
    return send(userId, '<b>📋 ربات‌های شما:</b>', {
      reply_markup: { inline_keyboard: [...kb, [{ text: '🔙 منوی اصلی', callback_data: 'back:menu' }]] }
    });
  }

  // ------------------------------------------------------------ wallet & support
  async function walletMenu(userId) {
    const bal = wallet.getBalance(db, userId);
    const txs = db.listTransactions(userId).slice(0, 5);
    const txLines = txs.map((t) => `• ${t.type === 'topup' ? '➕' : '➖'} ${fmt(Math.abs(t.amount))} ت — ${escapeHtml(t.type)}`);
    await send(userId,
      `💰 <b>کیف پول شما</b>\n\nموجودی: <b>${fmt(bal)}</b> تومان\n\n<b>آخرین تراکنش‌ها:</b>\n${txLines.join('\n') || '—'}\n\nپلن‌ها و تمدیدها از موجودی کیف پول کسر می‌شوند.`,
      { reply_markup: { inline_keyboard: [[{ text: '➕ درخواست شارژ کیف پول', callback_data: 'wallet:topup' }], [{ text: '🔙 منوی اصلی', callback_data: 'back:menu' }]] } });
  }

  async function supportMenu(userId) {
    await send(userId,
      `🎫 <b>پشتیبانی</b>\n\nقبل از ثبت تیکت، شاید پاسخ سؤال شما این‌جا باشد:\n\n${support.faqText()}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ حل شد، ممنون', callback_data: 'support:solved' }, { text: '❌ هنوز کمک می‌خواهم', callback_data: 'support:ticket' }],
            [{ text: '🔙 منوی اصلی', callback_data: 'back:menu' }]
          ]
        }
      });
  }

  // ------------------------------------------------------------ custom source lab
  async function customSourceLab(userId) {
    const gate = customsource.checkPaymentGate(db, userId, cfg);
    if (!gate.ok) {
      if (gate.reason === 'insufficient_balance') {
        return send(userId, `🧪 <b>آزمایشگاه سورس سفارشی</b>\n\nبرای استفاده باید پلن پرداختی فعال و موجودی کافی (مبلغ سرویس: <b>${fmt(cfg.CUSTOM_SOURCE_PRICE)}</b> تومان) داشته باشید.\nکمبود موجودی: <b>${fmt(gate.shortfall)}</b> تومان`,
          { reply_markup: { inline_keyboard: [[{ text: '💰 شارژ کیف پول', callback_data: 'wallet:topup' }], [{ text: '🔙 منوی اصلی', callback_data: 'back:menu' }]] } });
      }
      return send(userId, '🧪 برای استفاده از سرویس سورس سفارشی باید یک ربات روی پلن پرداختی داشته باشید.');
    }
    states.set(String(userId), { s: 'custom:await_zip' });
    return send(userId,
      `🧪 <b>آزمایشگاه سورس سفارشی</b>\n\nپروژه خود (Node.js یا Python) را به‌صورت <b>ZIP</b> ارسال کنید.\nترتیب بررسی: اعتبارسنجی ساختار ← اسکن امنیتی ← اسکن باگ ← تأیید نهایی ادمین.\n\nمبلغ سرویس: <b>${fmt(cfg.CUSTOM_SOURCE_PRICE)}</b> تومان (پس از تصویب نهایی کسر می‌شود)`,
      { reply_markup: { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'cancel_flow' }]] } });
  }

  async function handleCustomZip(userId, document, fileBuffer) {
    const state = states.get(String(userId));
    if (!state || state.s !== 'custom:await_zip') return;
    if (!/\.zip$/i.test(document.file_name || '')) {
      return send(userId, '⚠️ فقط فایل ZIP پذیرفته می‌شود. لطفاً پروژه را زیپ کنید و ارسال کنید.');
    }
    if (fileBuffer && fileBuffer.length > customsource.LIMITS.maxZipBytes) {
      return send(userId, `❌ حجم ZIP بیش از حد مجاز (${customsource.LIMITS.maxZipBytes / 1024 / 1024} مگابایت) است.`);
    }
    state.s = 'custom:await_description';
    state.zip = { name: document.file_name, size: document.file_size || (fileBuffer ? fileBuffer.length : 0), buffer: fileBuffer };
    return send(userId, '📝 توضیح پروژه خود را بنویسید (این متن برای بررسی به ادمین ارسال می‌شود):');
  }

  async function handleCustomDescription(userId, text) {
    const state = states.get(String(userId));
    if (!state || state.s !== 'custom:await_description' || !state.zip) return;
    states.delete(String(userId));
    const projectId = customsource.newProjectId();
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(cfg.CUSTOM_SOURCES_DIR, projectId);
    let extracted = { files: [], manifest: null, runtime: null, startCommand: null, totalBytes: 0 };

    // extract & structure-validate (production: unzip; sandboxed here)
    try {
      fs.mkdirSync(dir, { recursive: true });
      const zipPath = path.join(dir, 'upload.zip');
      if (state.zip.buffer) fs.writeFileSync(zipPath, state.zip.buffer);
      if (fs.existsSync(zipPath)) {
        const { execFile } = require('child_process');
        await new Promise((resolve, reject) => execFile('unzip', ['-q', '-o', zipPath, '-d', dir], (e) => (e ? reject(e) : resolve())));
        const walk = (d) => {
          const out = [];
          for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, f.name);
            if (f.isDirectory()) out.push(...walk(p));
            else {
              const content = fs.readFileSync(p, 'utf8').catch ? '' : fs.readFileSync(p, 'utf8');
              out.push({ name: path.relative(dir, p), content, bytes: fs.statSync(p).size });
            }
          }
          return out;
        };
        const all = walk(dir);
        extracted.files = all.map((f) => ({ name: f.name, content: f.content }));
        extracted.totalBytes = all.reduce((s, f) => s + f.bytes, 0);
        const mf = all.find((f) => f.name === 'manifest.json');
        if (mf) {
          extracted.manifest = JSON.parse(mf.content);
          extracted.runtime = extracted.manifest.runtime;
          extracted.startCommand = extracted.manifest.start;
        }
      }
    } catch (_) { /* extraction failure handled by validation below */ }

    // 1) structure validation
    const v = await customsource.validateStructure({
      runtime: extracted.runtime, startCommand: extracted.startCommand,
      files: extracted.files.map((f) => ({ name: f.name })),
      totalBytes: extracted.totalBytes,
      zipBytes: state.zip.size || 1
    });
    if (!v.ok) {
      db.createCustomProject({ id: projectId, owner_id: userId, runtime: extracted.runtime, status: 'rejected', report: { stage: 'structure', problems: v.problems } });
      return send(userId, `❌ <b>اعتبارسنجی ساختار ناموفق بود:</b>\n\n${v.problems.map((p) => `• ${escapeHtml(p)}`).join('\n')}\n\nلطفاً اصلاح کنید و دوباره ارسال کنید (resubmit خودتان).`,
        { reply_markup: { inline_keyboard: [[{ text: '🧪 ارسال مجدد', callback_data: 'custom:start' }], [{ text: '🔙 منوی اصلی', callback_data: 'back:menu' }]] } });
    }

    // 2+3) security scan then bug scan (strict order), AI passes injectable
    const review = await customsource.runReviewPipeline(
      {},
      { files: extracted.files, manifest: extracted.manifest }
    );
    if (!review.ok) {
      const stageLabel = { security: 'اسکن امنیتی', ai_security: 'بازبینی امنیتی هوشمند', bug: 'اسکن باگ' }[review.stage];
      db.createCustomProject({ id: projectId, owner_id: userId, runtime: extracted.runtime, startCommand: extracted.startCommand, status: 'rejected', report: review.report });
      const findings = (review.report.security?.findings || []).map((f) => `• <code>${escapeHtml(f.file)}</code>: ${escapeHtml(f.finding)}`).join('\n');
      return send(userId,
        `❌ <b>${stageLabel} ناموفق بود.</b>\n\n${findings || 'جزئیات در گزارش ثبت شد.'}\n\nلطفاً مشکلات را خودتان اصلاح و دوباره ارسال کنید.\n\n💡 در صورت تمایل، «تلاش اصلاح خودکار با AI» به‌صورت سرویس <b>پرداختی جداگانه</b> (غیرقابل بازگشت، بدون تضمین موفقیت) ارائه می‌شود.`,
        { reply_markup: { inline_keyboard: [[{ text: '🧪 ارسال مجدد', callback_data: 'custom:start' }], [{ text: '🔙 منوی اصلی', callback_data: 'back:menu' }]] } });
    }

    // 4) consolidated report to platform owner for final human approval
    db.createCustomProject({
      id: projectId, owner_id: userId, runtime: extracted.runtime, startCommand: extracted.startCommand,
      status: 'pending_review', report: review.report
    });
    const ownerReport =
      `🧪 <b>پروژه سورس سفارشی جدید</b>\n\n` +
      `شناسه: <code>${projectId}</code>\nکاربر: <code>${userId}</code>\n` +
      `ران‌تایم: <code>${escapeHtml(extracted.runtime)}</code>\nstart: <code>${escapeHtml(extracted.startCommand || '')}</code>\n` +
      `توضیح کاربر: ${escapeHtml(text)}\n\n` +
      `✅ ساختار — ✅ اسکن امنیتی — ✅ اسکن باگ`;
    await send(cfg.OWNER_TELEGRAM_ID, ownerReport, {
      reply_markup: { inline_keyboard: [[
        { text: '✅ تأیید و اجرا', callback_data: `custom:approve:${projectId}` },
        { text: '❌ رد', callback_data: `custom:reject:${projectId}` }
      ]] }
    });
    return send(userId, '✅ پروژه شما هر سه مرحله خودکار بررسی را گذراند و در انتظار تأیید نهایی ادمین است.');
  }

  // ------------------------------------------------------------ admin console
  async function adminConsole(userId) {
    if (!isAdmin(userId)) return;
    const s = db.stats();
    await send(userId,
      `👑 <b>کنسول مدیریت</b>\n\n👥 کاربران: <b>${s.users}</b>\n🤖 ربات‌ها: <b>${s.bots}</b>\n💵 درآمد: <b>${fmt(s.revenue)}</b> تومان\n🎫 تیکت‌های باز: <b>${s.openTickets}</b>`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎫 تیکت‌های باز', callback_data: 'admin:tickets' }, { text: '💳 تراکنش‌ها', callback_data: 'admin:transactions' }],
            [{ text: '🧰 شارژهای در انتظار', callback_data: 'admin:topups' }],
            [{ text: '🧪 پروژه‌های سفارشی', callback_data: 'admin:projects' }],
            [{ text: '🔙 منوی اصلی', callback_data: 'back:menu' }]
          ]
        }
      });
  }

  async function adminSection(userId, section) {
    if (!isAdmin(userId)) return;
    if (section === 'tickets') {
      const tickets = db.listTickets('open');
      if (!tickets.length) return send(userId, 'تیکت بازی وجود ندارد.');
      return send(userId, '<b>🎫 تیکت‌های باز:</b>', {
        reply_markup: {
          inline_keyboard: tickets.slice(0, 15).map((t) => ([{ text: `#${t.id} — ${t.subject.slice(0, 40)}`, callback_data: `admin:ticket:${t.id}` }]))
        }
      });
    }
    if (section === 'topups') {
      const txs = db.listAllTransactions().filter((t) => t.type === 'topup_pending');
      if (!txs.length) return send(userId, 'درخواست شارژی در انتظار نیست.');
      return send(userId, '<b>🧰 درخواست‌های شارژ در انتظار تأیید:</b>', {
        reply_markup: {
          inline_keyboard: txs.map((t) => ([
            { text: `➕ ${t.user_id} — ${fmt(t.amount)} ت`, callback_data: `admin:approve_topup:${t.id}` },
            { text: '❌', callback_data: `admin:reject_topup:${t.id}` }
          ]))
        }
      });
    }
    if (section === 'transactions') {
      const txs = db.listAllTransactions().slice(0, 20);
      return send(userId, '<b>💳 آخرین تراکنش‌ها:</b>\n' + txs.map((t) => `• <code>${t.user_id}</code> ${t.type} ${fmt(t.amount)}`).join('\n'));
    }
    if (section === 'projects') {
      const projects = db.listCustomProjects();
      const pending = projects.filter((p) => p.status === 'pending_review');
      if (!pending.length) return send(userId, 'پروژه‌ای در انتظار بررسی نیست.');
      return send(userId, '<b>🧪 پروژه‌های در انتظار تأیید نهایی:</b>', {
        reply_markup: {
          inline_keyboard: pending.map((p) => ([{ text: `${p.id} (${p.runtime})`, callback_data: `admin:project:${p.id}` }]))
        }
      });
    }
  }

  // ------------------------------------------------------------ update router
  async function processUpdate(update) {
    const msg = update.message;
    const cb = update.callback_query;

    if (cb) {
      const userId = cb.from.id;
      const data = cb.data || '';
      const chatId = cb.message?.chat?.id;
      db.upsertUser(userId);

      if (data.startsWith('admin:approve_topup:')) {
        if (!isAdmin(userId)) return api.answerCallbackQuery(cb.id, { text: '⛔️ دسترسی مجاز نیست.', show_alert: true });
        const txId = data.split(':')[2];
        const txs = db.listAllTransactions().find((t) => String(t.id) === String(txId) && t.type === 'topup_pending');
        if (!txs) return api.answerCallbackQuery(cb.id, { text: 'تراکنش یافت نشد', show_alert: true });
        await api.answerCallbackQuery(cb.id, { text: '✅ تأیید شد' });
        wallet.credit(db, txs.user_id, txs.amount, 'topup', 'تأیید شارژ توسط ادمین');
        // remove pending marker
        db.raw.prepare(`UPDATE wallet_transactions SET type='topup_approved' WHERE id=?`).run(txId);
        await send(txs.user_id, `✅ شارژ کیف پول شما به مبلغ <b>${fmt(txs.amount)}</b> تومان تأیید و اعمال شد.`);
        return adminSection(cfg.OWNER_TELEGRAM_ID, 'topups');
      }
      if (data.startsWith('admin:reject_topup:')) {
        if (!isAdmin(userId)) return api.answerCallbackQuery(cb.id, { text: '⛔️ دسترسی مجاز نیست.', show_alert: true });
        const txId = data.split(':')[2];
        db.raw.prepare(`UPDATE wallet_transactions SET type='topup_rejected' WHERE id=? AND type='topup_pending'`).run(txId);
        await api.answerCallbackQuery(cb.id, { text: 'رد شد' });
        return adminSection(cfg.OWNER_TELEGRAM_ID, 'topups');
      }

      if (data.startsWith('cw:')) return cont.handleCallback(userId, data, cb.id);
      if (data.startsWith('tpl:')) return beginCreate(userId, data.split(':')[1]);
      if (data.startsWith('plan:')) {
        const [, templateId, planId] = data.split(':');
        return beginCreateWithPlan(userId, templateId, planId);
      }
      if (data.startsWith('upgrade:')) {
        const [, botId, planId] = data.split(':');
        const r = await lifecycle.upgradeDemoBot(db, { apiFor, publicUrl: cfg.PUBLIC_URL }, { botId, userId, planId, now: clock.now() });
        if (r.ok) { states.delete(String(userId)); await send(userId, '🎉 ارتقا انجام شد و ربات فعال است.'); return showBotPanel(userId, botId); }
        return send(userId, `❌ موجودی کافی نیست. کمبود: <b>${fmt(r.shortfall)}</b> تومان`,
          { reply_markup: { inline_keyboard: [[{ text: '💰 شارژ کیف پول', callback_data: 'wallet:topup' }]] } });
      }
      if (data.startsWith('botpanel:')) {
        // action routing: botpanel:<action>:<botId>
        const [, action, botId] = data.split(':');
        return botPanelAction(userId, action, botId);
      }
      if (data.startsWith('openpanel:')) {
        return showBotPanel(userId, data.split(':')[1]);
      }
      if (data.startsWith('custom:approve:')) {
        if (!isAdmin(userId)) return api.answerCallbackQuery(cb.id, { text: '⛔️ فقط مالک پلتفرم.', show_alert: true });
        const projectId = data.split(':')[2];
        return approveCustomProject(userId, projectId, cb.id);
      }
      if (data.startsWith('custom:reject:')) {
        if (!isAdmin(userId)) return api.answerCallbackQuery(cb.id, { text: '⛔️ فقط مالک پلتفرم.', show_alert: true });
        const projectId = data.split(':')[2];
        db.updateCustomProject(projectId, { status: 'rejected' });
        const p = db.getCustomProject(projectId);
        await api.answerCallbackQuery(cb.id, { text: 'رد شد' });
        await send(p.owner_id, '❌ پروژه سفارشی شما توسط ادمین رد شد. پس از اصلاح مجدداً ارسال کنید.');
        return;
      }
      if (data === 'custom:start') return customSourceLab(userId);
      if (data.startsWith('admin:ticket:')) {
        if (!isAdmin(userId)) return;
        const id = data.split(':')[2];
        const t = db.getTicket(id);
        if (!t) return api.answerCallbackQuery(cb.id, { text: 'یافت نشد', show_alert: true });
        await api.answerCallbackQuery(cb.id);
        const msgs = t.messages.map((m) => `• <b>${m.sender_role === 'admin' ? '👑 ادمین' : '👤 کاربر'}:</b> ${escapeHtml(m.message)}`).join('\n');
        return send(userId, `<b>🎫 تیکت #${t.id} — ${escapeHtml(t.subject)}</b>\nکاربر: <code>${t.user_id}</code>\n\n${msgs}`, {
          reply_markup: { inline_keyboard: [[{ text: '💬 پاسخ', callback_data: `admin:ticketreply:${t.id}` }, { text: '✅ بستن', callback_data: `admin:ticketclose:${t.id}` }]] }
        });
      }
      if (data.startsWith('admin:ticketreply:')) {
        states.set(String(userId), { s: 'admin:ticketreply', ticketId: data.split(':')[2] });
        await api.answerCallbackQuery(cb.id);
        return send(userId, '✍️ متن پاسخ را بفرستید:');
      }
      if (data.startsWith('admin:ticketclose:')) {
        const id = data.split(':')[2];
        db.setTicketStatus(id, 'closed');
        const t = db.getTicket(id);
        await api.answerCallbackQuery(cb.id, { text: 'بسته شد' });
        if (t) await send(t.user_id, `✅ تیکت #${t.id} شما بسته شد.`);
        return adminSection(userId, 'tickets');
      }
      if (data.startsWith('admin:')) {
        if (data === 'admin:tickets' || data === 'admin:topups' || data === 'admin:transactions' || data === 'admin:projects') {
          await api.answerCallbackQuery(cb.id);
          return adminSection(userId, data.split(':')[1]);
        }
      }
      if (data === 'wallet:topup') {
        await api.answerCallbackQuery(cb.id);
        states.set(String(userId), { s: 'wallet:await_amount' });
        return send(userId, '💵 مبلغ شارژ (تومان) را وارد کنید:');
      }
      if (data === 'support:solved') {
        await api.answerCallbackQuery(cb.id, { text: 'خوشحال که حل شد! 🎉' });
        return send(userId, '🎉 عالی! هر وقت خواستید در خدمتم.', { reply_markup: getMainMenu(userId) });
      }
      if (data === 'support:ticket') {
        await api.answerCallbackQuery(cb.id);
        states.set(String(userId), { s: 'support:await_subject' });
        return send(userId, '✍️ موضوع تیکت را بنویسید:');
      }
      if (data === 'back:bots') { await api.answerCallbackQuery(cb.id); return listBots(userId); }
      if (data === 'back:menu') {
        await api.answerCallbackQuery(cb.id);
        return send(userId, '🏠 منوی اصلی:', { reply_markup: getMainMenu(userId) });
      }
      if (data === 'cancel_flow') {
        await api.answerCallbackQuery(cb.id, { text: 'لغو شد.' });
        states.delete(String(userId));
        return send(userId, '❌ عملیات لغو شد.', { reply_markup: getMainMenu(userId) });
      }
      return api.answerCallbackQuery(cb.id);
    }

    if (!msg) return;
    const userId = msg.from.id;
    const text = (msg.text || '').trim();
    db.upsertUser(userId);
    const state = states.get(String(userId));

    // ---- flow states first
    if (state) {
      if (text === '/cancel') { states.delete(String(userId)); return send(userId, '❌ لغو شد.', { reply_markup: getMainMenu(userId) }); }
      // containerized wizard states (cw:*) + source-channel add loop
      if (await cont.handleStateText(userId, text)) return;
      if (await cont.handleAddChannel(userId, text)) return;
      switch (state.s) {
        case 'create:token':
          return finishBotCreation(userId, text);
        case 'panel:changetoken': {
          if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(text.trim())) return send(userId, '❌ فرمت توکن معتبر نیست. دوباره بفرستید یا /cancel بزنید.');
          const bot = db.getBot(state.botId);
          const newApi = deps.makeApi(text.trim());
          try {
            const me = await newApi.getMe();
            db.updateBot(bot.id, {
              token_encrypted: encrypt(text.trim(), cfg.ENCRYPTION_KEY),
              username: me.result.username,
              secret_token: crypto.randomBytes(24).toString('hex')
            });
            const updated = db.getBot(bot.id);
            const updApi = apiFor(updated);
            await updApi.setWebhook(`${cfg.PUBLIC_URL}/webhook/${updated.secret_token}`, updated.secret_token);
            states.delete(String(userId));
            await send(userId, `✅ توکن ربات با موفقیت تغییر کرد (@${escapeHtml(me.result.username)}) و وب‌هوک مجدداً ثبت شد.`);
            return showBotPanel(userId, state.botId);
          } catch (_) {
            return send(userId, '❌ توکن نامعتبر است (getMe ناموفق). دوباره تلاش کنید یا /cancel بزنید.');
          }
        }
        case 'upgrade:plan':
          return send(userId, 'لطفاً از دکمه‌های پلن استفاده کنید:', { reply_markup: { inline_keyboard: db.listPlans().filter((p) => p.id !== 'free').map((p) => ([{ text: `${p.name} — ${fmt(p.price)} ت`, callback_data: `upgrade:${state.botId}:${p.id}` }])) } });
        case 'wallet:await_amount': {
          const amount = parseInt(text.replace(/\D/g, ''), 10);
          if (!amount || amount < 10000) return send(userId, '❌ مبلغ نامعتبر است. حداقل ۱۰,۰۰۰ تومان. دوباره وارد کنید:');
          db.addTransaction(userId, amount, 'topup_pending', 'درخواست شارژ کیف پول');
          states.delete(String(userId));
          await send(userId, `🧾 درخواست شارژ <b>${fmt(amount)}</b> تومان ثبت شد. پس از پرداخت، ادمین تأیید می‌کند و موجودی شارژ می‌شود.`);
          return send(cfg.OWNER_TELEGRAM_ID, `🧰 <b>درخواست شارژ جدید</b>\nکاربر: <code>${userId}</code>\nمبلغ: <b>${fmt(amount)}</b> تومان`,
            { reply_markup: { inline_keyboard: [[{ text: '✅ تأیید', callback_data: `admin:approve_topup:${db.listAllTransactions()[0].id}` }, { text: '❌ رد', callback_data: `admin:reject_topup:${db.listAllTransactions()[0].id}` }]] } });
        }
        case 'support:await_subject': {
          if (text.length < 3) return send(userId, '❌ موضوع خیلی کوتاه است. دوباره بنویسید:');
          state.s = 'support:await_message';
          state.subject = text.slice(0, 100);
          return send(userId, '📝 حالا شرح مشکل را بنویسید:');
        }
        case 'support:await_message': {
          const ticket = support.createTicket(db, userId, state.subject, text.slice(0, 2000));
          states.delete(String(userId));
          await send(userId, `🎫 تیکت <b>#${ticket.id}</b> ثبت شد. پاسخ را همین‌جا دریافت می‌کنید.`, { reply_markup: getMainMenu(userId) });
          return send(cfg.OWNER_TELEGRAM_ID, `🎫 <b>تیکت جدید #${ticket.id}</b>\nکاربر: <code>${userId}</code>\nموضوع: ${escapeHtml(ticket.subject)}`,
            { reply_markup: { inline_keyboard: [[{ text: '💬 مشاهده و پاسخ', callback_data: `admin:ticket:${ticket.id}` }]] } });
        }
        case 'admin:ticketreply': {
          db.addTicketMessage(state.ticketId, 'admin', text.slice(0, 2000));
          const t = db.getTicket(state.ticketId);
          states.delete(String(userId));
          await send(userId, '✅ پاسخ ارسال شد.');
          return send(t.user_id, `💬 <b>پاسخ پشتیبانی به تیکت #${t.id}:</b>\n${escapeHtml(text.slice(0, 2000))}`, { reply_markup: getMainMenu(t.user_id) });
        }
        case 'custom:await_description':
          return handleCustomDescription(userId, text);
        default:
          break;
      }
    }

    // ---- custom source zip upload (document in flow)
    if (msg.document && state && state.s === 'custom:await_zip') {
      return handleCustomZip(userId, msg.document, null);
    }

    // ---- main menu & commands
    switch (text) {
      case '/start': {
        const who = isAdmin(userId) ? 'مالک پلتفرم' : 'کاربر';
        return send(userId,
          `👋 <b>سلام!</b> به <b>BotMaker</b> خوش آمدید (${who}).\nبدون کدنویسی ربات تلگرام خود را بسازید، مدیریت و پولی‌سازی کنید.`,
          { reply_markup: getMainMenu(userId) });
      }
      case '/menu': case '🏠 منوی اصلی':
        return send(userId, '🏠 منوی اصلی:', { reply_markup: getMainMenu(userId) });
      case '➕ ساخت ربات جدید':
        return send(userId, '🛠 <b>قالب ربات را انتخاب کنید:</b>', { reply_markup: templateKeyboard() });
      case '🎁 دریافت دمو رایگان': {
        // jump straight into creation with demo pre-selected, respecting one-demo-per-template
        const eligible = Object.values(registry).filter((t) => !db.hasUsedDemo(userId, t.id));
        if (!eligible.length) {
          return send(userId,
            '⚠️ شما دموی رایگان <b>همه انواع قالب‌ها</b> را قبلاً استفاده کرده‌اید.\nهر نوع قالب فقط یک بار دمو دارد. لطفاً از ساخت ربات با پلن پرداختی استفاده کنید:',
            { reply_markup: templateKeyboard('tpl') });
        }
        await send(userId, '🎁 <b>دموی رایگان (۶۰ دقیقه)</b>\nقالب مورد نظر را انتخاب کنید:');
        return send(userId, '🛠 قالب‌های دارای دمو:', {
          reply_markup: {
            inline_keyboard: eligible.map((t) => ([{ text: `🎁 ${t.name}`, callback_data: `plan:${t.id}:free` }]))
          }
        });
      }
      case '📋 ربات‌های من':
        return listBots(userId);
      case '💰 کیف پول و شارژ':
        return walletMenu(userId);
      case '🎫 پشتیبانی و تیکت':
        return supportMenu(userId);
      case 'ℹ️ راهنما':
        return send(userId,
          `ℹ️ <b>راهنمای BotMaker</b>\n\n` +
          `➕ <b>ساخت ربات:</b> قالب را انتخاب کنید، پلن را بگیرید و توکن BotFather را بفرستید.\n` +
          `🎁 <b>دمو:</b> هر نوع قالب فقط یک بار، ۶۰ دقیقه + ۵ ساعت مهلت ارتقا.\n` +
          `💰 <b>کیف پول:</b> اول شارژ، بعد خرید/تمدید؛ همه خریدها از کیف پول.\n` +
          `🤖 <b>مدیریت:</b> از «ربات‌های من» هر ربات را تمدید، توقف، عیب‌یابی یا حذف کنید.`,
          { reply_markup: getMainMenu(userId) });
      case '🧪 آزمایشگاه سورس سفارشی':
        return customSourceLab(userId);
      case '👑 کنسول مدیریت':
        return adminConsole(userId);
      default:
        return send(userId, 'لطفاً از منوی پایین استفاده کنید. 🙏', { reply_markup: getMainMenu(userId) });
    }
  }

  async function beginCreate(userId, templateId) {
    // containerized templates (§3.10-11): Pro/VIP only — straight to paid plans, no demo
    if (containerTemplates[templateId]) {
      const plans = db.listPlans().filter((p) => p.id !== 'free');
      return send(userId,
        '👑 این قالب <b>کانتینری</b> است (کانتینر اختصاصی + gVisor) و فقط روی پلن‌های <b>پرداختی</b> ارائه می‌شود:',
        { reply_markup: { inline_keyboard: plans.map((p) => ([{ text: `${p.id === 'vip' ? '👑' : '⭐'} ${p.name} — ${fmt(p.price)} تومان / ${p.duration_days} روز`, callback_data: `plan:${templateId}:${p.id}` }])) } });
    }
    if (!registry[templateId]) return;
    if (db.hasUsedDemo(userId, templateId)) {
      // already demoed this template type -> straight to paid plan selection
      const plans = db.listPlans().filter((p) => p.id !== 'free');
      return send(userId,
        `ℹ️ دموی این قالب را قبلاً استفاده کرده‌اید؛ فقط پلن‌های <b>پرداختی</b> قابل انتخاب هستند:`,
        {
          reply_markup: {
            inline_keyboard: plans.map((p) => ([{ text: `${p.id === 'vip' ? '👑' : '⭐'} ${p.name} — ${fmt(p.price)} ت`, callback_data: `plan:${templateId}:${p.id}` }]))
          }
        });
    }
    return send(userId, '⭐ پلن را انتخاب کنید:', { reply_markup: planKeyboard(templateId, userId) });
  }

  async function beginCreateWithPlan(userId, templateId, planId) {
    // demo-eligibility is enforced inside createBotInstance (one per template type)
    return createBotInstance(userId, templateId, planId);
  }

  async function approveCustomProject(userId, projectId, cbId) {
    const p = db.getCustomProject(projectId);
    if (!p || p.status !== 'pending_review') return api.answerCallbackQuery(cbId, { text: 'پروژه یافت نشد', show_alert: true });
    const r = customsource.buildSandboxCommand({
      runtime: p.runtime, startCommand: p.start_command,
      sourceDir: `${cfg.CUSTOM_SOURCES_DIR}/${projectId}`, projectId
    });
    if (!r.ok) {
      // FAIL CLOSED: gVisor (runsc) not available on host
      await api.answerCallbackQuery(cbId, { text: 'gVisor موجود نیست — اجرا ممنوع', show_alert: true });
      return send(userId,
        '🛑 اجرا ممکن نیست: گارد امنیتی gVisor روی سرور در دسترس نیست و سیستم <b>fail-closed</b> است (اجرا در کانتینر معمولی ممنوع). لطفاً gVisor را نصب کنید.');
    }
    // charge the custom-source fee from wallet at approval time
    const gate = customsource.checkPaymentGate(db, p.owner_id, cfg);
    if (!gate.ok) {
      db.updateCustomProject(projectId, { status: 'rejected' });
      return send(userId, '❌ موجودی کاربر کافی نیست؛ پروژه رد شد.');
    }
    const debit = wallet.debit(db, p.owner_id, cfg.CUSTOM_SOURCE_PRICE, 'custom_source', `اجرا پروژه سفارشی ${projectId}`);
    if (!debit.ok) {
      db.updateCustomProject(projectId, { status: 'rejected' });
      return send(userId, '❌ کسر مبلغ ناموفق؛ پروژه رد شد.');
    }
    db.updateCustomProject(projectId, { status: 'approved' });
    await send(userId, `✅ پروژه <code>${projectId}</code> تأیید و مبلغ کسر شد. دستور اجرا (sandbox):\n<code>${escapeHtml(r.command)}</code>`);
    return send(p.owner_id, `🎉 پروژه سفارشی شما تأیید شد و در محیط امن اجرا می‌شود. مبلغ <b>${fmt(cfg.CUSTOM_SOURCE_PRICE)}</b> تومان کسر شد.`);
  }

  return { processUpdate };
}

module.exports = { createControlBot };
