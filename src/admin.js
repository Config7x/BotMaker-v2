'use strict';

const { validateBotToken } = require('./db');
const { getMe, setWebhook, deleteWebhook, escapeHtml, downloadBotFile } = require('./telegram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CustomController } = require('./custom/controller');
const { SOURCE_MENU_LABEL } = require('./custom/constants');
const { TemplateManager } = require('./templateManager');
const { runLifecycleCheck } = require('./lifecycle');
const { createProvisioner } = require('./provisioner');
const { createTelethonDriver } = require('./telethon');
const { createContainerized } = require('./containerized');
const { containerTemplates, isContainerized } = require('./containerTemplates');
const { encrypt, decrypt } = require('./cryptoutil');
const { realClock } = require('./clock');

// Template names mapping in Persian
const TEMPLATE_NAMES = {
  shop: '🛒 فروشگاه و سفارش‌گیری',
  uploader: '📁 آپلود و مدیریت فایل',
  post_composer: '✍️ پست‌ساز و انتشار',
  channel_manager: '📢 مدیریت کانال',
  quiz: '🧩 کوییز و آزمون',
  downloader: '📥 دانلودر مستقیم',
  universal_poster: '🪅 پست‌ساز جامع و پارسر کانفیگ',
  multi_downloader: '🌐 دانلودر چندپلتفرمه رسانه',
  music_downloader: '🎵 دانلودر موزیک',
  music_bot: '🎧 موزیک‌یاب و دانلود صدای اینستاگرام',
  video_downloader: '🎬 دانلودر ویدیو (کیفیت‌های مختلف + MP3)',
  vpn_shop: '🛒 فروشگاه اشتراک VPN (کانتینر اختصاصی)',
  config_scraper: '📡 اسکرپر و پستر خودکار کانفیگ (کانتینر اختصاصی)'
};

const MAIN_MENU_LABELS = {
  create: '➕ ساخت ربات جدید',
  myBots: '📋 ربات‌های من',
  wallet: '💰 کیف پول و شارژ',
  support: '🎫 پشتیبانی و تیکت',
  help: 'ℹ️ راهنما',
  source: SOURCE_MENU_LABEL,
  templateManager: '🧩 مدیریت قالب‌ها',
  adminStats: '📊 آمار سیستم',
  adminConsole: '👑 پنل مدیریت ارشد'
};

// Builds the persistent Reply Keyboard shown to the user (native Telegram keyboard buttons)
function buildMainKeyboard(isAdmin, customEnabled) {
  const rows = [
    [MAIN_MENU_LABELS.create, MAIN_MENU_LABELS.myBots],
    [MAIN_MENU_LABELS.wallet, MAIN_MENU_LABELS.support],
    [MAIN_MENU_LABELS.help]
  ];
  const lastRow = [];
  lastRow.push(MAIN_MENU_LABELS.source); // always shown; usage still gated by hasPaidAccess in custom/controller.js
  if (isAdmin) lastRow.push(MAIN_MENU_LABELS.templateManager);
  if (isAdmin) lastRow.push(MAIN_MENU_LABELS.adminConsole);
  if (lastRow.length) rows.push(lastRow);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

// Builds the Inline (glass) Keyboard for template selection
function buildTemplateKeyboard(namesMap) {
  const map = namesMap || TEMPLATE_NAMES;
  return {
    inline_keyboard: Object.keys(map).map(id => [{ text: map[id], callback_data: `tpl:${id}`, style: 'primary' }])
  };
}

class AdminController {
  constructor({ db, config }) {
    this.db = db;
    this.config = config || {};
    this.userStates = new Map(); // Simple state tracker for workflows
    this.custom = new CustomController({
      db,
      config: this.config,
      runner: {
        start: args => require('./custom/runtime').start(args),
        stop: args => require('./custom/runtime').stop(args),
        logs: args => require('./custom/runtime').logs(args),
        status: args => require('./custom/runtime').status(args)
      },
      rewriter: (source, opts) => require('./custom/rewrite').generateAiRewriteCandidate(source, opts)
    });
    this.templates = new TemplateManager({ db, config: this.config });

    // -------- containerized templates (§3.10-11): own gVisor container per bot
    this.currentApi = null; // set on every handleUpdate; cont.send binds to it
    const contDbAdapter = {
      // thin adapter: containerized.js talks in getBot/updateBot terms
      getBot: (id) => {
        const row = this.db.getBotById(id);
        if (row && typeof row.config === 'string' && row.config) {
          try { row.config = JSON.parse(row.config); } catch { /* keep raw */ }
        }
        return row;
      },
      updateBot: (id, patch) => this.db.updateBotRecord(id, patch),
      upsertContainer: (rec) => this.db.upsertContainer(rec),
      getContainer: (botId) => this.db.getContainer(botId),
      updateContainer: (botId, patch) => this.db.updateContainer(botId, patch),
      deleteContainer: (botId) => this.db.deleteContainer(botId)
    };
    this.provisioner = createProvisioner(this.config.provisioner_opts || {});
    this.telethon = createTelethonDriver({
      provisioner: this.provisioner,
      cfg: { TELETHON_API_ID: this.config.telethon_api_id || process.env.TELETHON_API_ID || '', TELETHON_API_HASH: this.config.telethon_api_hash || process.env.TELETHON_API_HASH || '' }
    });
    this.cont = createContainerized({
      db: contDbAdapter,
      cfg: { ENCRYPTION_KEY: this.config.encryption_key || process.env.ENCRYPTION_KEY || '' },
      send: async (userId, text, opts) => {
        if (!this.currentApi) return;
        return this.currentApi.sendMessage(userId, text, { parse_mode: 'HTML', ...(opts || {}) });
      },
      states: this.userStates,
      escapeHtml,
      fmt: (n) => Number(n).toLocaleString('fa-IR'),
      encrypt, decrypt,
      provisioner: this.provisioner,
      containerTemplates,
      telethon: this.telethon,
      clock: realClock,
      answerCallback: (id, o) => (this.currentApi && this.currentApi.answerCallbackQuery) ? this.currentApi.answerCallbackQuery(id, o) : Promise.resolve()
    });
  }

  isAdminUser(userId) {
    const adminId = Number(this.config.admin_id || process.env.ADMIN_ID || 0);
    return adminId > 0 && Number(userId) === adminId;
  }

  getTemplateNames() {
    return this.templates.namesMap(TEMPLATE_NAMES);
  }

  getSystemStats() {
    const allBots = this.db.getAllBots();
    const activeBots = allBots.filter(b => b.status === 'active');
    const pausedBots = allBots.filter(b => b.status === 'paused');

    return {
      totalBots: allBots.length,
      activeBots: activeBots.length,
      pausedBots: pausedBots.length,
      config: {
        maxBotsPerUser: this.config.max_bots_per_user || 3,
        publicBaseUrl: this.config.public_base_url || 'https://example.com'
      }
    };
  }

  async handleUpdate({ update, bot, api, db: systemDb }) {
    if (!update) return;
    this.currentApi = api; // containerized wizard sends need the control-bot api

    const message = update.message || update.edited_message;
    const callbackQuery = update.callback_query;

    if (callbackQuery) {
      await this.handleCallbackQuery({ callbackQuery, api });
      return;
    }

    if (!message || !message.from) return;

    const userId = message.from.id;
    const chatId = message.chat.id;
    const text = (message.text || '').trim();
    if (message.chat.type && message.chat.type !== 'private') return;

    // Containerized-template wizard states (cw:*) — consumed before everything else
    if (text || message.document) {
      const cwState = this.userStates.get(userId);
      if (cwState && String(cwState.step || '').startsWith('cw:')) {
        if (text === '/cancel') {
          this.userStates.delete(userId);
          await api.sendMessage(chatId, '❌ عملیات کانتینری لغو شد.');
          await this.sendUserBots(api, chatId, userId);
          return;
        }
        const handled = await this.cont.handleStateText(userId, text || '');
        if (handled) return;
      }
      if (await this.cont.handleAddChannel(userId, text || '')) return;
    }

    // Template manager wizard (admin only) — text steps + final ZIP upload
    {
      const tplState = this.userStates.get(userId);
      if (tplState && String(tplState.step || '').startsWith('awaiting_new_template') && this.isAdminUser(userId)) {
        if (text === '/cancel') {
          this.userStates.delete(userId);
          await api.sendMessage(chatId, '❌ افزودن قالب لغو شد.');
          await this.sendTemplateManagerMenu(api, chatId, userId);
          return;
        }
        if (tplState.step === 'awaiting_new_template_zip') {
          if (message.document) {
            await this.handleNewTemplateZip(api, chatId, userId, message, tplState);
            return;
          }
          if (text) {
            await api.sendMessage(chatId, 'لطفاً فایل ZIP قالب را به‌صورت Document ارسال کنید (نه متن).');
            return;
          }
        } else if (text && !text.startsWith('/')) {
          await this.handleNewTemplateWizardText(api, chatId, userId, text, tplState);
          return;
        }
      }
    }

    // Custom runner handling delegation
    if (
      text === '/source' ||
      text === MAIN_MENU_LABELS.source ||
      text === '/source_help' ||
      text === '/sources' ||
      text.startsWith('/source_') ||
      (message.document && this.custom.states.get(userId)?.step === 'zip') ||
      (this.custom.states.get(userId)?.step === 'token' && !text.startsWith('/'))
    ) {
      return this.custom.handle({ message, api, userId, chatId });
    }

    // Register user in DB
    if (this.config.admin_only && !this.isAdminUser(userId)) {
      return api.sendMessage(chatId, 'این نسخه فقط برای تست مالک فعال است.');
    }
    this.db.registerUser(userId, this.isAdminUser(userId) ? 'admin' : 'user');

    // Basic Command Handling
    if (text === '/start') {
      this.userStates.delete(userId);
      await this.sendWelcomeMessage(api, chatId, userId);
      return;
    }

    if (text === '/help' || text === MAIN_MENU_LABELS.help) {
      await this.sendHelpMessage(api, chatId, userId);
      return;
    }

    if (text === '/my_bots' || text === MAIN_MENU_LABELS.myBots) {
      this.userStates.delete(userId);
      await this.sendUserBots(api, chatId, userId);
      return;
    }

    if (text === '/create_bot' || text === MAIN_MENU_LABELS.create) {
      await this.startBotCreation(api, chatId, userId);
      return;
    }

    if (text === '/wallet' || text === MAIN_MENU_LABELS.wallet) {
      this.userStates.delete(userId);
      await this.sendWalletMenu(api, chatId, userId);
      return;
    }

    if (text === '/support' || text === MAIN_MENU_LABELS.support) {
      this.userStates.delete(userId);
      await this.sendSupportMenu(api, chatId, userId);
      return;
    }

    if (text === '/admin' || text === '/master' || text === MAIN_MENU_LABELS.adminConsole) {
      await this.sendAdminConsole(api, chatId, userId);
      return;
    }

    if (text === '/templates' || text === MAIN_MENU_LABELS.templateManager) {
      this.userStates.delete(userId);
      await this.sendTemplateManagerMenu(api, chatId, userId);
      return;
    }

    if (text === '/admin_stats' || text === MAIN_MENU_LABELS.adminStats) {
      await this.sendAdminStats(api, chatId, userId);
      return;
    }

    if (text === '/admin_users') {
      await this.sendAdminUsersList(api, chatId, userId);
      return;
    }

    if (text === '/admin_tickets') {
      await this.sendAdminTicketsList(api, chatId, userId);
      return;
    }

    if (text === '/admin_plans') {
      await this.sendAdminPlansList(api, chatId, userId);
      return;
    }

    if (text === '/admin_run_lifecycle') {
      await this.adminTriggerLifecycle(api, chatId, userId);
      return;
    }

    if (text.startsWith('/admin_wallet')) {
      await this.adminAdjustWallet(api, chatId, userId, text);
      return;
    }

    if (text.startsWith('/admin_reply')) {
      await this.adminReplyTicket(api, chatId, userId, text);
      return;
    }

    if (text.startsWith('/admin_close')) {
      await this.adminCloseTicket(api, chatId, userId, text);
      return;
    }

    if (text.startsWith('/delete_')) {
      const botId = text.replace('/delete_', '').trim();
      await this.deleteUserBot(api, chatId, userId, botId);
      return;
    }

    // Interactive State Machine handling
    const state = this.userStates.get(userId);
    if (state) {
      if (state.step === 'awaiting_template') {
        await this.handleTemplateSelection(api, chatId, userId, text);
        return;
      } else if (state.step === 'awaiting_token') {
        await this.handleTokenInput(api, chatId, userId, text, state.templateId);
        return;
      } else if (state.step === 'awaiting_deposit_amount') {
        await this.handleCustomDepositInput(api, chatId, userId, text);
        return;
      } else if (state.step === 'awaiting_ticket_subject') {
        await this.handleTicketSubjectInput(api, chatId, userId, text, state.botId);
        return;
      } else if (state.step === 'awaiting_ticket_message') {
        await this.handleTicketMessageInput(api, chatId, userId, text, state.botId, state.subject);
        return;
      } else if (state.step === 'awaiting_ticket_reply') {
        await this.handleTicketReplyInput(api, chatId, userId, text, state.ticketId);
        return;
      } else if (state.step === 'awaiting_plan_line') {
        if (text === '/cancel') {
          this.userStates.delete(userId);
          await api.sendMessage(chatId, '❌ لغو شد.');
          await this.sendPlanManagerMenu(api, chatId, userId);
          return;
        }
        await this.handlePlanLineInput(api, chatId, userId, text);
        return;
      }
    }

    // Default response in Persian
    await api.sendMessage(
      chatId,
      'دستور متوجه نشدم. لطفاً از منوی زیر یکی از گزینه‌ها را انتخاب کنید:\n\n/start - منوی اصلی\n/create_bot - ساخت ربات جدید\n/my_bots - مشاهده ربات‌های من\n/wallet - کیف پول',
      { reply_markup: buildMainKeyboard(this.isAdminUser(userId), this.custom.enabled(userId)) }
    );
  }

  async sendWelcomeMessage(api, chatId, userId) {
    const isAdmin = this.isAdminUser(userId);
    let msg = `سلام! به ربات‌ساز <b>BotMaker v2</b> خوش آمدید. 👋\n\n`;
    msg += `با استفاده از این ربات می‌توانید به راحتی و بدون نیاز به برنامه‌نویسی، ربات تلگرام خود را بسازید و مدیریت کنید.\n\n`;
    msg += `از دکمه‌های پایین صفحه برای پیمایش استفاده کنید 👇`;

    await api.sendMessage(chatId, msg, {
      parse_mode: 'HTML',
      reply_markup: buildMainKeyboard(isAdmin, this.custom.enabled(userId))
    });
  }

  async sendHelpMessage(api, chatId, userId) {
    let msg = `<b>📖 راهنمای استفاده از BotMaker v2</b>\n\n`;
    msg += `<b>مراحل ساخت ربات:</b>\n`;
    msg += `۱. ابتدا از طریق BotFather@ یک ربات جدید ایجاد کرده و توکن (Token) آن را کپی کنید.\n`;
    msg += `۲. دکمه «${MAIN_MENU_LABELS.create}» را بزنید (یا /create_bot را ارسال کنید).\n`;
    msg += `۳. قالب مورد نظر خود را از دکمه‌های شیشه‌ای انتخاب کنید.\n`;
    msg += `۴. توکن دریافت شده را ارسال کنید.\n`;
    msg += `۵. وب‌هوک ربات به طور خودکار فعال و ربات شما آماده استفاده خواهد بود! 🎉\n\n`;
    msg += `<b>امکانات کیف پول و اشتراک:</b>\n`;
    msg += `• شارژ آنلاین حساب کاربری از طریق بخش «${MAIN_MENU_LABELS.wallet}»\n`;
    msg += `• تمدید خودکار اشتراک ربات‌ها با کسر از کیف پول\n`;
    msg += `• پشتیبانی ۲۴ ساعته از طریق بخش «${MAIN_MENU_LABELS.support}»\n\n`;
    msg += `حداکثر تعداد مجاز ربات برای هر کاربر: <b>${this.config.max_bots_per_user || 3}</b> عدد.`;

    await api.sendMessage(chatId, msg, {
      parse_mode: 'HTML',
      reply_markup: buildMainKeyboard(this.isAdminUser(userId), this.custom.enabled(userId))
    });
  }

  async startBotCreation(api, chatId, userId) {
    const maxBots = this.config.max_bots_per_user || 3;
    const currentCount = this.db.getBotCountForUser(userId);

    if (currentCount >= maxBots) {
      await api.sendMessage(
        chatId,
        `⚠️ شما به حداکثر تعداد مجاز ربات (<b>${maxBots}</b> عدد) رسیده‌اید.\n\nبرای ساخت ربات جدید، ابتدا یکی از ربات‌های موجود خود را از طریق «${MAIN_MENU_LABELS.myBots}» حذف کنید.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    this.userStates.set(userId, { step: 'awaiting_template' });

    const msg = `<b>لطفاً قالب مورد نظر خود را برای ربات انتخاب کنید:</b>\n\nروی یکی از گزینه‌های زیر بزنید 👇`;

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: buildTemplateKeyboard(this.getTemplateNames()) });
  }

  async handleTemplateSelection(api, chatId, userId, text) {
    const selection = text.toLowerCase().trim();
    let templateId = null;

    if (selection === '1' || selection === 'shop') templateId = 'shop';
    else if (selection === '2' || selection === 'uploader') templateId = 'uploader';
    else if (selection === '3' || selection === 'post_composer') templateId = 'post_composer';
    else if (selection === '4' || selection === 'channel_manager') templateId = 'channel_manager';
    else if (selection === '5' || selection === 'quiz') templateId = 'quiz';
    else if (selection === '6' || selection === 'downloader') templateId = 'downloader';
    else if (selection === '7' || selection === 'universal_poster') templateId = 'universal_poster';
    else if (selection === '8' || selection === 'multi_downloader') templateId = 'multi_downloader';
    else if (selection === '9' || selection === 'music_downloader') templateId = 'music_downloader';
    else if (Object.prototype.hasOwnProperty.call(this.getTemplateNames(), selection)) templateId = selection;

    // containerized templates (§3.10-11) are Pro/VIP only — refuse free outright
    if (isContainerized(templateId)) {
      const user = this.db.getUser(userId);
      const planId = (user && user.plan_id) || 'free';
      if (!this.cont.planAllowed(planId)) {
        await this.cont.refuseFree(userId);
        return;
      }
    }

    if (!templateId) {
      await api.sendMessage(
        chatId,
        '❌ قالب انتخاب شده نامعتبر است. لطفاً یکی از گزینه‌های موجود (مثلاً <code>shop</code> یا <code>1</code>) را ارسال کنید، یا از دکمه‌های شیشه‌ای بالا استفاده کنید.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    this.userStates.set(userId, { step: 'awaiting_token', templateId });

    const templateName = this.getTemplateNames()[templateId] || templateId;
    let msg = `قالب <b>${escapeHtml(templateName)}</b> انتخاب شد. 👍\n\n`;
    msg += `اکنون لطفاً <b>توکن (Token)</b> ربات خود را که از BotFather@ دریافت کرده‌اید ارسال کنید:\n`;
    msg += `<i>مثال: 123456789:ABCdefGHIjklMNOpqrsTUVwxyZ</i>`;

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  }

  async handleTokenInput(api, chatId, userId, tokenInput, templateId) {
    const token = tokenInput.trim();

    if (!validateBotToken(token)) {
      await api.sendMessage(chatId, '❌ فرمت توکن ارسال‌شده نامعتبر است.\n\nلطفاً توکن صحیح را به فرمت استاندارد BotFather ارسال کنید.');
      return;
    }

    try {
      const isMock = this.config.mock_telegram || process.env.MOCK_TELEGRAM === 'true';
      const botInfoRes = await getMe(token, { mock: isMock });

      if (!botInfoRes?.ok || !botInfoRes.result?.id) {
        throw new Error('Telegram rejected the bot token');
      }

      let username = 'bot_' + Math.floor(Math.random() * 1000);
      if (botInfoRes?.result?.username) {
        username = botInfoRes.result.username;
      }

      const botRecord = this.db.createBot({
        ownerId: userId,
        token: token,
        username: username,
        templateId: templateId,
        encryptionKey: this.config.encryption_key || process.env.ENCRYPTION_KEY,
        maxBotsPerUser: this.config.max_bots_per_user || 3
      });

      // ---- containerized template (§3.10-11): own gVisor container, NO platform webhook
      if (isContainerized(templateId)) {
        this.userStates.delete(userId);
        this.db.updateBotRecord(botRecord.id, {
          config: { containerized: true, plan_required: 'pro' },
          status: 'provisioning'
        });
        const contBot = this.db.getBotById(botRecord.id);
        return this.cont.startWizard(userId, contBot);
      }

      const registered = await setWebhook(token, this.config.public_base_url || 'https://example.com', botRecord.secret_token, {
        mock: isMock
      });

      if (!registered?.ok) {
        this.db.deleteBot(botRecord.id, userId);
        throw new Error('Webhook registration failed');
      }

      this.userStates.delete(userId);

      const templateName = this.getTemplateNames()[templateId] || templateId;
      let msg = `🎉 <b>ربات شما با موفقیت ساخته و فعال شد!</b>\n\n`;
      msg += `🤖 نام کاربری: @${escapeHtml(username)}\n`;
      msg += `⚙️ قالب: <b>${escapeHtml(templateName)}</b>\n`;
      msg += `🆔 شناسه: <code>${botRecord.id}</code>\n`;
      msg += `📅 اعتبار اولیه: <b>۳۰ روز رایگان</b>\n\n`;
      msg += `برای مدیریت ربات خود می‌توانید از بخش «${MAIN_MENU_LABELS.myBots}» استفاده کنید.`;

      await api.sendMessage(chatId, msg, {
        parse_mode: 'HTML',
        reply_markup: buildMainKeyboard(this.isAdminUser(userId), this.custom.enabled(userId))
      });
    } catch (err) {
      this.userStates.delete(userId);
      let errMsg = '❌ خطایی در ثبت ربات رخ داد.';
      if (err.message.includes('TOKEN_ALREADY_REGISTERED')) {
        errMsg = '❌ این توکن ربات قبلاً در سیستم ثبت شده است.';
      } else if (err.message.includes('QUOTA_EXCEEDED')) {
        errMsg = `❌ شما به حداکثر تعداد مجاز ربات (${this.config.max_bots_per_user || 3} عدد) رسیده‌اید.`;
      }
      await api.sendMessage(chatId, errMsg);
    }
  }

  async sendUserBots(api, chatId, userId) {
    const bots = this.db.getUserBots(userId);

    if (bots.length === 0) {
      await api.sendMessage(
        chatId,
        `شما هنوز هیچ رباتی نساخته‌اید.\n\nبرای ساخت اولین ربات خود روی دکمه «${MAIN_MENU_LABELS.create}» بزنید.`,
        { reply_markup: buildMainKeyboard(this.isAdminUser(userId), this.custom.enabled(userId)) }
      );
      return;
    }

    let msg = `<b>📋 ربات‌های ثبت‌شده شما (${bots.length} عدد):</b>\n\n`;

    const inlineKeyboard = [];

    for (const b of bots) {
      const templateName = this.getTemplateNames()[b.template_id] || b.template_id;
      const statusEmoji = b.status === 'active' ? '🟢 فعال' : (b.status === 'paused' ? '⏸ متوقف' : '🔴 منقضی/غیرفعال');
      const plan = this.db.getPlanById(b.plan_id) || { name: b.plan_id || 'free' };
      const expiresText = b.expires_at ? new Date(b.expires_at).toLocaleDateString('fa-IR', { timeZone: 'UTC' }) : 'نامحدود';

      msg += `🤖 <b>@${escapeHtml(b.username || b.id)}</b>\n`;
      msg += `├ قالب: ${escapeHtml(templateName)}\n`;
      msg += `├ وضعیت: ${statusEmoji}\n`;
      msg += `├ پلن: ${escapeHtml(plan.name)}\n`;
      msg += `└ انقضا: <code>${expiresText}</code>\n\n`;

      inlineKeyboard.push([
        { text: `⚙️ مدیریت @${b.username || b.id}`, callback_data: `mybots:view:${b.id}`, style: 'primary' }
      ]);
    }

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKeyboard } });
  }

  async sendBotDetailPanel(api, chatId, userId, botId) {
    const bot = this.db.getBotById(botId);
    if (!bot || (bot.owner_id !== userId && !this.isAdminUser(userId))) {
      await api.sendMessage(chatId, '❌ ربات یافت نشد.');
      return;
    }

    const plan = this.db.getPlanById(bot.plan_id) || { name: bot.plan_id || 'free', price: 0 };
    const statusEmoji = bot.status === 'active' ? '🟢 فعال' : (bot.status === 'paused' ? '⏸ متوقف' : '🔴 منقضی/غیرفعال');
    const autoRenewStatus = bot.auto_renew === 1 ? '✅ فعال' : '❌ غیرفعال';
    const expiresText = bot.expires_at ? new Date(bot.expires_at).toLocaleDateString('fa-IR', { timeZone: 'UTC' }) : 'نامحدود';

    let msg = `<b>🤖 پنل اختصاصی مدیریت ربات</b>\n\n`;
    msg += `👤 نام کاربری: <b>@${escapeHtml(bot.username || bot.id)}</b>\n`;
    msg += `🆔 شناسه ربات: <code>${bot.id}</code>\n`;
    msg += `📌 وضعیت: <b>${statusEmoji}</b>\n`;
    msg += `⚙️ قالب: <b>${escapeHtml(this.getTemplateNames()[bot.template_id] || bot.template_id)}</b>\n`;
    msg += `📦 پلن اشتراک: <b>${escapeHtml(plan.name)}</b> (${plan.price.toLocaleString('fa-IR')} تومان/ماه)\n`;
    msg += `📅 تاریخ انقضا: <code>${expiresText}</code>\n`;
    msg += `🔄 تمدید خودکار: <b>${autoRenewStatus}</b>\n`;

    // containerized bots get the container panel (status/restart/channels), no webhook reset
    let botConfig = bot.config;
    if (typeof botConfig === 'string' && botConfig) { try { botConfig = JSON.parse(botConfig); } catch { botConfig = {}; } }
    if (botConfig && (botConfig.containerized || isContainerized(bot.template_id))) {
      bot.config = botConfig;
      await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: this.cont.panelKeyboard(bot) });
      return;
    }

    const toggleLabel = bot.status === 'active' ? '⏸ متوقف کردن' : '▶️ فعال‌سازی';
    const toggleAction = bot.status === 'active' ? 'pause' : 'resume';

    const inlineKeyboard = [
      [
        { text: toggleLabel, callback_data: `mybots:${toggleAction}:${bot.id}`, style: toggleAction === 'pause' ? 'danger' : 'success' },
        { text: '🔄 تمدید اشتراک', callback_data: `mybots:renew:${bot.id}`, style: 'success' }
      ],
      [
        { text: `🔄 تمدید خودکار: ${autoRenewStatus}`, callback_data: `mybots:toggle_renew:${bot.id}`, style: 'primary' },
        { text: '🔑 بازنشانی وب‌هوک', callback_data: `mybots:reset_webhook:${bot.id}`, style: 'primary' }
      ],
      [
        { text: '🎫 ثبت تیکت پشتیبانی برای این ربات', callback_data: `support:new_for:${bot.id}`, style: 'primary' },
        { text: '🗑 حذف ربات', callback_data: `mybots:delete:${bot.id}`, style: 'danger' }
      ]
    ];

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKeyboard } });
  }

  async renewBotSubscription(api, chatId, userId, botId) {
    const bot = this.db.getBotById(botId);
    if (!bot || bot.owner_id !== userId) {
      await api.sendMessage(chatId, '❌ ربات یافت نشد.');
      return;
    }

    const plan = this.db.getPlanById(bot.plan_id) || this.db.getPlanById('free');
    const price = plan ? plan.price : 0;
    const durationDays = plan ? plan.duration_days : 30;

    if (price > 0) {
      const balance = this.db.getWalletBalance(userId);
      if (balance < price) {
        let msg = `❌ <b>موجودی کیف پول شما کافی نیست!</b>\n\n`;
        msg += `هزینه تمدید پلن <b>${escapeHtml(plan.name)}</b> برابر با <b>${price.toLocaleString('fa-IR')} تومان</b> است.\n`;
        msg += `موجودی فعلی شما: <b>${balance.toLocaleString('fa-IR')} تومان</b>\n\n`;
        msg += `لطفاً از بخش «${MAIN_MENU_LABELS.wallet}» کیف پول خود را شارژ کنید.`;
        await api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
        return;
      }

      this.db.chargeWallet(userId, price, `تمدید دستی اشتراک ربات ${bot.username || bot.id}`);
    }

    this.db.renewBotPlan(botId, durationDays);

    let msg = `🎉 <b>ربات @${escapeHtml(bot.username || bot.id)} با موفقیت تمدید شد!</b>\n\n`;
    if (price > 0) {
      msg += `مبلغ <b>${price.toLocaleString('fa-IR')} تومان</b> از کیف پول شما کسر گردید.\n`;
    }
    msg += `اعتبار ربات شما به مدت <b>${durationDays} روز</b> تمدید گردید.`;

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    await this.sendBotDetailPanel(api, chatId, userId, botId);
  }

  async resetBotWebhook(api, chatId, userId, botId) {
    const bot = this.db.getBotById(botId);
    if (!bot || bot.owner_id !== userId) {
      await api.sendMessage(chatId, '❌ ربات یافت نشد.');
      return;
    }
    let cfg = bot.config;
    if (typeof cfg === 'string' && cfg) { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
    if (cfg && (cfg.containerized || isContainerized(bot.template_id))) {
      await api.sendMessage(chatId, 'ℹ️ ربات‌های کانتینری از وب‌هوک پلتفرم استفاده نمی‌کنند.');
      return;
    }

    try {
      const { decryptToken } = require('./db');
      const token = decryptToken(bot.token_encrypted, this.config.encryption_key || process.env.ENCRYPTION_KEY);
      const isMock = this.config.mock_telegram || process.env.MOCK_TELEGRAM === 'true';

      await setWebhook(token, this.config.public_base_url || 'https://example.com', bot.secret_token, { mock: isMock });
      await api.sendMessage(chatId, `✅ وب‌هوک ربات <b>@${escapeHtml(bot.username || bot.id)}</b> با موفقیت بازنشانی شد.`, { parse_mode: 'HTML' });
    } catch (err) {
      await api.sendMessage(chatId, '❌ خطایی در بازنشانی وب‌هوک رخ داد.');
    }
  }

  async deleteUserBot(api, chatId, userId, botId) {
    try {
      const bot = this.db.getBotById(botId);
      if (!bot) {
        await api.sendMessage(chatId, '❌ ربات یافت نشد.');
        return;
      }

      const isMock = this.config.mock_telegram || process.env.MOCK_TELEGRAM === 'true';
      if (bot.owner_id !== userId && !this.isAdminUser(userId)) throw new Error('UNAUTHORIZED');
      if (bot.token_encrypted) {
        try {
          const { decryptToken } = require('./db');
          const token = decryptToken(bot.token_encrypted, this.config.encryption_key || process.env.ENCRYPTION_KEY);
          await deleteWebhook(token, { mock: isMock });
        } catch (e) {
          // ignore decrypt errors on cleanup
        }
      }

      // containerized bots: full teardown — container + data volume + registry row
      let cfg = bot.config;
      if (typeof cfg === 'string' && cfg) { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
      if (cfg && (cfg.containerized || isContainerized(bot.template_id))) {
        try { await this.cont.destroyInstance(botId); } catch (e) { /* best-effort teardown */ }
      }

      this.db.deleteBot(botId, userId);
      await api.sendMessage(chatId, `🗑️ ربات <b>${escapeHtml(bot.username || botId)}</b> با موفقیت حذف شد.`, { parse_mode: 'HTML' });
    } catch (err) {
      await api.sendMessage(chatId, '❌ خطایی در حذف ربات به وجود آمد.');
    }
  }

  async togglePauseResumeBot(api, chatId, userId, botId, targetStatus) {
    try {
      const bot = this.db.getBotById(botId);
      if (!bot || (bot.owner_id !== userId && !this.isAdminUser(userId))) {
        await api.sendMessage(chatId, '❌ ربات یافت نشد.');
        return;
      }
      this.db.updateBotStatus(botId, userId, targetStatus);
      // containerized bots: pause/resume must also stop/start the Docker container
      let cfg = bot.config;
      if (typeof cfg === 'string' && cfg) { try { cfg = JSON.parse(cfg); } catch { cfg = null; } }
      if (cfg && (cfg.containerized || isContainerized(bot.template_id))) {
        const ok = await this.cont.setRunning(botId, targetStatus === 'active');
        if (!ok) {
          await api.sendMessage(chatId, '⚠️ وضعیت ربات ثبت شد اما کانتینر آن تغییر نکرد (Docker در دسترس نیست؟).');
        }
      }
    } catch (err) {
      await api.sendMessage(chatId, '❌ خطایی در تغییر وضعیت ربات به وجود آمد.');
    }
  }

  // --- Wallet Menu UI & Actions ---

  async sendWalletMenu(api, chatId, userId) {
    const balance = this.db.getWalletBalance(userId);
    const user = this.db.getUser(userId);
    const currentPlan = user?.plan_id ? (this.db.getPlanById(user.plan_id) || { name: user.plan_id }) : null;

    let msg = `<b>💰 کیف پول و حساب کاربری</b>\n\n`;
    msg += `👤 شناسه کاربر: <code>${userId}</code>\n`;
    msg += `💵 موجودی کیف پول: <b>${balance.toLocaleString('fa-IR')} تومان</b>\n`;
    if (currentPlan) {
      msg += `📦 پلن حساب: <b>${escapeHtml(currentPlan.name)}</b>\n`;
    }
    msg += `\nجهت افزایش موجودی یا خرید/تمدید پلن، یکی از گزینه‌های زیر را انتخاب کنید:`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '➕ ۵۰,۰۰۰ تومان', callback_data: 'wallet:deposit_preset:50000', style: 'success' },
          { text: '➕ ۱۰۰,۰۰۰ تومان', callback_data: 'wallet:deposit_preset:100000', style: 'success' }
        ],
        [
          { text: '➕ ۲۰۰,۰۰۰ تومان', callback_data: 'wallet:deposit_preset:200000', style: 'success' },
          { text: '✏️ مبلغ دلخواه', callback_data: 'wallet:deposit_custom', style: 'primary' }
        ],
        [
          { text: '📦 مشاهده پلن‌ها', callback_data: 'wallet:plans', style: 'primary' },
          { text: '📜 تراکنش‌ها', callback_data: 'wallet:tx_history', style: 'primary' }
        ]
      ]
    };

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  async handleDepositPreset(api, chatId, userId, amount) {
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) return;

    const newBalance = this.db.addWalletBalance(userId, numAmount, 'deposit', 'شارژ مستقیم آنلاین کیف پول');

    let msg = `✅ <b>موجودی کیف پول شما با موفقیت افزایش یافت!</b>\n\n`;
    msg += `➕ مبلغ اضافه شده: <b>${numAmount.toLocaleString('fa-IR')} تومان</b>\n`;
    msg += `💵 موجودی جدید: <b>${newBalance.toLocaleString('fa-IR')} تومان</b>`;

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  }

  async handleCustomDepositInput(api, chatId, userId, text) {
    const amount = parseInt(text.replace(/[^0-9]/g, ''), 10);
    if (isNaN(amount) || amount <= 0) {
      await api.sendMessage(chatId, '❌ لطفاً یک مبلغ معتبر به عددی (مثلاً 50000) وارد کنید.');
      return;
    }

    this.userStates.delete(userId);
    const newBalance = this.db.addWalletBalance(userId, amount, 'deposit', 'شارژ کیف پول با مبلغ دلخواه');

    let msg = `✅ <b>کیف پول شما با موفقیت شارژ شد!</b>\n\n`;
    msg += `➕ مبلغ اضافه شده: <b>${amount.toLocaleString('fa-IR')} تومان</b>\n`;
    msg += `💵 موجودی فعلی: <b>${newBalance.toLocaleString('fa-IR')} تومان</b>`;

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  }

  async sendTransactionHistory(api, chatId, userId) {
    const txs = this.db.getWalletTransactions(userId, 15);
    if (txs.length === 0) {
      await api.sendMessage(chatId, '📜 هنوز هیچ تراکنشی در حساب شما ثبت نشده است.');
      return;
    }

    let msg = `<b>📜 تاریخچه تراکنش‌های کیف پول:</b>\n\n`;
    txs.forEach(t => {
      const icon = t.amount >= 0 ? '🟢' : '🔴';
      const sign = t.amount >= 0 ? '+' : '';
      const dateStr = new Date(t.created_at).toLocaleDateString('fa-IR', { timeZone: 'UTC' });
      msg += `${icon} <b>${sign}${t.amount.toLocaleString('fa-IR')} تومان</b> (${escapeHtml(t.type)})\n`;
      msg += `├ بابت: ${escapeHtml(t.description || 'بدون توضیح')}\n`;
      msg += `└ تاریخ: <code>${dateStr}</code>\n\n`;
    });

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  }

  async sendPlansCatalog(api, chatId, userId) {
    const plans = this.db.getPlans();
    let msg = `<b>📦 پلن‌های اشتراک سیستم:</b>\n\n`;

    const inlineKeyboard = [];
    plans.forEach(p => {
      msg += `🔹 <b>${escapeHtml(p.name)}</b> - ${p.price.toLocaleString('fa-IR')} تومان / ${p.duration_days} روز\n`;
      msg += `├ سقف ربات: ${p.max_bots} عدد\n`;
      msg += `└ توضیح: ${escapeHtml(p.description || '')}\n\n`;

      if (p.price > 0) {
        inlineKeyboard.push([
          { text: `🛒 ارتقا به ${p.name} (${p.price.toLocaleString('fa-IR')} تومان)`, callback_data: `plan:subscribe:${p.id}`, style: 'success' }
        ]);
      }
    });

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: { inline_keyboard: inlineKeyboard } });
  }

  async handlePlanSubscribe(api, chatId, userId, planId) {
    const plan = this.db.getPlanById(planId);
    if (!plan) {
      await api.sendMessage(chatId, '❌ پلن مورد نظر یافت نشد.');
      return;
    }

    const balance = this.db.getWalletBalance(userId);
    if (balance < plan.price) {
      let msg = `❌ <b>موجودی کافی نیست!</b>\n\n`;
      msg += `قیمت پلن <b>${escapeHtml(plan.name)}</b>: <b>${plan.price.toLocaleString('fa-IR')} تومان</b>\n`;
      msg += `موجودی فعلی شما: <b>${balance.toLocaleString('fa-IR')} تومان</b>\n\n`;
      msg += `لطفاً ابتدا کیف پول خود را شارژ کنید.`;
      await api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      return;
    }

    this.db.chargeWallet(userId, plan.price, `ارتقا به پلن ${plan.name}`);
    this.db.setUserPlan(userId, plan.id, plan.duration_days);

    let msg = `🎉 <b>حساب شما با موفقیت به پلن ${escapeHtml(plan.name)} ارتقا یافت!</b>\n\n`;
    msg += `مبلغ <b>${plan.price.toLocaleString('fa-IR')} تومان</b> کسر شد. سقف مجاز ربات شما به <b>${plan.max_bots}</b> عدد افزایش یافت.`;

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  }

  // --- Support Ticket Flow ---

  async sendSupportMenu(api, chatId, userId) {
    const tickets = this.db.getUserTickets(userId);

    let msg = `<b>🎫 مرکز پشتیبانی و تیکت‌ها</b>\n\n`;
    if (tickets.length === 0) {
      msg += `شما هنوز هیچ تیکت پشتیبانی ثبت نکرده‌اید.\n`;
    } else {
      msg += `<b>تیکت‌های اخیر شما:</b>\n`;
      tickets.slice(0, 5).forEach(t => {
        const statusStr = t.status === 'open' ? '🟡 در انتظار پاسخ' : (t.status === 'replied' ? '🟢 پاسخ داده شد' : '⚪️ بسته شده');
        msg += `• [#${t.id}] <b>${escapeHtml(t.subject)}</b> (${statusStr})\n`;
      });
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '📩 ثبت تیکت جدید', callback_data: 'support:new', style: 'primary' }]
      ]
    };

    if (tickets.length > 0) {
      tickets.slice(0, 5).forEach(t => {
        keyboard.inline_keyboard.push([
          { text: `🔎 مشاهده تیکت #${t.id}: ${t.subject.slice(0, 20)}`, callback_data: `support:view:${t.id}`, style: 'primary' }
        ]);
      });
    }

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  async startTicketCreation(api, chatId, userId, botId = null) {
    this.userStates.set(userId, { step: 'awaiting_ticket_subject', botId });
    await api.sendMessage(chatId, '✍️ لطفاً <b>موضوع تیکت پشتیبانی</b> خود را وارد کنید:', { parse_mode: 'HTML' });
  }

  async handleTicketSubjectInput(api, chatId, userId, text, botId) {
    const subject = text.trim();
    if (!subject) return;

    this.userStates.set(userId, { step: 'awaiting_ticket_message', botId, subject });
    await api.sendMessage(chatId, `موضوع: <b>${escapeHtml(subject)}</b>\n\nاکنون لطفاً <b>متن پیام پشتیبانی</b> خود را ارسال کنید:`, { parse_mode: 'HTML' });
  }

  async handleTicketMessageInput(api, chatId, userId, text, botId, subject) {
    const message = text.trim();
    if (!message) return;

    this.userStates.delete(userId);
    const ticket = this.db.createSupportTicket({ userId, botId, subject, message });

    let msg = `✅ <b>تیکت پشتیبانی شما با موفقیت ثبت شد!</b>\n\n`;
    msg += `🔢 شماره تیکت: <b>#${ticket.id}</b>\n`;
    msg += `📌 موضوع: <b>${escapeHtml(subject)}</b>\n\n`;
    msg += `پشتیبانی در اسرع وقت پاسخ شما را ارسال خواهد کرد.`;

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  }

  async sendTicketDetail(api, chatId, userId, ticketId) {
    const ticket = this.db.getTicketById(ticketId);
    if (!ticket || (ticket.user_id !== userId && !this.isAdminUser(userId))) {
      await api.sendMessage(chatId, '❌ تیکت یافت نشد.');
      return;
    }

    const statusStr = ticket.status === 'open' ? '🟡 در انتظار پاسخ' : (ticket.status === 'replied' ? '🟢 پاسخ داده شد' : '⚪️ بسته شده');
    let msg = `<b>🎫 تیکت پشتیبانی #${ticket.id}</b>\n`;
    msg += `موضوع: <b>${escapeHtml(ticket.subject)}</b>\n`;
    msg += `وضعیت: <b>${statusStr}</b>\n\n`;

    msg += `<b>تاریخچه پیام‌ها:</b>\n\n`;
    ticket.messages.forEach(m => {
      const sender = m.sender_role === 'admin' ? '👑 پشتیبانی' : '👤 شما';
      const dateStr = new Date(m.created_at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
      msg += `<b>${sender}</b> (${dateStr}):\n${escapeHtml(m.message)}\n-------------------\n`;
    });

    const keyboard = { inline_keyboard: [] };
    if (ticket.status !== 'closed') {
      keyboard.inline_keyboard.push([
        { text: '💬 ارسال پاسخ', callback_data: `support:reply:${ticket.id}`, style: 'primary' }
      ]);
    }

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  async handleTicketReplyInput(api, chatId, userId, text, ticketId) {
    const message = text.trim();
    if (!message) return;

    this.userStates.delete(userId);
    const role = this.isAdminUser(userId) ? 'admin' : 'user';
    this.db.addTicketMessage({ ticketId, senderId: userId, senderRole: role, message });

    await api.sendMessage(chatId, `✅ پاسخ شما به تیکت #${ticketId} ارسال گردید.`, { parse_mode: 'HTML' });
    await this.sendTicketDetail(api, chatId, userId, ticketId);
  }

  // --- Master Admin Console ---

  async sendAdminConsole(api, chatId, userId) {
    if (!this.isAdminUser(userId)) {
      await api.sendMessage(chatId, '❌ شما دسترسی به پنل مدیریت ارشد را ندارید.');
      return;
    }

    const stats = this.db.getAdminMasterStats();
    let msg = `<b>👑 پنل مدیریت ارشد (Master Admin Console)</b>\n`;
    msg += `<i>مدیر سیستم: میلاد</i>\n\n`;

    msg += `👥 <b>آمار کاربران:</b>\n`;
    msg += `• کل کاربران: <b>${stats.totalUsers}</b> نفر\n`;
    msg += `• مجموع موجودی کیف پول‌ها: <b>${stats.totalWalletBalance.toLocaleString('fa-IR')} تومان</b>\n\n`;

    msg += `🤖 <b>آمار ربات‌ها:</b>\n`;
    msg += `• کل ربات‌ها: <b>${stats.totalBots}</b>\n`;
    msg += `• فعال: <b>${stats.botsByStatus.active}</b> | متوقف: <b>${stats.botsByStatus.paused}</b> | منقضی: <b>${stats.botsByStatus.expired || 0}</b>\n`;
    msg += `• اشتراک‌های فعال: <b>${stats.activeSubscriptions}</b>\n\n`;

    msg += `🎫 <b>آمار تیکت‌های پشتیبانی:</b>\n`;
    msg += `• باز (در انتظار): <b>${stats.ticketStats.open}</b> | پاسخ‌داده: <b>${stats.ticketStats.replied}</b> | بسته: <b>${stats.ticketStats.closed}</b>\n\n`;

    msg += `<b>دستورات اختصاصی مدیریت:</b>\n`;
    msg += `• <code>/admin_wallet &lt;userId&gt; &lt;amount&gt;</code> - تغییر کیف پول کاربر\n`;
    msg += `• <code>/admin_reply &lt;ticketId&gt; &lt;message&gt;</code> - پاسخ به تیکت\n`;
    msg += `• <code>/admin_close &lt;ticketId&gt;</code> - بستن تیکت\n`;
    msg += `• <code>/admin_users</code> - مشاهده لیست کاربران\n`;
    msg += `• <code>/admin_tickets</code> - مشاهده تیکت‌های باز\n`;
    msg += `• <code>/admin_run_lifecycle</code> - اجرای دستی لایف‌سایکل`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🎫 تیکت‌های باز', callback_data: 'admin:tickets', style: 'primary' },
          { text: '🔄 اجرای دستی لایف‌سایکل', callback_data: 'admin:run_lifecycle', style: 'primary' }
        ],
        [
          { text: '👥 لیست کاربران', callback_data: 'admin:users', style: 'primary' },
          { text: '📦 پلن‌های سیستم', callback_data: 'admin:plans', style: 'primary' }
        ],
        [
          { text: '🧩 مدیریت قالب‌ها', callback_data: 'admin:templates', style: 'primary' }
        ]
      ]
    };

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  async sendAdminStats(api, chatId, userId) {
    if (!this.isAdminUser(userId)) {
      await api.sendMessage(chatId, '❌ شما دسترسی به بخش مدیریت سیستم را ندارید.');
      return;
    }

    const stats = this.getSystemStats();
    let msg = `<b>📊 آمار مدیریتی BotMaker v2:</b>\n\n`;
    msg += `🤖 کل ربات‌های ثبت شده: <b>${stats.totalBots}</b>\n`;
    msg += `🟢 ربات‌های فعال: <b>${stats.activeBots}</b>\n`;
    msg += `🟡 ربات‌های معلق: <b>${stats.pausedBots}</b>\n`;
    msg += `⚙️ سقف مجاز ربات هر کاربر: <b>${stats.config.maxBotsPerUser}</b>\n`;
    msg += `🌐 آدرس پایه وب‌هوک: <code>${escapeHtml(stats.config.publicBaseUrl)}</code>`;

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: buildMainKeyboard(true, this.custom.enabled(userId)) });
  }

  async sendAdminUsersList(api, chatId, userId) {
    if (!this.isAdminUser(userId)) return;

    const allBots = this.db.getAllBots();
    const usersMap = new Map();

    allBots.forEach(b => {
      const u = usersMap.get(b.owner_id) || { id: b.owner_id, botCount: 0 };
      u.botCount++;
      usersMap.set(b.owner_id, u);
    });

    let msg = `<b>👥 کاربران فعال در سیستم:</b>\n\n`;
    if (usersMap.size === 0) {
      msg += `هنوز کاربری ثبت نشده است.`;
    } else {
      usersMap.forEach(u => {
        const balance = this.db.getWalletBalance(u.id);
        msg += `👤 ID: <code>${u.id}</code> | تعداد ربات: <b>${u.botCount}</b> | کیف پول: <b>${balance.toLocaleString('fa-IR')} تومان</b>\n`;
      });
    }

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  }

  async sendAdminTicketsList(api, chatId, userId) {
    if (!this.isAdminUser(userId)) return;

    const tickets = this.db.getAllTickets('open');
    let msg = `<b>🎫 تیکت‌های باز در انتظار پاسخ (${tickets.length} عدد):</b>\n\n`;

    const keyboard = { inline_keyboard: [] };
    tickets.forEach(t => {
      msg += `• [#${t.id}] کاربر <code>${t.user_id}</code>: <b>${escapeHtml(t.subject)}</b>\n`;
      keyboard.inline_keyboard.push([
        { text: `💬 پاسخ به #${t.id}`, callback_data: `admin:ticket_reply:${t.id}`, style: 'primary' },
        { text: `🔒 بستن #${t.id}`, callback_data: `admin:ticket_close:${t.id}`, style: 'danger' }
      ]);
    });

    if (tickets.length === 0) {
      msg += `هیچ تیکت بازی وجود ندارد. ✨`;
    }

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  async sendAdminPlansList(api, chatId, userId) {
    if (!this.isAdminUser(userId)) return;
    await this.sendPlanManagerMenu(api, chatId, userId);
  }

  async sendPlanManagerMenu(api, chatId, userId) {
    if (!this.isAdminUser(userId)) return;
    const plans = this.db.getPlans();

    let msg = '<b>📦 مدیریت پلن‌های اشتراک</b>\n\n';
    if (plans.length === 0) {
      msg += '<i>هیچ پلنی ثبت نشده.</i>\n';
    }
    for (const p of plans) {
      msg += `🔹 <b>${escapeHtml(p.name)}</b> <code>(${p.id})</code>\n`;
      msg += `├ قیمت: ${p.price.toLocaleString('fa-IR')} تومان | مدت: ${p.duration_days} روز | سقف ربات: ${p.max_bots}\n`;
      if (p.description) msg += `└ توضیح: ${escapeHtml(p.description)}\n`;
      msg += '\n';
    }
    msg += '➕/✏️ برای افزودن یا ویرایش، «افزودن/ویرایش پلن» را بزن و یک خط با این ساختار بفرست:\n';
    msg += '<code>id|نام|قیمت|سقف_ربات|مدت_روز|توضیح</code>\n';
    msg += 'مثال: <code>vip|پلن VIP|150000|10|30|دسترسی کامل با پشتیبانی ویژه</code>\n';
    msg += 'اگر <code>id</code> از پیش وجود داشته باشد، همان پلن آپدیت می‌شود.';

    const keyboard = { inline_keyboard: [[{ text: '➕/✏️ افزودن یا ویرایش پلن', callback_data: 'planmgr:add', style: 'success' }]] };
    for (const p of plans) {
      if (p.id === 'free') continue; // protect the built-in free plan from deletion
      keyboard.inline_keyboard.push([{ text: `🗑 حذف «${p.name}»`, callback_data: `planmgr:delete:${p.id}`, style: 'danger' }]);
    }
    keyboard.inline_keyboard.push([{ text: '🔄 بروزرسانی لیست', callback_data: 'planmgr:list', style: 'primary' }]);

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  async handlePlanLineInput(api, chatId, userId, text) {
    const parts = text.split('|').map(s => s.trim());
    if (parts.length < 5) {
      await api.sendMessage(
        chatId,
        '❌ فرمت نادرست است. باید حداقل ۵ بخش با | جدا شده باشد:\n<code>id|نام|قیمت|سقف_ربات|مدت_روز|توضیح(اختیاری)</code>\nدوباره بفرست یا /cancel بزن.',
        { parse_mode: 'HTML' }
      );
      return;
    }
    const [id, name, priceStr, maxBotsStr, durationStr, ...descParts] = parts;
    const price = Number(priceStr);
    const maxBots = Number(maxBotsStr);
    const durationDays = Number(durationStr);
    const cleanId = id.toLowerCase().replace(/[^a-z0-9_]/g, '');

    if (!cleanId || !name || !Number.isFinite(price) || price < 0 || !Number.isInteger(maxBots) || maxBots < 1 || !Number.isInteger(durationDays) || durationDays < 1) {
      await api.sendMessage(chatId, '❌ مقادیر نامعتبر است. قیمت و مدت و سقف ربات باید عدد معتبر باشند. دوباره بفرست یا /cancel بزن.');
      return;
    }

    const plan = this.db.savePlan({ id: cleanId, name, price, maxBots, durationDays, description: descParts.join('|').trim() });
    this.userStates.delete(userId);
    await api.sendMessage(chatId, `✅ پلن <b>${escapeHtml(plan.name)}</b> ذخیره شد.`, { parse_mode: 'HTML' });
    await this.sendPlanManagerMenu(api, chatId, userId);
  }

  async adminAdjustWallet(api, chatId, adminId, text) {
    if (!this.isAdminUser(adminId)) return;

    const parts = text.split(' ').filter(Boolean);
    if (parts.length < 3) {
      await api.sendMessage(chatId, '❌ فرمت دستور نادرست است.\nاستفاده: <code>/admin_wallet <userId> <amount></code>\nمثال: <code>/admin_wallet 123456 50000</code>', { parse_mode: 'HTML' });
      return;
    }

    const targetUserId = Number(parts[1]);
    const amount = Number(parts[2]);

    if (isNaN(targetUserId) || isNaN(amount)) {
      await api.sendMessage(chatId, '❌ شناسه کاربر و مبلغ باید عددی باشند.');
      return;
    }

    try {
      const newBalance = this.db.addWalletBalance(targetUserId, amount, 'admin_adjustment', `تغییر توسط مدیر (${adminId})`);
      await api.sendMessage(chatId, `✅ موجودی کاربر <code>${targetUserId}</code> تغییر یافت.\nتغییر: <b>${amount} تومان</b>\nموجودی جدید: <b>${newBalance.toLocaleString('fa-IR')} تومان</b>`, { parse_mode: 'HTML' });
    } catch (err) {
      await api.sendMessage(chatId, `❌ خطا: ${err.message}`);
    }
  }

  async adminReplyTicket(api, chatId, adminId, text) {
    if (!this.isAdminUser(adminId)) return;

    const parts = text.split(' ');
    if (parts.length < 3) {
      await api.sendMessage(chatId, '❌ فرمت دستور نادرست است.\nاستفاده: <code>/admin_reply <ticketId> <message></code>', { parse_mode: 'HTML' });
      return;
    }

    const ticketId = Number(parts[1]);
    const replyMessage = parts.slice(2).join(' ').trim();

    try {
      const ticket = this.db.addTicketMessage({ ticketId, senderId: adminId, senderRole: 'admin', message: replyMessage });
      await api.sendMessage(chatId, `✅ پاسخ شما به تیکت #${ticketId} ارسال گردید.`, { parse_mode: 'HTML' });

      // Notify ticket owner
      const userMsg = `🔔 <b>پاسخ جدید به تیکت پشتیبانی #${ticketId}</b>\n\nموضوع: <b>${escapeHtml(ticket.subject)}</b>\n\n<b>پاسخ مدیر:</b>\n${escapeHtml(replyMessage)}`;
      await api.sendMessage(ticket.user_id, userMsg, { parse_mode: 'HTML' }).catch(() => {});
    } catch (err) {
      await api.sendMessage(chatId, `❌ خطا: ${err.message}`);
    }
  }

  async adminCloseTicket(api, chatId, adminId, text) {
    if (!this.isAdminUser(adminId)) return;

    const parts = text.split(' ').filter(Boolean);
    if (parts.length < 2) {
      await api.sendMessage(chatId, '❌ فرمت دستور نادرست است.\nاستفاده: <code>/admin_close <ticketId></code>', { parse_mode: 'HTML' });
      return;
    }

    const ticketId = Number(parts[1]);
    try {
      this.db.closeTicket(ticketId);
      await api.sendMessage(chatId, `🔒 تیکت #${ticketId} با موفقیت بسته شد.`, { parse_mode: 'HTML' });
    } catch (err) {
      await api.sendMessage(chatId, `❌ خطا: ${err.message}`);
    }
  }

  async adminTriggerLifecycle(api, chatId, adminId) {
    if (!this.isAdminUser(adminId)) return;

    try {
      const res = await runLifecycleCheck({ db: this.db, config: this.config });
      let msg = `🔄 <b>بررسی دستی لایف‌سایکل انجام شد:</b>\n\n`;
      msg += `❇️ تمدید شده: <b>${res.renewed.length}</b> ربات\n`;
      msg += `⏸ متوقف شده: <b>${res.paused.length}</b> ربات\n`;
      msg += `⚠️ خطاها: <b>${res.errors.length}</b>`;
      await api.sendMessage(chatId, msg, { parse_mode: 'HTML' });
    } catch (err) {
      await api.sendMessage(chatId, `❌ خطا در اجرای لایف‌سایکل: ${err.message}`);
    }
  }

  async handleCallbackQuery({ callbackQuery, api }) {
    if (!callbackQuery) return;
    const data = callbackQuery.data || '';
    const userId = callbackQuery.from?.id;
    const chatId = callbackQuery.message?.chat?.id;

    try {
      // Custom-source buttons (admin ✅ approve / ❌ reject, paid AI auto-fix confirm/cancel)
      // are created by CustomController, so it must be the one to handle their presses.
      if (data.startsWith('admin_approve_') || data.startsWith('admin_reject_') || data.startsWith('autofix_')) {
        await this.custom.handleCallbackQuery({ callbackQuery, api });
        return;
      }

      // Containerized-template panel & wizard callbacks (cw:*)
      if (data.startsWith('cw:')) {
        this.currentApi = api;
        await this.cont.handleCallback(userId, data, callbackQuery.id);
        return;
      }

      // Template selection via inline button
      if (data.startsWith('tpl:')) {
        const templateId = data.slice(4);
        const state = this.userStates.get(userId);
        if (!state || state.step !== 'awaiting_template') {
          await api.answerCallbackQuery(callbackQuery.id, { text: '⏱ این گزینه منقضی شده. دوباره «➕ ساخت ربات جدید» را بزنید.' });
          return;
        }
        await api.answerCallbackQuery(callbackQuery.id, { text: '✅ انتخاب شد' });
        await this.handleTemplateSelection(api, chatId, userId, templateId);
        return;
      }

      // My Bots inline actions
      if (data.startsWith('mybots:')) {
        const parts = data.split(':');
        const action = parts[1];
        const botId = parts[2];

        if (action === 'view') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'دریافت شد' });
          await this.sendBotDetailPanel(api, chatId, userId, botId);
          return;
        }

        if (action === 'pause' || action === 'resume') {
          await this.togglePauseResumeBot(api, chatId, userId, botId, action === 'pause' ? 'paused' : 'active');
          await api.answerCallbackQuery(callbackQuery.id, { text: action === 'pause' ? '⏸ متوقف شد' : '▶️ فعال شد' });
          await this.sendBotDetailPanel(api, chatId, userId, botId);
          return;
        }

        if (action === 'renew') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'در حال تمدید...' });
          await this.renewBotSubscription(api, chatId, userId, botId);
          return;
        }

        if (action === 'toggle_renew') {
          this.db.toggleBotAutoRenew(botId, userId);
          await api.answerCallbackQuery(callbackQuery.id, { text: 'تغییر یافت' });
          await this.sendBotDetailPanel(api, chatId, userId, botId);
          return;
        }

        if (action === 'reset_webhook') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'در حال بازنشانی...' });
          await this.resetBotWebhook(api, chatId, userId, botId);
          return;
        }

        if (action === 'delete') {
          await api.answerCallbackQuery(callbackQuery.id, { text: '🗑 حذف شد' });
          await this.deleteUserBot(api, chatId, userId, botId);
          await this.sendUserBots(api, chatId, userId);
          return;
        }
      }

      // Wallet inline actions
      if (data.startsWith('wallet:')) {
        const parts = data.split(':');
        const action = parts[1];

        if (action === 'deposit_preset') {
          const amount = parts[2];
          await api.answerCallbackQuery(callbackQuery.id, { text: 'شارژ شد' });
          await this.handleDepositPreset(api, chatId, userId, amount);
          return;
        }

        if (action === 'deposit_custom') {
          this.userStates.set(userId, { step: 'awaiting_deposit_amount' });
          await api.answerCallbackQuery(callbackQuery.id, { text: 'منتظر مبلغ...' });
          await api.sendMessage(chatId, '✏️ لطفاً مبلغ مورد نظر برای شارژ کیف پول را به <b>تومان</b> وارد کنید (مثال: <code>50000</code>):', { parse_mode: 'HTML' });
          return;
        }

        if (action === 'tx_history') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'تراکنش‌ها' });
          await this.sendTransactionHistory(api, chatId, userId);
          return;
        }

        if (action === 'plans') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'پلن‌ها' });
          await this.sendPlansCatalog(api, chatId, userId);
          return;
        }
      }

      // Plan subscription action
      if (data.startsWith('plan:subscribe:')) {
        const planId = data.replace('plan:subscribe:', '');
        await api.answerCallbackQuery(callbackQuery.id, { text: 'پردازش...' });
        await this.handlePlanSubscribe(api, chatId, userId, planId);
        return;
      }

      // Support inline actions
      if (data.startsWith('support:')) {
        const parts = data.split(':');
        const action = parts[1];

        if (action === 'new' || action === 'new_for') {
          const botId = parts[2] || null;
          await api.answerCallbackQuery(callbackQuery.id, { text: 'ثبت تیکت' });
          await this.startTicketCreation(api, chatId, userId, botId);
          return;
        }

        if (action === 'view') {
          const ticketId = Number(parts[2]);
          await api.answerCallbackQuery(callbackQuery.id, { text: 'مشاهده' });
          await this.sendTicketDetail(api, chatId, userId, ticketId);
          return;
        }

        if (action === 'reply') {
          const ticketId = Number(parts[2]);
          this.userStates.set(userId, { step: 'awaiting_ticket_reply', ticketId });
          await api.answerCallbackQuery(callbackQuery.id, { text: 'منتظر پاسخ...' });
          await api.sendMessage(chatId, `✍️ لطفاً <b>پاسخ خود</b> را برای تیکت #${ticketId} ارسال کنید:`, { parse_mode: 'HTML' });
          return;
        }
      }

      // Master Admin console actions
      if (data.startsWith('admin:')) {
        const action = data.slice(6);
        if (!this.isAdminUser(userId)) {
          await api.answerCallbackQuery(callbackQuery.id, { text: '❌ عدم دسترسی' });
          return;
        }

        if (action === 'tickets') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'تیکت‌های باز' });
          await this.sendAdminTicketsList(api, chatId, userId);
          return;
        }

        if (action === 'users') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'کاربران' });
          await this.sendAdminUsersList(api, chatId, userId);
          return;
        }

        if (action === 'plans') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'پلن‌ها' });
          await this.sendAdminPlansList(api, chatId, userId);
          return;
        }

        if (action === 'stats') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'آمار' });
          await this.sendAdminConsole(api, chatId, userId);
          return;
        }

        if (action === 'templates') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'مدیریت قالب‌ها' });
          await this.sendTemplateManagerMenu(api, chatId, userId);
          return;
        }

        if (action === 'run_lifecycle') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'اجرای لایف‌سایکل...' });
          await this.adminTriggerLifecycle(api, chatId, userId);
          return;
        }

        if (action.startsWith('ticket_reply:')) {
          const ticketId = Number(action.replace('ticket_reply:', ''));
          this.userStates.set(userId, { step: 'awaiting_ticket_reply', ticketId });
          await api.answerCallbackQuery(callbackQuery.id, { text: 'پاسخ مدیریت' });
          await api.sendMessage(chatId, `👑 لطفاً <b>پاسخ مدیریت</b> را برای تیکت #${ticketId} ارسال کنید:`, { parse_mode: 'HTML' });
          return;
        }

        if (action.startsWith('ticket_close:')) {
          const ticketId = Number(action.replace('ticket_close:', ''));
          this.db.closeTicket(ticketId);
          await api.answerCallbackQuery(callbackQuery.id, { text: 'بسته شد' });
          await api.sendMessage(chatId, `🔒 تیکت #${ticketId} توسط مدیر بسته شد.`, { parse_mode: 'HTML' });
          return;
        }
      }

      // Template Manager actions (admin only)
      if (data.startsWith('tplmgr:')) {
        if (!this.isAdminUser(userId)) {
          await api.answerCallbackQuery(callbackQuery.id, { text: '❌ عدم دسترسی' });
          return;
        }
        const action = data.slice(7);

        if (action === 'list') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'لیست قالب‌ها' });
          await this.sendTemplateManagerMenu(api, chatId, userId);
          return;
        }

        if (action === 'add') {
          this.userStates.set(userId, { step: 'awaiting_new_template_id' });
          await api.answerCallbackQuery(callbackQuery.id, { text: 'افزودن قالب جدید' });
          await api.sendMessage(
            chatId,
            '➕ <b>افزودن قالب جدید</b>\n\n' +
              'مرحله ۱ از ۳ — یک شناسه (Slug) انگلیسی برای قالب بفرست.\n' +
              'فقط حروف کوچک انگلیسی، عدد و آندرلاین (_)، بین ۳ تا ۴۰ کاراکتر. مثال: <code>vip_shop</code>\n\n' +
              'برای انصراف در هر مرحله: /cancel',
            { parse_mode: 'HTML' }
          );
          return;
        }

        if (action === 'cancel') {
          this.userStates.delete(userId);
          await api.answerCallbackQuery(callbackQuery.id, { text: 'لغو شد' });
          await this.sendTemplateManagerMenu(api, chatId, userId);
          return;
        }

        if (action.startsWith('toggle:')) {
          const id = action.replace('toggle:', '');
          const row = this.templates.get(id);
          if (!row) {
            await api.answerCallbackQuery(callbackQuery.id, { text: 'یافت نشد' });
            return;
          }
          this.templates.setEnabled(id, row.enabled ? 0 : 1);
          await api.answerCallbackQuery(callbackQuery.id, { text: row.enabled ? 'غیرفعال شد' : 'فعال شد' });
          await this.sendTemplateManagerMenu(api, chatId, userId);
          return;
        }

        if (action.startsWith('remove:')) {
          const id = action.replace('remove:', '');
          const ok = this.templates.remove(id);
          await api.answerCallbackQuery(callbackQuery.id, { text: ok ? 'حذف شد' : 'یافت نشد' });
          await this.sendTemplateManagerMenu(api, chatId, userId);
          return;
        }
      }

      // Plan Manager actions (admin only)
      if (data.startsWith('planmgr:')) {
        if (!this.isAdminUser(userId)) {
          await api.answerCallbackQuery(callbackQuery.id, { text: '❌ عدم دسترسی' });
          return;
        }
        const action = data.slice(8);

        if (action === 'list') {
          await api.answerCallbackQuery(callbackQuery.id, { text: 'لیست پلن‌ها' });
          await this.sendPlanManagerMenu(api, chatId, userId);
          return;
        }

        if (action === 'add') {
          this.userStates.set(userId, { step: 'awaiting_plan_line' });
          await api.answerCallbackQuery(callbackQuery.id, { text: 'افزودن/ویرایش پلن' });
          await api.sendMessage(
            chatId,
            '➕/✏️ یک خط با این ساختار بفرست:\n<code>id|نام|قیمت|سقف_ربات|مدت_روز|توضیح</code>\nمثال: <code>vip|پلن VIP|150000|10|30|دسترسی کامل</code>\n\nبرای انصراف: /cancel',
            { parse_mode: 'HTML' }
          );
          return;
        }

        if (action.startsWith('delete:')) {
          const id = action.replace('delete:', '');
          try {
            const ok = this.db.deletePlan(id);
            await api.answerCallbackQuery(callbackQuery.id, { text: ok ? 'حذف شد' : 'یافت نشد' });
          } catch (err) {
            const text = err.message === 'PLAN_IN_USE' ? 'این پلن توسط ربات‌های فعال استفاده می‌شود و قابل حذف نیست' : 'خطا در حذف';
            await api.answerCallbackQuery(callbackQuery.id, { text, show_alert: true });
          }
          await this.sendPlanManagerMenu(api, chatId, userId);
          return;
        }
      }

      await api.answerCallbackQuery(callbackQuery.id, { text: 'دریافت شد' });
    } catch (err) {
      await api.answerCallbackQuery(callbackQuery.id, { text: '❌ خطایی رخ داد' }).catch(() => {});
    }
  }
  async sendTemplateManagerMenu(api, chatId, userId) {
    if (!this.isAdminUser(userId)) {
      await api.sendMessage(chatId, '❌ شما دسترسی به مدیریت قالب‌ها را ندارید.');
      return;
    }

    const customRows = this.templates.list();

    let msg = '<b>🧩 مدیریت قالب‌های ربات‌ساز</b>\n\n';
    msg += '<b>قالب‌های پیش‌فرض (سیستمی، غیرقابل حذف):</b>\n';
    for (const [id, label] of Object.entries(TEMPLATE_NAMES)) {
      msg += `• ${escapeHtml(label)} <code>(${id})</code>\n`;
    }

    msg += '\n<b>قالب‌های اختصاصی (افزوده‌شده توسط شما):</b>\n';
    if (customRows.length === 0) {
      msg += '<i>هنوز هیچ قالب اختصاصی اضافه نشده.</i>\n';
    } else {
      for (const row of customRows) {
        const statusIcon = row.enabled ? '✅ فعال' : '⛔️ غیرفعال';
        msg += `• <b>${escapeHtml(row.name)}</b> <code>(${row.id})</code> — ${statusIcon}\n`;
        if (row.description) msg += `  <i>${escapeHtml(row.description)}</i>\n`;
      }
    }

    msg += '\nقالب‌های اختصاصی فعال به‌طور خودکار در لیست «➕ ساخت ربات جدید» برای همه کاربران نمایش داده می‌شوند.\n';
    msg += 'برای افزودن، یک ZIP بفرست که در ریشه‌اش فایل <code>index.js</code> با <code>module.exports.handle = async ({update, bot, api, db}) => {...}</code> داشته باشد (دقیقاً مثل قالب‌های داخلی).';

    const keyboard = { inline_keyboard: [[{ text: '➕ افزودن قالب جدید', callback_data: 'tplmgr:add', style: 'success' }]] };
    for (const row of customRows) {
      keyboard.inline_keyboard.push([
        { text: `${row.enabled ? '⛔️ غیرفعال کردن' : '✅ فعال کردن'} «${row.name}»`, callback_data: `tplmgr:toggle:${row.id}`, style: row.enabled ? 'danger' : 'success' },
        { text: `🗑 حذف «${row.name}»`, callback_data: `tplmgr:remove:${row.id}`, style: 'danger' }
      ]);
    }
    keyboard.inline_keyboard.push([{ text: '🔄 بروزرسانی لیست', callback_data: 'tplmgr:list', style: 'primary' }]);

    await api.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  async handleNewTemplateWizardText(api, chatId, userId, text, state) {
    if (state.step === 'awaiting_new_template_id') {
      const cleanId = text.toLowerCase().trim();
      if (!/^[a-z][a-z0-9_]{2,39}$/.test(cleanId)) {
        await api.sendMessage(chatId, '❌ شناسه نامعتبر است. فقط حروف کوچک انگلیسی، عدد و آندرلاین، بین ۳ تا ۴۰ کاراکتر و شروع با حرف. دوباره بفرست یا /cancel بزن.');
        return;
      }
      if (this.templates.exists(cleanId) || Object.prototype.hasOwnProperty.call(TEMPLATE_NAMES, cleanId)) {
        await api.sendMessage(chatId, '❌ این شناسه قبلاً استفاده شده (سیستمی یا اختصاصی). یک شناسه دیگر بفرست یا /cancel بزن.');
        return;
      }
      this.userStates.set(userId, { step: 'awaiting_new_template_name', newTemplateId: cleanId });
      await api.sendMessage(chatId, `✅ شناسه ثبت شد: <code>${escapeHtml(cleanId)}</code>\n\nمرحله ۲ از ۳ — نام نمایشی قالب را بفرست (مثلاً «فروشگاه VIP»):`, { parse_mode: 'HTML' });
      return;
    }

    if (state.step === 'awaiting_new_template_name') {
      const name = text.trim().slice(0, 60);
      if (!name) {
        await api.sendMessage(chatId, '❌ نام نمی‌تواند خالی باشد. دوباره بفرست یا /cancel بزن.');
        return;
      }
      this.userStates.set(userId, { step: 'awaiting_new_template_desc', newTemplateId: state.newTemplateId, newTemplateName: name });
      await api.sendMessage(chatId, 'مرحله ۳ از ۳ — یک توضیح کوتاه برای قالب بفرست (یا فقط بنویس «-» برای رد شدن):');
      return;
    }

    if (state.step === 'awaiting_new_template_desc') {
      const desc = text.trim() === '-' ? '' : text.trim().slice(0, 200);
      this.userStates.set(userId, {
        step: 'awaiting_new_template_zip',
        newTemplateId: state.newTemplateId,
        newTemplateName: state.newTemplateName,
        newTemplateDesc: desc
      });
      await api.sendMessage(
        chatId,
        '📦 حالا فایل <b>ZIP</b> قالب را به‌صورت Document ارسال کن.\n\n' +
          'الزامات:\n' +
          '• حداکثر ۱۰ مگابایت\n' +
          '• در ریشه ZIP باید <code>index.js</code> باشد که <code>module.exports.handle = async ({update, bot, api, db}) => {...}</code> را export کند\n' +
          '• همان قراردادی که قالب‌های داخلی رباتساز استفاده می‌کنند\n\n' +
          'برای انصراف: /cancel',
        { parse_mode: 'HTML' }
      );
      return;
    }
  }

  async handleNewTemplateZip(api, chatId, userId, message, state) {
    const doc = message.document;
    if (!/\.zip$/i.test(doc.file_name || '')) {
      await api.sendMessage(chatId, '❌ فقط فایل ZIP پذیرفته می‌شود.');
      return;
    }
    if (doc.file_size > 10 * 1024 * 1024) {
      await api.sendMessage(chatId, '❌ حجم فایل بیش از حد مجاز (۱۰ مگابایت) است.');
      return;
    }

    await api.sendMessage(chatId, '⏳ در حال دریافت و بررسی فایل...');

    let tmpZipPath = null;
    try {
      const buffer = await downloadBotFile(this.config.control_bot_token, doc.file_id, 10 * 1024 * 1024, { mock: this.config.mock_telegram });
      tmpZipPath = path.join(os.tmpdir(), `tpl-upload-${userId}-${Date.now()}.zip`);
      fs.writeFileSync(tmpZipPath, buffer);

      const row = await this.templates.addFromZip({
        id: state.newTemplateId,
        name: state.newTemplateName,
        description: state.newTemplateDesc,
        zipPath: tmpZipPath,
        addedBy: userId
      });

      this.userStates.delete(userId);
      await api.sendMessage(
        chatId,
        `✅ قالب <b>${escapeHtml(row.name)}</b> با شناسه <code>${escapeHtml(row.id)}</code> با موفقیت اضافه شد و از همین الان در لیست «➕ ساخت ربات جدید» در دسترس همه کاربران است.`,
        { parse_mode: 'HTML' }
      );
      await this.sendTemplateManagerMenu(api, chatId, userId);
    } catch (err) {
      await api.sendMessage(chatId, `❌ افزودن قالب ناموفق بود:\n${escapeHtml(String(err.message || err).slice(0, 500))}\n\nمی‌توانی فایل را اصلاح کرده و دوباره بفرستی، یا /cancel بزن.`, { parse_mode: 'HTML' });
    } finally {
      if (tmpZipPath) fs.unlink(tmpZipPath, () => {});
    }
  }
}

module.exports = {
  AdminController,
  TEMPLATE_NAMES,
  MAIN_MENU_LABELS,
  buildMainKeyboard,
  buildTemplateKeyboard
};
