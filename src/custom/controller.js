'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateUploadArchive, cleanupExtractedSource } = require('./validator');
const { SOURCE_MENU_LABEL } = require('./constants');
const { validateManifestAndStartCommand } = require('./manifest');
const { runStaticAnalysis } = require('./analyzer');
const { runAiSecurityReview, runAiBugReview, runAiAutoFix } = require('./aiReview');
const { classifyRuntimeError } = require('./runtime');
const { checkGvisorAvailable } = require('./container');
const { encryptToken, decryptToken, validateBotToken } = require('../db');
const { getMe, downloadBotFile } = require('../telegram');
const { escapeHtml } = require('../utils/html');

class CustomController {
  constructor({ db, config, runner, rewriter, downloadFile, aiClient }) {
    this.db = db;
    this.config = config || {};
    this.runner = runner;
    this.rewriter = rewriter;
    this.downloadFile = downloadFile || downloadBotFile;
    this.aiClient = aiClient || this.config.aiClient || null;
    this.aiAutoFixFeeToman = Number(this.config.aiAutoFixFeeToman || 20000);
    this.customSourceFeeToman = Number(this.config.customSourceFeeToman || 50000);
    this.root = path.resolve(this.config.projects_dir || path.join(__dirname, '..', '..', 'data', 'projects'));
    this.states = new Map();

    this.db.sqlite.exec(`CREATE TABLE IF NOT EXISTS custom_projects (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL,
      source_dir TEXT NOT NULL,
      token_encrypted TEXT,
      runtime TEXT,
      start_command TEXT,
      status TEXT NOT NULL,
      report TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
  }

  isAdmin(userId) {
    return Number(this.config.admin_id) > 0 && Number(userId) === Number(this.config.admin_id);
  }

  hasPaidAccess(userId) {
    if (this.isAdmin(userId)) return true;
    const user = this.db.getUser(userId);
    if (!user) return false;

    // Check active paid plan
    if (user.plan_id && user.plan_id !== 'free') {
      if (!user.plan_expires_at || new Date(user.plan_expires_at) > new Date()) {
        return true;
      }
    }

    // Check wallet balance
    const balance = this.db.getWalletBalance(userId);
    return balance >= this.customSourceFeeToman;
  }

  enabled(userId) {
    return this.hasPaidAccess(userId);
  }

  get(id, ownerId) {
    if (!/^src_[a-f0-9]{16}$/.test(id || '')) return null;
    if (ownerId && !this.isAdmin(ownerId)) {
      return this.db.sqlite.prepare('SELECT * FROM custom_projects WHERE id=? AND owner_id=?').get(id, ownerId) || null;
    }
    return this.db.sqlite.prepare('SELECT * FROM custom_projects WHERE id=?').get(id) || null;
  }

  list(ownerId) {
    return this.db.sqlite.prepare('SELECT id,status,runtime FROM custom_projects WHERE owner_id=? ORDER BY created_at DESC LIMIT 20').all(ownerId);
  }

  update(id, changes) {
    const allowed = ['token_encrypted', 'runtime', 'start_command', 'source_dir', 'status', 'report'];
    for (const [key, value] of Object.entries(changes)) {
      if (!allowed.includes(key)) throw new Error('INVALID_FIELD');
      this.db.sqlite.prepare(`UPDATE custom_projects SET ${key}=? WHERE id=?`).run(value, id);
    }
  }

  async reply(api, chatId, text, options = {}) {
    return api.sendMessage(chatId, text, { parse_mode: 'HTML', ...options });
  }

  async handleCallbackQuery({ callbackQuery, api }) {
    const data = callbackQuery.data || '';
    const chatId = callbackQuery.message?.chat?.id || callbackQuery.from?.id;
    const userId = callbackQuery.from?.id;

    if (!data) return;

    if (data.startsWith('autofix_confirm_')) {
      const projectId = data.replace('autofix_confirm_', '');
      const project = this.get(projectId, userId);
      if (!project) {
        return api.answerCallbackQuery(callbackQuery.id, { text: 'پروژه یافت نشد.' });
      }

      // Charge wallet
      const balance = this.db.getWalletBalance(userId);
      if (balance < this.aiAutoFixFeeToman) {
        await api.answerCallbackQuery(callbackQuery.id, { text: 'موجودی کیف پول کافی نیست.' });
        return this.reply(api, chatId, `موجودی کیف پول شما کافی نیست. هزینه اصلاح خودکار ${this.aiAutoFixFeeToman.toLocaleString('fa-IR')} تومان است. لطفاً ابتدا کیف پول خود را شارژ کنید.`);
      }

      try {
        this.db.chargeWallet(userId, this.aiAutoFixFeeToman, `اصلاح خودکار سورس پروژه ${projectId} با AI`);
        await api.answerCallbackQuery(callbackQuery.id, { text: 'پرداخت انجام شد. در حال تلاش برای اصلاح...' });

        const fixResult = await runAiAutoFix(project.source_dir, { aiClient: this.aiClient });
        if (fixResult.success) {
          return this.reply(api, chatId, `<b>اصلاح خودکار انجام شد:</b>\n${escapeHtml(fixResult.message)}\n\nبرای ارزیابی مجدد سورس، دستور <code>/source_run ${projectId}</code> یا ارسال ZIP جدید اقدام کنید.`);
        } else {
          return this.reply(api, chatId, `<b>نتیجه اصلاح خودکار:</b>\n${escapeHtml(fixResult.message)}`);
        }
      } catch (err) {
        return this.reply(api, chatId, `خطا در فرایند پرداخت یا اصلاح: ${escapeHtml(err.message)}`);
      }
    }

    if (data.startsWith('autofix_cancel_')) {
      await api.answerCallbackQuery(callbackQuery.id, { text: 'عملیات لغو شد.' });
      return this.reply(api, chatId, 'عملیات اصلاح خودکار لغو شد.');
    }

    if (data.startsWith('autofix_')) {
      const projectId = data.replace('autofix_', '');
      await api.answerCallbackQuery(callbackQuery.id);
      return this.reply(api, chatId, `<b>🤖 اصلاح خودکار با AI (هزینه‌‌ای)</b>\n\nاین قابلیت شامل هزینه غیرقابل بازگشت <b>${this.aiAutoFixFeeToman.toLocaleString('fa-IR')} تومان</b> از کیف پول شما می‌باشد.\nهیچ تضمینی برای برطرف شدن کامل همه خطاها وجود ندارد.\nآیا تایید می‌کنید؟`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ تایید و پرداخت', callback_data: `autofix_confirm_${projectId}` },
              { text: '❌ انصراف', callback_data: `autofix_cancel_${projectId}` }
            ]
          ]
        }
      });
    }

    if (data.startsWith('admin_approve_')) {
      if (!this.isAdmin(userId)) {
        return api.answerCallbackQuery(callbackQuery.id, { text: 'دسترسی غیرمجاز.' });
      }
      const projectId = data.replace('admin_approve_', '');
      const project = this.db.sqlite.prepare('SELECT * FROM custom_projects WHERE id=?').get(projectId);
      if (!project) return api.answerCallbackQuery(callbackQuery.id, { text: 'پروژه یافت نشد.' });

      this.update(projectId, { status: 'approved' });
      await api.answerCallbackQuery(callbackQuery.id, { text: 'پروژه تأیید شد.' });
      await this.reply(api, chatId, `پروژه <code>${projectId}</code> با موفقیت توسط شما تأیید شد.`);

      // Notify owner
      await this.reply(api, project.owner_id, `<b>✅ پروژه شما تأیید شد!</b>\nپروژه سورس اختصاصی <code>${projectId}</code> توسط مدیر سیستم تأیید گردید. اکنون می‌توانید آن را اجرا کنید:\n<code>/source_run ${projectId}</code>`);
      return;
    }

    if (data.startsWith('admin_reject_')) {
      if (!this.isAdmin(userId)) {
        return api.answerCallbackQuery(callbackQuery.id, { text: 'دسترسی غیرمجاز.' });
      }
      const projectId = data.replace('admin_reject_', '');
      const project = this.db.sqlite.prepare('SELECT * FROM custom_projects WHERE id=?').get(projectId);
      if (!project) return api.answerCallbackQuery(callbackQuery.id, { text: 'پروژه یافت نشد.' });

      this.update(projectId, { status: 'rejected' });
      await api.answerCallbackQuery(callbackQuery.id, { text: 'پروژه رد شد.' });
      await this.reply(api, chatId, `پروژه <code>${projectId}</code> رد شد.`);

      // Notify owner
      await this.reply(api, project.owner_id, `<b>❌ پروژه شما رد شد.</b>\nپروژه سورس اختصاصی <code>${projectId}</code> توسط مدیر رد گردید. لطفاً تغییرات لازم را در کد اعمال کرده و مجدداً ارسال کنید.`);
      return;
    }
  }

  async handle({ message, api, userId, chatId }) {
    // Handling callback query if passed inside update object
    if (message && message.callback_query) {
      return this.handleCallbackQuery({ callbackQuery: message.callback_query, api });
    }

    if (chatId !== userId) return this.reply(api, chatId, 'سورس را فقط در گفتگوی خصوصی بفرستید.');
    const text = (message.text || '').trim();
    const state = this.states.get(userId);

    if (text === '/source' || text === '/source_help' || text === SOURCE_MENU_LABEL) {
      const feeStr = this.customSourceFeeToman.toLocaleString('fa-IR');
      const fixFeeStr = this.aiAutoFixFeeToman.toLocaleString('fa-IR');
      const infoMsg = '🧪 <b>سورس اختصاصی چیست؟</b>\n'
        + 'با این قابلیت می‌توانید پروژه ربات شخصی خودتان (Node.js یا Python) را ارسال کنید تا به‌صورت ایزوله و امن روی سرور ما اجرا و میزبانی شود؛ بدون نگرانی درباره سرور، دیتابیس یا امنیت آن.\n\n'
        + '⚙️ <b>نحوه کار:</b>\n'
        + '1. فایل ZIP پروژه را ارسال می‌کنید (حداکثر ۱۰ مگابایت)\n'
        + '2. باید حاوی فایل manifest.json یا botmaker.json باشد:\n<code>{"runtime":"node20","start":"node index.js"}</code>\n(یا runtime: python311)\n'
        + '3. بررسی خودکار ساختار پروژه\n'
        + '4. اسکن امنیتی خودکار\n'
        + '5. اسکن باگ با هوش مصنوعی\n'
        + '6. تأیید نهایی و دستی توسط ادمین\n'
        + '7. اجرای پروژه داخل کانتینر ایزوله (gVisor) با مانیتورینگ امنیتی زنده (Falco)\n\n'
        + '📜 <b>قوانین و نکات مهم:</b>\n'
        + '• فقط فایل ZIP، حداکثر ۱۰ مگابایت\n'
        + '• رانتایم مجاز: Node.js 20 یا Python 3.11\n'
        + '• دستورات و فلگ‌های خطرناک (eval، exec غیرمجاز، دسترسی خام شبکه و...) در بررسی رد می‌شوند\n'
        + '• اگر باگ یا ایراد امنیتی پیدا شود، رفعِ رایگان وجود ندارد؛ باید خودتان اصلاح کنید\n'
        + `• گزینه اختیاری «اصلاح خودکار با AI» با هزینه جدا (${fixFeeStr} تومان) موجود است — بدون تضمین رفع کامل\n`
        + '• در صورت رفتار مشکوک یا نقض امنیتی حین اجرا، Falco به‌صورت خودکار کانتینر را متوقف می‌کند و به ادمین اطلاع می‌دهد\n'
        + '• این قابلیت فقط در گفتگوی خصوصی با ربات قابل استفاده است\n\n'
        + `💰 <b>هزینه:</b>\nبررسی و میزبانی هر پروژه ${feeStr} تومان (یک‌بار، از کیف پول کسر می‌شود) — در صورت داشتن پلن حرفه‌ای یا VIP فعال، جزو همان پلن است و هزینه جدایی ندارد.`;

      if (!this.hasPaidAccess(userId)) {
        return this.reply(api, chatId, infoMsg + '\n\n🔒 <b>دسترسی محدود است!</b>\nبرای استفاده باید اشتراک فعال (پلن حرفه‌ای یا VIP) داشته باشید یا کیف پولتان حداقل به اندازه هزینه بالا شارژ باشد. ابتدا نسبت به خرید اشتراک یا شارژ کیف پول اقدام کنید، سپس دوباره /source را بزنید.');
      }
      this.states.set(userId, { step: 'zip' });
      return this.reply(api, chatId, infoMsg + '\n\n✅ شرایط لازم را دارید. فایل ZIP پروژه خود را همین حالا ارسال کنید (می‌توانید توضیحات پروژه را در caption فایل بنویسید).');
    }

    if (message.document && (state?.step === 'zip' || this.hasPaidAccess(userId))) {
      return this.receiveZip({ message, api, userId, chatId });
    }

    if (message.document && !this.hasPaidAccess(userId)) {
      return this.reply(api, chatId, '<b>دسترسی محدود است!</b>\nارسال سورس اختصاصی نیاز به داشتن اشتراک فعال (پلن حرفه‌ای یا VIP) یا شارژ کافی در کیف پول دارد. برای توضیحات کامل و شرایط استفاده، دستور /source را بزنید.');
    }

    if (state?.step === 'token' && text && !text.startsWith('/')) {
      return this.receiveToken({ message, api, userId, chatId, projectId: state.projectId });
    }

    if (text === '/sources') {
      const rows = this.list(userId);
      return this.reply(api, chatId, rows.length ? rows.map(r => `<code>${r.id}</code> | ${escapeHtml(r.status)} | ${escapeHtml(r.runtime || 'نامشخص')}`).join('\n') : 'هنوز سورسی ثبت نشده است. /source');
    }

    const parts = text.split(/\s+/);
    const cmd = parts[0];
    const id = parts[1];

    if (!['/source_run', '/source_stop', '/source_restart', '/source_logs', '/source_status', '/source_rewrite', '/source_rewrite_confirm', '/source_use_candidate', '/source_delete'].includes(cmd)) {
      return this.reply(api, chatId, 'دستور نامعتبر است. /source_help');
    }

    const project = this.get(id, userId);
    if (!project) return this.reply(api, chatId, 'شناسه پروژه یافت نشد. /sources');

    try {
      if (cmd === '/source_status') {
        return this.reply(api, chatId, `<code>${id}</code> | وضعیت: <b>${escapeHtml(project.status)}</b>\n<pre>${escapeHtml(project.report.slice(0, 1700))}</pre>`);
      }

      if (cmd === '/source_logs') {
        const logs = await this.runner.logs({ botId: id });
        return this.reply(api, chatId, `<pre>${escapeHtml(String(logs?.logs || logs).slice(-3000))}</pre>`);
      }

      if (cmd === '/source_stop') {
        await this.runner.stop({ botId: id });
        this.update(id, { status: 'stopped' });
        return this.reply(api, chatId, 'اجرا متوقف شد.');
      }

      if (cmd === '/source_delete') {
        await this.runner.stop({ botId: id });
        this.db.sqlite.prepare('DELETE FROM custom_projects WHERE id=? AND owner_id=?').run(id, userId);
        cleanupExtractedSource(path.dirname(project.source_dir));
        return this.reply(api, chatId, 'پروژه حذف شد.');
      }

      if (cmd === '/source_run' || cmd === '/source_restart') {
        if (project.status === 'pending_admin_approval') {
          return this.reply(api, chatId, '<b>پروژه در انتظار تأیید مدیر است.</b>\nپس از بررسی و تأیید نهایی توسط مدیر سیستم، امکان اجرا وجود خواهد داشت.');
        }
        if (project.status === 'rejected') {
          return this.reply(api, chatId, '<b>پروژه توسط مدیر رد شده است.</b>\nلطفاً کد را اصلاح کرده و نسخه جدید ارسال نمایید.');
        }
        if (project.status !== 'approved' && project.status !== 'running' && project.status !== 'ready' && project.status !== 'stopped') {
          return this.reply(api, chatId, `امکان اجرای پروژه در وضعیت ${escapeHtml(project.status)} وجود ندارد.`);
        }

        if (!project.token_encrypted) {
          return this.reply(api, chatId, 'توکن ربات ثبت نشده است.');
        }

        // Check gVisor availability before start
        const gvisor = this.config.skipGvisorCheck ? { available: true } : await checkGvisorAvailable();
        if (!gvisor.available) {
          if (this.config.admin_id) {
            await this.reply(api, this.config.admin_id, `<b>⚠️ خطای حیاتی gVisor:</b>\nمحیط ران‌تایم امن gVisor در سیستم در دسترس نیست (${escapeHtml(gvisor.reason)}). اجرای سورس <code>${id}</code> متوقف شد.`);
          }
          return this.reply(api, chatId, `<b>خطا در اجرا:</b> محیط امنیتی gVisor (runsc) در سرور در دسترس نیست.`);
        }

        if (cmd === '/source_restart') await this.runner.stop({ botId: id });
        const sourceToken = decryptToken(project.token_encrypted, this.config.encryption_key);

        try {
          const result = await this.runner.start({
            botId: id,
            sourceDir: project.source_dir,
            manifest: { runtime: project.runtime, startCommand: project.start_command },
            telegramToken: sourceToken
          });

          await require('../telegram').deleteWebhook(sourceToken, { mock: this.config.mock_telegram }).catch(() => {});
          if (!this.config.skipSleep) {
            await new Promise(resolve => setTimeout(resolve, 700));
          }

          const actual = this.runner.status ? await this.runner.status({ botId: id }) : { running: true };
          this.update(id, { status: actual.running ? 'running' : 'failed' });

          if (!actual.running) {
            const logs = await this.runner.logs({ botId: id }).catch(() => ({ logs: '' }));
            const classified = classifyRuntimeError(logs.logs || 'Container stopped immediately');

            if (classified.cause === 'source') {
              return this.reply(api, chatId, `<b>خطای اجرا در سورس شما:</b>\nپروژه بلافاصله متوقف شد. لطفاً کد خود را اصلاح کرده و مجدداً ارسال کنید.\n<pre>${escapeHtml(String(logs.logs).slice(-1500))}</pre>`);
            } else {
              if (classified.requiresSecurityReview && this.config.admin_id) {
                await this.reply(api, this.config.admin_id, `<b>🚨 هشدار خطای سیستمی همراه با ریسک امنیتی:</b>\nپروژه: <code>${id}</code>\nجزئیات: <pre>${escapeHtml(String(logs.logs).slice(-1500))}</pre>`);
              }
              return this.reply(api, chatId, `<b>خطای سیستمی میزبان:</b>\nخطا در سرور رخ داده است و برای بررسی به مدیر ارجاع شد.`);
            }
          }

          return this.reply(api, chatId, `اجرای سورس با موفقیت شروع شد. <code>${id}</code>\n/source_logs ${id}`);
        } catch (err) {
          const classified = classifyRuntimeError(err.message);
          if (classified.cause === 'source') {
            return this.reply(api, chatId, `<b>خطای سورس:</b> ${escapeHtml(err.message)}\nلطفاً سورس خود را اصلاح کرده و مجدداً ارسال کنید.`);
          } else {
            if (classified.requiresSecurityReview && this.config.admin_id) {
              await this.reply(api, this.config.admin_id, `<b>🚨 هشدار خطای میزبان/امنیتی:</b>\nپروژه: <code>${id}</code>\nخطا: ${escapeHtml(err.message)}`);
            }
            return this.reply(api, chatId, `<b>خطای میزبان:</b> ${escapeHtml(err.message)}`);
          }
        }
      }

      if (cmd === '/source_rewrite') {
        this.states.set(userId, { step: 'rewrite_consent', projectId: id });
        return this.reply(api, chatId, `<b>تأیید ارسال کد به سرویس هوش مصنوعی</b>\nبرای بازنویسی، فایل‌های متنی پروژه به ارائه‌دهنده خارجی AI فرستاده می‌شوند. اگر موافقید بفرستید: <code>/source_rewrite_confirm ${id}</code>`);
      }

      if (cmd === '/source_rewrite_confirm') {
        if (state?.step !== 'rewrite_consent' || state.projectId !== id) return this.reply(api, chatId, 'ابتدا /source_rewrite را بفرستید.');
        this.states.delete(userId);
        const result = await this.rewriter(project.source_dir, { targetRuntime: 'node20', optIn: true, consent: true });
        const candidate = path.join(path.dirname(project.source_dir), 'candidate');
        fs.rmSync(candidate, { recursive: true, force: true });
        fs.mkdirSync(candidate, { recursive: true });
        for (const { path: name, content } of (result.candidateFiles || [])) {
          if (!/^[\w./-]+$/.test(name) || name.split('/').includes('..') || path.isAbsolute(name)) throw new Error('INVALID_CANDIDATE_PATH');
          const dest = path.resolve(candidate, name);
          if (!dest.startsWith(candidate + path.sep)) throw new Error('INVALID_CANDIDATE_PATH');
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, String(content), { flag: 'wx' });
        }
        const assessment = validateManifestAndStartCommand(candidate);
        this.update(id, { report: JSON.stringify({ candidate: assessment.valid, errors: assessment.errors || [], warnings: assessment.warnings || [] }) });
        return this.reply(api, chatId, assessment.valid ? `نسخه پیشنهادی ساخته شد؛ برای جایگزینی: <code>/source_use_candidate ${id}</code>` : `نسخه پیشنهادی قابل اجرا نیست: ${escapeHtml((assessment.errors || []).join('; ').slice(0, 1500))}`);
      }

      if (cmd === '/source_use_candidate') {
        const candidate = path.join(path.dirname(project.source_dir), 'candidate');
        const check = validateManifestAndStartCommand(candidate);
        if (!check.valid) return this.reply(api, chatId, 'نسخه پیشنهادی تست ساختار را رد کرد.');
        await this.runner.stop({ botId: id });
        this.update(id, { source_dir: candidate, runtime: check.runtime, start_command: check.startCommand, status: 'ready' });
        return this.reply(api, chatId, `نسخه پیشنهادی انتخاب شد. برای اجرا: <code>/source_run ${id}</code>`);
      }
    } catch (err) {
      return this.reply(api, chatId, `عملیات انجام نشد: ${escapeHtml(String(err.message).slice(0, 300))}`);
    }
  }

  async receiveZip({ message, api, userId, chatId }) {
    // 1. PAYMENT GATE CHECK FIRST (before any ZIP download, validation or scanning)
    if (!this.hasPaidAccess(userId)) {
      return this.reply(api, chatId, '<b>دسترسی محدود است!</b>\nارسال سورس اختصاصی نیاز به داشتن اشتراک فعال (پلن حرفه‌ای یا VIP) یا شارژ کافی در کیف پول دارد. برای توضیحات کامل و شرایط استفاده، دستور /source را بزنید.');
    }

    if (!/\.zip$/i.test(message.document.file_name || '') || message.document.file_size > 10 * 1024 * 1024) {
      return this.reply(api, chatId, 'فقط ZIP حداکثر ۱۰ مگابایت پذیرفته است.');
    }

    // Deduct wallet fee if user is on free plan but had sufficient wallet balance
    if (!this.isAdmin(userId)) {
      const user = this.db.getUser(userId);
      if (!user.plan_id || user.plan_id === 'free' || (user.plan_expires_at && new Date(user.plan_expires_at) <= new Date())) {
        this.db.chargeWallet(userId, this.customSourceFeeToman, 'هزینه بررسی و میزبانی سورس اختصاصی');
      }
    }

    const id = 'src_' + crypto.randomBytes(8).toString('hex');
    const root = path.join(this.root, id);
    const sourceDir = path.join(root, 'original');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });

    try {
      const description = message.caption || message.text || 'بدون توضیح';

      // 2. ADMIN NOTIFICATION ON SUBMISSION (in parallel / immediately)
      if (this.config.admin_id) {
        const userObj = message.from || {};
        const userInfo = `کاربر: <code>${userId}</code> (${escapeHtml(userObj.username ? '@' + userObj.username : 'بدون نام‌کاربری')})`;
        const descInfo = `توضیحات: <b>${escapeHtml(description)}</b>`;
        const adminMsg = `<b>📥 دریافت سورس اختصاصی جدید</b>\nکد سورس: <code>${id}</code>\n${userInfo}\n${descInfo}`;

        // Relay to admin in parallel
        Promise.resolve().then(async () => {
          try {
            await api.sendMessage(this.config.admin_id, adminMsg, { parse_mode: 'HTML' });
            if (message.document?.file_id) {
              await api.sendDocument(this.config.admin_id, message.document.file_id, { caption: `فایل ZIP سورس ${id}` }).catch(() => {});
            }
          } catch (e) {
            console.error('Failed to notify admin on submission:', e);
          }
        });
      }

      // 3. PIPELINE STEP (a): Language / Runtime + Structural Validation
      const content = await this.downloadFile(this.config.control_bot_token, message.document.file_id, 10 * 1024 * 1024, { mock: this.config.mock_telegram });
      const archive = await validateUploadArchive(content, { targetDir: sourceDir });
      if (!archive.valid) {
        cleanupExtractedSource(root);
        const issues = (archive.errors || []).map(e => `• ${escapeHtml(e)}`).join('\n');
        return this.reply(api, chatId, `<b>❌ خطای ساختاری فایل ZIP:</b>\n${issues}\n\nلطفاً سورس خود را اصلاح کرده و مجدداً ارسال کنید.`);
      }

      const manifest = validateManifestAndStartCommand(sourceDir);
      if (!manifest.valid) {
        cleanupExtractedSource(root);
        const issues = (manifest.errors || []).map(e => `• ${escapeHtml(e)}`).join('\n');
        return this.reply(api, chatId, `<b>❌ خطای فایل تنظیمات (manifest):</b>\n${issues}\n\nلطفاً سورس خود را اصلاح کرده و مجدداً ارسال کنید.`);
      }

      // 3. PIPELINE STEP (b): SECURITY SCAN FIRST (Static + AI Security)
      const staticResult = runStaticAnalysis(sourceDir);
      const aiSecResult = await runAiSecurityReview(sourceDir, { aiClient: this.aiClient });

      const secIssues = [
        ...(staticResult.errors || []),
        ...(aiSecResult.issues || [])
      ];

      if (!aiSecResult.passed || secIssues.length > 0) {
        cleanupExtractedSource(root);
        const issueBullets = secIssues.map(i => `• ${escapeHtml(i)}`).join('\n');
        return this.reply(api, chatId, `<b>🚨 خطاهای امنیتی شناسایی شد:</b>\n${issueBullets}\n\nلطفاً سورس خود را اصلاح کرده و مجدداً ارسال کنید.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🤖 اصلاح خودکار با AI (هزینه‌‌ای)', callback_data: `autofix_${id}` }]
            ]
          }
        });
      }

      // 3. PIPELINE STEP (c): BUG / LOGIC REVIEW PASS
      const aiBugResult = await runAiBugReview(sourceDir, { aiClient: this.aiClient });
      if (!aiBugResult.passed && aiBugResult.issues.length > 0) {
        cleanupExtractedSource(root);
        const bugBullets = aiBugResult.issues.map(b => `• ${escapeHtml(b)}`).join('\n');
        return this.reply(api, chatId, `<b>⚠️ منطق یا سنتکس پروژه دارای خطا است:</b>\n${bugBullets}\n\nلطفاً سورس خود را اصلاح کرده و مجدداً ارسال کنید.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🤖 اصلاح خودکار با AI (هزینه‌‌ای)', callback_data: `autofix_${id}` }]
            ]
          }
        });
      }

      // 5. FINAL ADMIN APPROVAL GATE
      const reportData = {
        errors: [],
        warnings: staticResult.warnings || [],
        runtime: manifest.runtime,
        aiSecurity: aiSecResult,
        aiBug: aiBugResult
      };

      this.db.sqlite.prepare(
        'INSERT INTO custom_projects (id, owner_id, source_dir, runtime, start_command, status, report, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, userId, sourceDir, manifest.runtime, manifest.startCommand, 'pending_admin_approval', JSON.stringify(reportData), new Date().toISOString());

      this.states.set(userId, { step: 'token', projectId: id });

      // Notify admin for approval
      if (this.config.admin_id) {
        const userObj = message.from || {};
        const approvalMsg = `<b>📋 درخواست تأیید اجرای سورس اختصاصی</b>\nکد پروژه: <code>${id}</code>\nکاربر: <code>${userId}</code> (@${escapeHtml(userObj.username || 'نامشخص')})\nزبان/ران‌تایم: <code>${manifest.runtime}</code>\nدستور شروع: <code>${escapeHtml(manifest.startCommand)}</code>\n\nتوضیحات کاربر: ${escapeHtml(description)}\n\nآیا اجرای این پروژه را تأیید می‌کنید؟`;
        await api.sendMessage(this.config.admin_id, approvalMsg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ تأیید اجرا', callback_data: `admin_approve_${id}` },
                { text: '❌ رد یا درخواست اصلاح', callback_data: `admin_reject_${id}` }
              ]
            ]
          }
        }).catch(() => {});
      }

      return this.reply(api, chatId, `سورس <code>${id}</code> با موفقیت بررسی شد و تمامی بررسی‌های امنیتی و فنی را گذراند.\nوضعیت: <b>در انتظار تأیید مدیر</b>\nلطفاً توکن ربات تلگرام اختصاصی خود را جهت ثبت بفرستید.`);
    } catch (err) {
      cleanupExtractedSource(root);
      return this.reply(api, chatId, `بررسی ناموفق: ${escapeHtml(String(err.message).slice(0, 400))}`);
    }
  }

  async receiveToken({ message, api, userId, chatId, projectId }) {
    const token = message.text.trim();
    if (!validateBotToken(token)) return this.reply(api, chatId, 'فرمت توکن درست نیست.');
    try {
      await api.deleteMessage(chatId, message.message_id).catch(() => {});
      const bot = await getMe(token, { mock: this.config.mock_telegram });
      if (!bot?.ok) throw new Error('توکن نزد تلگرام تأیید نشد');

      const exists = this.db.getAllBots().some(b => {
        try {
          return decryptToken(b.token_encrypted, this.config.encryption_key) === token;
        } catch {
          return false;
        }
      });
      if (exists) throw new Error('BOT_ALREADY_MANAGED');

      this.update(projectId, { token_encrypted: encryptToken(token, this.config.encryption_key) });
      this.states.delete(userId);

      const project = this.get(projectId, userId);
      if (project?.status === 'pending_admin_approval') {
        return this.reply(api, chatId, `توکن ثبت شد.\nپروژه <code>${projectId}</code> هم‌اکنون در انتظار تأیید نهایی مدیر سیستم است.`);
      }
      return this.reply(api, chatId, `توکن ثبت شد. برای اجرا: <code>/source_run ${projectId}</code>`);
    } catch {
      return this.reply(api, chatId, 'ثبت توکن انجام نشد.');
    }
  }
}

module.exports = { CustomController };
