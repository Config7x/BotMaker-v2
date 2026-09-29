'use strict';

const { escapeHtml } = require('./telegram');

/**
 * Runs a single pass of subscription expiration and auto-renewal checks
 */
async function runLifecycleCheck({ db, config = {}, getApi = null, now = new Date() }) {
  const nowIso = now.toISOString();
  const dueBots = db.getDueOrExpiredBots(nowIso);
  const results = {
    renewed: [],
    paused: [],
    errors: []
  };

  for (const bot of dueBots) {
    try {
      const plan = db.getPlanById(bot.plan_id) || db.getPlanById('free');
      const price = plan ? plan.price : 0;
      const durationDays = plan ? plan.duration_days : 30;
      const autoRenew = bot.auto_renew === 1;
      const walletBalance = db.getWalletBalance(bot.owner_id);

      // Determine API handler for user notifications
      let api = null;
      if (typeof getApi === 'function') {
        try { api = getApi(bot.token_encrypted); } catch { api = null; }
      }

      if (price === 0) {
        // Free plan auto-renews
        db.renewBotPlan(bot.id, durationDays);
        results.renewed.push({ botId: bot.id, ownerId: bot.owner_id, price: 0, planId: bot.plan_id });
      } else if (autoRenew && walletBalance >= price) {
        // Auto-renew using wallet balance
        db.chargeWallet(bot.owner_id, price, `تمدید خودکار اشتراک ربات ${bot.username || bot.id}`);
        db.renewBotPlan(bot.id, durationDays);
        results.renewed.push({ botId: bot.id, ownerId: bot.owner_id, price, planId: bot.plan_id });

        if (api) {
          const msg = `❇️ <b>تمدید خودکار ربات</b>\n\nاشتراک ربات <b>${escapeHtml(bot.username || bot.id)}</b> با موفقیت تمدید شد.\nمبلغ <b>${price.toLocaleString('fa-IR')} تومان</b> از موجودی کیف پول شما کسر گردید.`;
          await api.sendMessage(bot.owner_id, msg, { parse_mode: 'HTML' }).catch(() => {});
        }
      } else {
        // Insufficient funds or auto-renew disabled => pause bot
        db.updateBotStatus(bot.id, null, 'paused');
        const reason = !autoRenew ? 'auto_renew_disabled' : 'insufficient_balance';
        results.paused.push({ botId: bot.id, ownerId: bot.owner_id, reason, price });

        if (api) {
          const reasonText = !autoRenew ? 'غیرفعال بودن تمدید خودکار' : 'کافی نبودن موجودی کیف پول';
          const msg = `⚠️ <b>انقضای اشتراک ربات</b>\n\nاعتبار اشتراک ربات <b>${escapeHtml(bot.username || bot.id)}</b> به پایان رسید و ربات به علت ${reasonText} متوقف گردید.\n\nبرای فعال‌سازی مجدد، موجودی کیف پول خود را شارژ کرده و نسبت به تمدید اقدام کنید.`;
          await api.sendMessage(bot.owner_id, msg, { parse_mode: 'HTML' }).catch(() => {});
        }
      }
    } catch (err) {
      results.errors.push({ botId: bot.id, error: err.message });
    }
  }

  return results;
}

/**
 * Starts periodic background lifecycle job
 */
function startLifecycleJob({ db, config = {}, getApi = null, intervalMs = 60000 }) {
  let timer = null;

  const job = async () => {
    try {
      await runLifecycleCheck({ db, config, getApi });
    } catch (e) {
      // background error suppression
    }
  };

  // Run initial check asynchronously
  setImmediate(job);

  timer = setInterval(job, intervalMs);

  return {
    timer,
    stop: () => {
      if (timer) clearInterval(timer);
    },
    checkNow: () => runLifecycleCheck({ db, config, getApi })
  };
}

module.exports = {
  runLifecycleCheck,
  startLifecycleJob
};
