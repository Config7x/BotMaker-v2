'use strict';

/**
 * Wallet: users top up balance first; plan purchases/renewals deduct from it.
 * All amounts are integer Tomans.
 */

function getBalance(db, userId) {
  const u = db.getUser(userId);
  return u ? u.wallet_balance : 0;
}

/** Credit wallet (admin approve of top-up, refunds). Records a transaction. */
function credit(db, userId, amount, type = 'topup', description = '') {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be positive');
  const u = db.upsertUser(userId);
  db.setBalance(userId, u.wallet_balance + Math.floor(amount));
  db.addTransaction(userId, amount, type, description);
  return db.getUser(userId).wallet_balance;
}

/**
 * Debit with explicit shortfall. Never lets balance go negative.
 * Returns { ok, balance } or { ok:false, shortfall }.
 */
function debit(db, userId, amount, type = 'purchase', description = '') {
  const u = db.upsertUser(userId);
  const amt = Math.floor(amount);
  if (u.wallet_balance < amt) {
    return { ok: false, shortfall: amt - u.wallet_balance, balance: u.wallet_balance };
  }
  db.setBalance(userId, u.wallet_balance - amt);
  db.addTransaction(userId, -amt, type, description);
  return { ok: true, balance: db.getUser(userId).wallet_balance };
}

/**
 * Purchase/upgrade a bot's plan from wallet.
 * Returns { ok, bot } | { ok:false, shortfall, plan }.
 */
function purchasePlan(db, { userId, botId, planId, now = Date.now() }) {
  const plan = db.getPlan(planId);
  if (!plan) return { ok: false, reason: 'plan_not_found' };
  if (plan.price > 0) {
    const r = debit(db, userId, plan.price, 'purchase', `خرید پلن ${plan.name} برای ربات ${botId}`);
    if (!r.ok) return { ok: false, shortfall: r.shortfall, plan };
  }
  const bot = db.getBot(botId);
  const expires = plan.duration_days > 0 ? now + plan.duration_days * 24 * 60 * 60 * 1000 : null;
  const patch = { plan_id: planId, expires_at: expires, status: 'active' };
  if (plan.id !== 'free') {
    patch.config = { ...(bot ? bot.config : {}), warned: false, grace_start: null, demo_start: null };
    if (bot && bot.status === 'grace') patch.status = 'active';
  }
  const updated = db.updateBot(botId, patch);
  db.upsertUser(userId, {});
  return { ok: true, bot: updated, plan };
}

/** Auto-renewal decision for a paid bot whose expires_at has passed. */
function processRenewal(db, { bot, now = Date.now() }) {
  if (bot.status !== 'active' || !bot.auto_renew || !bot.expires_at || bot.expires_at > now) return null;
  const plan = db.getPlan(bot.plan_id);
  const owner = db.getUser(bot.owner_id);
  if (!plan || plan.price <= 0) return null;
  const r = debit(db, bot.owner_id, plan.price, 'renew', `تمدید خودکار ربات ${bot.id}`);
  if (r.ok) {
    const renewed = db.updateBot(bot.id, { expires_at: now + plan.duration_days * 24 * 60 * 60 * 1000 });
    return { action: 'renewed', bot: renewed, plan };
  }
  // insufficient balance -> pause with reason
  const paused = db.updateBot(bot.id, { status: 'paused', config: { paused_reason: 'insufficient_balance' } });
  return { action: 'paused_insufficient', bot: paused, shortfall: r.shortfall, plan };
}

module.exports = { getBalance, credit, debit, purchasePlan, processRenewal };
