'use strict';

/**
 * Bot lifecycle: strict demo-cycle timing + auto-renewals.
 * All functions take `now` (ms epoch) so tests inject time; no real sleeps.
 *
 * Demo cycle (must match spec exactly):
 *  - t+50min: one-time warning notification
 *  - t+60min: grace state (webhook removed, data intact) + 300-min deadline notice
 *  - t+360min (grace_start + 300min): permanent deletion + final notification
 *  - upgrade during warning/grace window -> immediately active on paid plan
 */

const DEMO_MINUTES = 60;
const WARN_MINUTES = 50;
const GRACE_MINUTES = 300;
const MIN = 60 * 1000;

/**
 * Pure state evaluator for a demo bot. Returns the next transition, or null.
 * Used by tick() and directly by tests.
 */
function evaluateDemoBot(bot, now) {
  const started = bot.created_at;
  const elapsedMin = (now - started) / MIN;
  const cfg = bot.config || {};
  if (elapsedMin >= DEMO_MINUTES) {
    if (bot.status === 'grace') {
      const graceElapsed = (now - (cfg.grace_start || started + DEMO_MINUTES * MIN)) / MIN;
      if (graceElapsed >= GRACE_MINUTES) return { type: 'delete', bot };
      return null;
    }
    return { type: 'grace', bot };
  }
  if (elapsedMin >= WARN_MINUTES && !cfg.warned) return { type: 'warn', bot };
  return null;
}

/**
 * Advance lifecycle for all bots. deps = { db, apiFor(bot) -> TelegramApi (mock in tests),
 * publicUrl, notifyOwner(bot, text) }. Returns list of transitions applied.
 */
async function tick(db, deps, now = Date.now()) {
  const transitions = [];
  // demo cycle watches BOTH active free bots and bots already in grace
  const demoBots = [
    ...db.listBotsByStatus('active').filter((b) => b.plan_id === 'free'),
    ...db.listBotsByStatus('grace')
  ];
  for (const bot of demoBots) {
    const t = evaluateDemoBot(bot, now);
    if (!t) continue;
    const api = deps.apiFor(bot);
    if (t.type === 'warn') {
      db.updateBot(bot.id, { config: { warned: true } });
      try {
        await api.sendMessage(bot.owner_id,
          `⚠️ <b>یادآوری انقضای دمو</b>\n\nربات شما <b>@${bot.username || bot.id}</b> تا <b>۱۰ دقیقه</b> دیگر به پایان دموی ۶۰ دقیقه‌ای می‌رسد.\nبرای ادامه استفاده، همین حالا به یکی از پلن‌های پرداختی ارتقا دهید.`,
          { parse_mode: 'HTML' });
      } catch (_) { /* owner may have blocked the bot */ }
      transitions.push({ type: 'warn', botId: bot.id });
    } else if (t.type === 'grace') {
      try { await api.deleteWebhook(); } catch (_) { }
      db.updateBot(bot.id, { status: 'grace', config: { grace_start: now, warned: true } });
      try {
        await api.sendMessage(bot.owner_id,
          `🟠 <b>دموی ربات به پایان رسید</b>\n\nربات <b>@${bot.username || bot.id}</b> اکنون در حالت مهلت (grace) قرار دارد و به کاربران پاسخ نمی‌دهد؛ داده‌های آن حفظ شده است.\n\n⏳ فرصت <b>۳۰۰ دقیقه</b> دارید تا با ارتقا به پلن پرداختی، ربات را فعال کنید؛ در غیر این صورت ربات به‌صورت دائمی حذف خواهد شد.`,
          { parse_mode: 'HTML' });
      } catch (_) { }
      transitions.push({ type: 'grace', botId: bot.id });
    } else if (t.type === 'delete') {
      try { await api.deleteWebhook(); } catch (_) { }
      db.deleteBot(bot.id);
      try {
        await api.sendMessage(bot.owner_id,
          `❌ <b>ربات دائمی حذف شد</b>\n\nمهلت ۳۰۰ دقیقه‌ای ربات <b>@${bot.username || bot.id}</b> بدون ارتقا به پایان رسید و ربات به همراه داده‌هایش برای همیشه حذف شد.\nبرای ساخت ربات جدید از منوی اصلی اقدام کنید.`,
          { parse_mode: 'HTML' });
      } catch (_) { }
      transitions.push({ type: 'delete', botId: bot.id });
    }
  }

  // auto-renewal for paid bots
  const wallet = require('./wallet');
  const paidBots = db.listBotsByStatus('active').filter((b) => b.plan_id !== 'free');
  for (const bot of paidBots) {
    if (!bot.auto_renew || !bot.expires_at || bot.expires_at > now) continue;
    const r = wallet.processRenewal(db, { bot, now });
    if (!r) continue;
    const api = deps.apiFor(bot);
    if (r.action === 'renewed') {
      try { await api.deleteWebhook(); } catch (_) { }
      try {
        await api.setWebhook(`${deps.publicUrl}/webhook/${bot.secret_token}`, bot.secret_token);
      } catch (_) { }
      try {
        await api.sendMessage(bot.owner_id, `✅ تمدید خودکار ربات <b>@${bot.username || bot.id}</b> انجام شد و پلن ${r.plan.name} برای ۳۰ روز تمدید گردید.`, { parse_mode: 'HTML' });
      } catch (_) { }
    } else if (r.action === 'paused_insufficient') {
      try { await api.deleteWebhook(); } catch (_) { }
      try {
        await api.sendMessage(bot.owner_id,
          `⏸ <b>ربات متوقف شد</b>\n\nتمدید خودکار ربات <b>@${bot.username || bot.id}</b> به دلیل <b>کمبود موجودی کیف پول</b> انجام نشد.\nکمبود: <b>${r.shortfall.toLocaleString('fa-IR')}</b> تومان\nبرای فعال‌سازی مجدد، کیف پول را شارژ و از پنل ربات تمدید کنید.`,
          { parse_mode: 'HTML' });
      } catch (_) { }
    }
    transitions.push({ type: r.action, botId: bot.id });
  }
  return transitions;
}

/** Upgrade demo/grace bot to a paid plan: restores active immediately. */
async function upgradeDemoBot(db, { apiFor, publicUrl }, { botId, userId, planId, now = Date.now() }) {
  const wallet = require('./wallet');
  const res = wallet.purchasePlan(db, { userId, botId, planId, now });
  if (!res.ok) return res;
  const bot = db.getBot(botId);
  const api = apiFor(bot);
  try {
    await api.setWebhook(`${publicUrl}/webhook/${bot.secret_token}`, bot.secret_token);
  } catch (_) { }
  try {
    await api.sendMessage(bot.owner_id, `🎉 ارتقا با موفقیت انجام شد! ربات <b>@${bot.username || bot.id}</b> اکنون روی پلن ${res.plan.name} فعال است.`, { parse_mode: 'HTML' });
  } catch (_) { }
  return { ok: true, bot, plan: res.plan };
}

module.exports = { tick, evaluateDemoBot, upgradeDemoBot, DEMO_MINUTES, WARN_MINUTES, GRACE_MINUTES };
