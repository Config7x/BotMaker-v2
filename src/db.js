'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Derives a 32-byte Key Buffer from input string
 */
function deriveKey(rawKey) {
  if (!rawKey || String(rawKey).length < 32) throw new Error('ENCRYPTION_KEY must have at least 32 characters');
  return crypto.createHash('sha256').update(String(rawKey)).digest();
}

/**
 * Validates Telegram BotFather Token format
 */
function validateBotToken(token) {
  if (typeof token !== 'string') return false;
  return /^\d+:[A-Za-z0-9_-]{30,}$/.test(token.trim());
}

/**
 * Encrypts bot token at rest using AES-256-GCM
 */
function encryptToken(token, rawKey) {
  const keyBuffer = deriveKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts token at rest using AES-256-GCM
 */
function decryptToken(encryptedString, rawKey) {
  if (!encryptedString || !encryptedString.includes(':')) {
    throw new Error('Invalid encrypted token format');
  }
  const keyBuffer = deriveKey(rawKey);
  const parts = encryptedString.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted payload');
  }
  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

class BotDb {
  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.sqlite = new Database(dbPath);
    this.initTables();
  }

  initTables() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id INTEGER PRIMARY KEY,
        role TEXT DEFAULT 'user',
        wallet_balance REAL DEFAULT 0,
        plan_id TEXT DEFAULT 'free',
        plan_expires_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price REAL NOT NULL,
        max_bots INTEGER NOT NULL,
        duration_days INTEGER NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL,
        token_encrypted TEXT NOT NULL,
        secret_token TEXT NOT NULL UNIQUE,
        username TEXT,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        config TEXT DEFAULT '{}',
        plan_id TEXT DEFAULT 'free',
        expires_at TEXT,
        auto_renew INTEGER DEFAULT 1,
        last_renewed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        demo_started_at TEXT,
        demo_warned INTEGER DEFAULT 0,
        grace_expires_at TEXT,
        FOREIGN KEY (owner_id) REFERENCES users(telegram_id)
      );

      CREATE TABLE IF NOT EXISTS demo_usage (
        user_id INTEGER NOT NULL,
        template_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, template_id)
      );

      CREATE TABLE IF NOT EXISTS update_receipts (
        bot_id TEXT NOT NULL,
        update_id INTEGER NOT NULL,
        PRIMARY KEY(bot_id, update_id)
      );

      CREATE TABLE IF NOT EXISTS bot_kv (
        bot_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (bot_id, key)
      );

      CREATE TABLE IF NOT EXISTS bot_collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        collection TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wallet_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        amount REAL NOT NULL,
        type TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'completed',
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(telegram_id)
      );

      CREATE TABLE IF NOT EXISTS support_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        bot_id TEXT,
        subject TEXT NOT NULL,
        status TEXT DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      
      CREATE TABLE IF NOT EXISTS custom_projects (
        id TEXT PRIMARY KEY,
        owner_id INTEGER NOT NULL,
        source_dir TEXT NOT NULL,
        token_encrypted TEXT,
        runtime TEXT,
        start_command TEXT,
        status TEXT NOT NULL,
        report TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
  
      CREATE TABLE IF NOT EXISTS containers (
        bot_id TEXT PRIMARY KEY,
        container_name TEXT NOT NULL,
        image TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ticket_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        sender_id INTEGER NOT NULL,
        sender_role TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (ticket_id) REFERENCES support_tickets(id)
      );
    `);

    // Dynamic column migration check for existing sqlite files
    const userCols = this.sqlite.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    if (!userCols.includes('wallet_balance')) {
      this.sqlite.exec("ALTER TABLE users ADD COLUMN wallet_balance REAL DEFAULT 0");
    }
    if (!userCols.includes('plan_id')) {
      this.sqlite.exec("ALTER TABLE users ADD COLUMN plan_id TEXT DEFAULT 'free'");
    }
    if (!userCols.includes('plan_expires_at')) {
      this.sqlite.exec("ALTER TABLE users ADD COLUMN plan_expires_at TEXT");
    }

    const botCols = this.sqlite.prepare("PRAGMA table_info(bots)").all().map(c => c.name);
    if (!botCols.includes('plan_id')) {
      this.sqlite.exec("ALTER TABLE bots ADD COLUMN plan_id TEXT DEFAULT 'free'");
    }
    if (!botCols.includes('expires_at')) {
      this.sqlite.exec("ALTER TABLE bots ADD COLUMN expires_at TEXT");
    }
    if (!botCols.includes('auto_renew')) {
      this.sqlite.exec("ALTER TABLE bots ADD COLUMN auto_renew INTEGER DEFAULT 1");
    }
    if (!botCols.includes('last_renewed_at')) {
      this.sqlite.exec("ALTER TABLE bots ADD COLUMN last_renewed_at TEXT");
    }
    if (!botCols.includes('demo_started_at')) {
      this.sqlite.exec("ALTER TABLE bots ADD COLUMN demo_started_at TEXT");
    }
    if (!botCols.includes('demo_warned')) {
      this.sqlite.exec("ALTER TABLE bots ADD COLUMN demo_warned INTEGER DEFAULT 0");
    }
    if (!botCols.includes('grace_expires_at')) {
      this.sqlite.exec("ALTER TABLE bots ADD COLUMN grace_expires_at TEXT");
    }

    // Seed default plans if empty
    const planCount = this.sqlite.prepare("SELECT COUNT(*) as count FROM plans").get().count;
    if (planCount === 0) {
      const stmt = this.sqlite.prepare(`
        INSERT INTO plans (id, name, price, max_bots, duration_days, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      stmt.run('free', 'رایگان دمو', 0, 1, 0, 'دموی ۱ ساعته رایگان تک‌بار برای هر قالب', now);
      stmt.run('pro', 'حرفه‌ای', 100000, 5, 30, 'پلن حرفه‌ای (۵ ربات - ۱۰۰,۰۰۰ تومان/ماه)', now);
      stmt.run('vip', 'ویژه VIP', 250000, 15, 30, 'پلن ویژه (۱۵ ربات - ۲۵۰,۰۰۰ تومان/ماه)', now);
    }
  }

  close() {
    if (this.sqlite) {
      this.sqlite.close();
    }
  }

  // --- Demo Usage Helpers ---

  hasUserDemoedTemplate(userId, templateId) {
    const row = this.sqlite.prepare('SELECT 1 FROM demo_usage WHERE user_id = ? AND template_id = ?').get(userId, templateId);
    return !!row;
  }

  recordUserDemo(userId, templateId, nowIso = new Date().toISOString()) {
    this.sqlite.prepare('INSERT OR IGNORE INTO demo_usage (user_id, template_id, created_at) VALUES (?, ?, ?)').run(userId, templateId, nowIso);
  }

  getUserDemoTemplates(userId) {
    return this.sqlite.prepare('SELECT template_id FROM demo_usage WHERE user_id = ?').all(userId).map(r => r.template_id);
  }

  createUser(telegramId, role = "user") {
    return this.registerUser(telegramId, role);
  }

  registerUser(telegramId, role = 'user') {
    const existing = this.sqlite.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
    if (!existing) {
      const stmt = this.sqlite.prepare("INSERT INTO users (telegram_id, role, wallet_balance, plan_id, created_at) VALUES (?, ?, 0, 'free', ?)");
      stmt.run(telegramId, role, new Date().toISOString());
    } else if (role !== existing.role) {
      const stmt = this.sqlite.prepare('UPDATE users SET role = ? WHERE telegram_id = ?');
      stmt.run(role, telegramId);
    }
    return this.getUser(telegramId);
  }

  getUser(telegramId) {
    return this.sqlite.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) || null;
  }

  getBotCountForUser(telegramId) {
    const res = this.sqlite.prepare("SELECT COUNT(*) as count FROM bots WHERE owner_id = ? AND status != 'deleted'").get(telegramId);
    return res ? res.count : 0;
  }

  createBot({ ownerId, token, username = null, templateId = 'shop', planId = 'free', secretToken = null, encryptionKey = null, maxBotsPerUser = 3, now = new Date() }) {
    if (!validateBotToken(token)) {
      throw new Error('TOKEN_INVALID: Invalid Telegram Bot Token format');
    }

    this.registerUser(ownerId);
    // A BotFather token can have only one webhook. Reject duplicate ownership claims.
    const existing = this.sqlite.prepare("SELECT token_encrypted FROM bots WHERE status != 'deleted'").all();
    if (existing.some(row => { try { return crypto.timingSafeEqual(Buffer.from(decryptToken(row.token_encrypted, encryptionKey)), Buffer.from(token.trim())); } catch { return false; } })) throw new Error('TOKEN_ALREADY_REGISTERED');

    const currentCount = this.getBotCountForUser(ownerId);
    if (maxBotsPerUser > 0 && currentCount >= maxBotsPerUser) {
      throw new Error(`QUOTA_EXCEEDED: Maximum allowed bots per user is ${maxBotsPerUser}`);
    }

    if (planId === 'free' && this.hasUserDemoedTemplate(ownerId, templateId)) {
      throw new Error('DEMO_ALREADY_USED: Free demo plan can only be used once per template type');
    }

    const botId = 'bot_' + crypto.randomBytes(8).toString('hex');
    const tokenEncrypted = encryptToken(token.trim(), encryptionKey);
    const finalSecretToken = secretToken || crypto.randomBytes(16).toString('hex');
    const nowObj = (now instanceof Date) ? now : new Date(now);
    const nowIso = nowObj.toISOString();

    let expiresAt;
    let demoStartedAt = null;

    if (planId === 'free') {
      // 60-minute demo duration
      expiresAt = new Date(nowObj.getTime() + 60 * 60 * 1000).toISOString();
      demoStartedAt = nowIso;
      this.recordUserDemo(ownerId, templateId, nowIso);
    } else {
      const plan = this.getPlanById(planId);
      const durationDays = plan ? plan.duration_days : 30;
      expiresAt = new Date(nowObj.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    }

    const stmt = this.sqlite.prepare(`
      INSERT INTO bots (id, owner_id, token_encrypted, secret_token, username, template_id, status, config, plan_id, expires_at, auto_renew, last_renewed_at, created_at, updated_at, demo_started_at, demo_warned, grace_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', '{}', ?, ?, 1, ?, ?, ?, ?, 0, NULL)
    `);

    stmt.run(botId, ownerId, tokenEncrypted, finalSecretToken, username, templateId, planId, expiresAt, nowIso, nowIso, nowIso, demoStartedAt);

    return this.getBotById(botId);
  }

  claimUpdate(botId, updateId) {
    return this.sqlite.prepare('INSERT OR IGNORE INTO update_receipts (bot_id,update_id) VALUES (?,?)').run(botId,updateId).changes === 1;
  }

  releaseUpdate(botId, updateId) {
    this.sqlite.prepare('DELETE FROM update_receipts WHERE bot_id=? AND update_id=?').run(botId,updateId);
  }

  getControlBot() {
    return this.sqlite.prepare("SELECT * FROM bots WHERE template_id = 'control' AND status = 'active' ORDER BY created_at DESC LIMIT 1").get() || null;
  }

  getBotById(botId) {
    return this.sqlite.prepare('SELECT * FROM bots WHERE id = ?').get(botId) || null;
  }

  getBotBySecretToken(secretToken) {
    if (!secretToken) return null;
    return this.sqlite.prepare('SELECT * FROM bots WHERE secret_token = ?').get(secretToken) || null;
  }

  getUserBots(ownerId) {
    return this.sqlite.prepare("SELECT * FROM bots WHERE owner_id = ? AND status != 'deleted' ORDER BY created_at DESC").all(ownerId);
  }

  getAllBots() {
    return this.sqlite.prepare("SELECT * FROM bots WHERE status != 'deleted' ORDER BY created_at DESC").all();
  }

  updateBotStatus(botId, ownerId, status) {
    const validStatuses = ['active', 'paused', 'expired', 'grace', 'deleted'];
    if (!validStatuses.includes(status)) {
      throw new Error('INVALID_STATUS');
    }

    const bot = this.getBotById(botId);
    if (!bot) {
      throw new Error('BOT_NOT_FOUND');
    }

    if (ownerId !== null && ownerId !== undefined && bot.owner_id !== ownerId) {
      throw new Error('UNAUTHORIZED');
    }

    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare('UPDATE bots SET status = ?, updated_at = ? WHERE id = ?');
    stmt.run(status, now, botId);

    return this.getBotById(botId);
  }

  updateBotTemplate(botId, ownerId, templateId) {
    const bot = this.getBotById(botId);
    if (!bot) throw new Error('BOT_NOT_FOUND');
    if (ownerId !== null && ownerId !== undefined && bot.owner_id !== ownerId) {
      throw new Error('UNAUTHORIZED');
    }

    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare('UPDATE bots SET template_id = ?, updated_at = ? WHERE id = ?');
    stmt.run(templateId, now, botId);

    return this.getBotById(botId);
  }

  deleteBot(botId, ownerId) {
    return this.updateBotStatus(botId, ownerId, 'deleted');
  }

  // --- Wallet Helpers ---

  // -------- containerized templates (§3.10-11) --------
  upsertContainer(rec) {
    const now = Date.now();
    this.sqlite.prepare(`INSERT INTO containers (bot_id, container_name, image, status, created_at, updated_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(bot_id) DO UPDATE SET container_name=excluded.container_name,
        image=excluded.image, status=excluded.status, updated_at=excluded.updated_at`)
      .run(rec.bot_id, rec.container_name, rec.image, rec.status || 'provisioning', now, now);
    return this.getContainer(rec.bot_id);
  }

  getContainer(botId) {
    return this.sqlite.prepare('SELECT * FROM containers WHERE bot_id=?').get(botId) || null;
  }

  updateContainer(botId, patch) {
    const c = this.getContainer(botId);
    if (!c) return null;
    this.sqlite.prepare('UPDATE containers SET status=?, updated_at=? WHERE bot_id=?')
      .run(patch.status ?? c.status, Date.now(), botId);
    return this.getContainer(botId);
  }

  deleteContainer(botId) {
    this.sqlite.prepare('DELETE FROM containers WHERE bot_id=?').run(botId);
  }

  /** Merge-style bot record update (config/status) for containerized bots.
   *  Returns the record with config parsed into an object. */
  updateBotRecord(botId, patch) {
    const cur = this.getBotById(botId);
    if (!cur) return null;
    let curConfig = {};
    if (typeof cur.config === 'string' && cur.config) {
      try { curConfig = JSON.parse(cur.config) || {}; } catch { curConfig = {}; }
    } else if (cur.config && typeof cur.config === 'object') {
      curConfig = cur.config;
    }
    if (patch.config) {
      this.sqlite.prepare('UPDATE bots SET config=?, updated_at=? WHERE id=?')
        .run(JSON.stringify({ ...curConfig, ...patch.config }), new Date().toISOString(), botId);
    }
    if (patch.status) {
      this.sqlite.prepare('UPDATE bots SET status=?, updated_at=? WHERE id=?')
        .run(patch.status, new Date().toISOString(), botId);
    }
    const updated = this.getBotById(botId);
    if (updated && typeof updated.config === 'string' && updated.config) {
      try { updated.config = JSON.parse(updated.config); } catch { /* keep raw */ }
    }
    return updated;
  }

  getWalletBalance(telegramId) {
    const user = this.getUser(telegramId);
    return user ? (user.wallet_balance || 0) : 0;
  }

  depositWallet(telegramId, amount, description = "") {
    return this.addWalletBalance(telegramId, amount, "deposit", description);
  }

  addWalletBalance(telegramId, amount, type = 'deposit', description = '') {
    this.registerUser(telegramId);
    const numAmount = Number(amount);
    if (isNaN(numAmount)) throw new Error('INVALID_AMOUNT');

    const currentBalance = this.getWalletBalance(telegramId);
    const newBalance = currentBalance + numAmount;
    if (newBalance < 0) {
      throw new Error('INSUFFICIENT_BALANCE');
    }

    const now = new Date().toISOString();
    this.sqlite.prepare('UPDATE users SET wallet_balance = ? WHERE telegram_id = ?').run(newBalance, telegramId);

    this.sqlite.prepare(`
      INSERT INTO wallet_transactions (user_id, amount, type, description, status, created_at)
      VALUES (?, ?, ?, ?, 'completed', ?)
    `).run(telegramId, numAmount, type, description, now);

    return newBalance;
  }

  chargeWallet(telegramId, amount, description = '') {
    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount <= 0) throw new Error('INVALID_AMOUNT');
    return this.addWalletBalance(telegramId, -numAmount, 'charge', description);
  }

  getWalletTransactions(telegramId, limit = 20) {
    return this.sqlite.prepare('SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(telegramId, limit);
  }

  // --- Plan & Subscription Helpers ---

  getPlans() {
    return this.sqlite.prepare('SELECT * FROM plans ORDER BY price ASC').all();
  }

  getPlanById(planId) {
    return this.sqlite.prepare('SELECT * FROM plans WHERE id = ?').get(planId) || null;
  }

  savePlan({ id, name, price, maxBots, durationDays, description }) {
    const now = new Date().toISOString();
    const stmt = this.sqlite.prepare(`
      INSERT INTO plans (id, name, price, max_bots, duration_days, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        price = excluded.price,
        max_bots = excluded.max_bots,
        duration_days = excluded.duration_days,
        description = excluded.description
    `);
    stmt.run(id, name, price, maxBots, durationDays, description, now);
    return this.getPlanById(id);
  }

  deletePlan(id) {
    const inUse = this.sqlite.prepare("SELECT COUNT(*) as count FROM bots WHERE plan_id = ?").get(id).count;
    if (inUse > 0) throw new Error('PLAN_IN_USE');
    const result = this.sqlite.prepare('DELETE FROM plans WHERE id = ?').run(id);
    return result.changes > 0;
  }

  setUserPlan(telegramId, planId, durationDays = 30) {
    this.registerUser(telegramId);
    const plan = this.getPlanById(planId);
    if (!plan) throw new Error('PLAN_NOT_FOUND');

    const now = new Date();
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    this.sqlite.prepare('UPDATE users SET plan_id = ?, plan_expires_at = ? WHERE telegram_id = ?').run(planId, expiresAt, telegramId);
    return this.getUser(telegramId);
  }

  setBotPlan(botId, planId, durationDays = 30, now = new Date()) {
    const bot = this.getBotById(botId);
    if (!bot) throw new Error('BOT_NOT_FOUND');
    const plan = this.getPlanById(planId);
    if (!plan) throw new Error('PLAN_NOT_FOUND');

    const nowObj = (now instanceof Date) ? now : new Date(now);
    const expiresAt = new Date(nowObj.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    const stmt = this.sqlite.prepare("UPDATE bots SET plan_id = ?, expires_at = ?, status = 'active', grace_expires_at = NULL, demo_warned = 0, last_renewed_at = ?, updated_at = ? WHERE id = ?");
    stmt.run(planId, expiresAt, nowObj.toISOString(), nowObj.toISOString(), botId);
    return this.getBotById(botId);
  }

  renewBotPlan(botId, durationDays = 30, now = new Date()) {
    const bot = this.getBotById(botId);
    if (!bot) throw new Error('BOT_NOT_FOUND');

    const nowObj = (now instanceof Date) ? now : new Date(now);
    let currentExpiry = bot.expires_at ? new Date(bot.expires_at) : nowObj;
    if (isNaN(currentExpiry.getTime()) || currentExpiry < nowObj || bot.status === 'grace') {
      currentExpiry = nowObj;
    }
    const newExpiresAt = new Date(currentExpiry.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();

    const stmt = this.sqlite.prepare("UPDATE bots SET expires_at = ?, status = 'active', grace_expires_at = NULL, demo_warned = 0, last_renewed_at = ?, updated_at = ? WHERE id = ?");
    stmt.run(newExpiresAt, nowObj.toISOString(), nowObj.toISOString(), botId);
    return this.getBotById(botId);
  }

  toggleBotAutoRenew(botId, ownerId) {
    const bot = this.getBotById(botId);
    if (!bot) throw new Error('BOT_NOT_FOUND');
    if (ownerId !== null && ownerId !== undefined && bot.owner_id !== ownerId) {
      throw new Error('UNAUTHORIZED');
    }
    const newAutoRenew = bot.auto_renew === 1 ? 0 : 1;
    const now = new Date().toISOString();
    this.sqlite.prepare('UPDATE bots SET auto_renew = ?, updated_at = ? WHERE id = ?').run(newAutoRenew, now, botId);
    return this.getBotById(botId);
  }

  getDueOrExpiredBots(nowIso = new Date().toISOString()) {
    return this.sqlite.prepare(`
      SELECT * FROM bots
      WHERE status != 'deleted'
        AND (
          (expires_at IS NOT NULL AND expires_at <= ?)
          OR
          (status = 'grace' AND grace_expires_at IS NOT NULL AND grace_expires_at <= ?)
        )
    `).all(nowIso, nowIso);
  }

  // --- Support Ticket Helpers ---

  createSupportTicket({ userId, botId = null, subject, message }) {
    this.registerUser(userId);
    const now = new Date().toISOString();
    const res = this.sqlite.prepare(`
      INSERT INTO support_tickets (user_id, bot_id, subject, status, created_at, updated_at)
      VALUES (?, ?, ?, 'open', ?, ?)
    `).run(userId, botId, subject, now, now);

    const ticketId = Number(res.lastInsertRowid);
    this.addTicketMessage({ ticketId, senderId: userId, senderRole: 'user', message });
    return this.getTicketById(ticketId);
  }

  getUserTickets(userId) {
    return this.sqlite.prepare('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
  }

  getTicketById(ticketId) {
    const ticket = this.sqlite.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketId);
    if (!ticket) return null;
    const messages = this.sqlite.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC').all(ticketId);
    return { ...ticket, messages };
  }

  addTicketMessage({ ticketId, senderId, senderRole, message }) {
    const ticket = this.sqlite.prepare('SELECT * FROM support_tickets WHERE id = ?').get(ticketId);
    if (!ticket) throw new Error('TICKET_NOT_FOUND');

    const now = new Date().toISOString();
    this.sqlite.prepare(`
      INSERT INTO ticket_messages (ticket_id, sender_id, sender_role, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(ticketId, senderId, senderRole, message, now);

    const newStatus = senderRole === 'admin' ? 'replied' : 'open';
    this.sqlite.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?').run(newStatus, now, ticketId);
    return this.getTicketById(ticketId);
  }

  getAllTickets(status = null) {
    if (status) {
      return this.sqlite.prepare('SELECT * FROM support_tickets WHERE status = ? ORDER BY updated_at DESC').all(status);
    }
    return this.sqlite.prepare('SELECT * FROM support_tickets ORDER BY updated_at DESC').all();
  }

  closeTicket(ticketId) {
    const now = new Date().toISOString();
    this.sqlite.prepare("UPDATE support_tickets SET status = 'closed', updated_at = ? WHERE id = ?").run(now, ticketId);
    return this.getTicketById(ticketId);
  }

  // --- Master Admin Metrics ---

  getAdminMasterStats() {
    const totalUsers = this.sqlite.prepare('SELECT COUNT(*) as count FROM users').get().count;
    const totalWallet = this.sqlite.prepare('SELECT COALESCE(SUM(wallet_balance), 0) as total FROM users').get().total;
    const allBots = this.sqlite.prepare("SELECT status, COUNT(*) as count FROM bots WHERE status != 'deleted' GROUP BY status").all();

    const botsByStatus = { active: 0, paused: 0, expired: 0, grace: 0 };
    let totalBots = 0;
    allBots.forEach(r => {
      botsByStatus[r.status] = r.count;
      totalBots += r.count;
    });

    const activeSubscriptions = this.sqlite.prepare("SELECT COUNT(*) as count FROM bots WHERE status = 'active' AND (expires_at IS NULL OR expires_at > ?)").get(new Date().toISOString()).count;

    const txStats = this.sqlite.prepare("SELECT type, COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM wallet_transactions GROUP BY type").all();

    const tickets = this.sqlite.prepare("SELECT status, COUNT(*) as count FROM support_tickets GROUP BY status").all();
    const ticketStats = { open: 0, replied: 0, closed: 0, total: 0 };
    tickets.forEach(t => {
      ticketStats[t.status] = t.count;
      ticketStats.total += t.count;
    });

    return {
      totalUsers,
      totalWalletBalance: totalWallet,
      totalBots,
      botsByStatus,
      activeSubscriptions,
      txStats,
      ticketStats
    };
  }

  /**
   * Returns scoped KV and document persistence wrapper for a specific bot ID
   */
  getBotScopedDb(botId) {
    const sqlite = this.sqlite;

    return {
      async get(key) {
        const row = sqlite.prepare('SELECT value FROM bot_kv WHERE bot_id = ? AND key = ?').get(botId, String(key));
        if (!row || row.value === undefined || row.value === null) return null;
        try {
          return JSON.parse(row.value);
        } catch {
          return row.value;
        }
      },

      async set(key, value) {
        const valStr = JSON.stringify(value);
        const now = new Date().toISOString();
        const stmt = sqlite.prepare(`
          INSERT INTO bot_kv (bot_id, key, value, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `);
        stmt.run(botId, String(key), valStr, now);
        return true;
      },

      async delete(key) {
        const stmt = sqlite.prepare('DELETE FROM bot_kv WHERE bot_id = ? AND key = ?');
        stmt.run(botId, String(key));
        return true;
      },

      async find(collectionName, filter = {}) {
        const rows = sqlite.prepare('SELECT id, data FROM bot_collections WHERE bot_id = ? AND collection = ?').all(botId, String(collectionName));
        const items = rows.map(r => {
          let parsed;
          try { parsed = JSON.parse(r.data); } catch { parsed = {}; }
          return { _id: r.id, ...parsed };
        });

        if (!filter || Object.keys(filter).length === 0) {
          return items;
        }

        return items.filter(item => {
          for (const [k, v] of Object.entries(filter)) {
            if (item[k] !== v) return false;
          }
          return true;
        });
      },

      async save(collectionName, item) {
        const now = new Date().toISOString();
        const itemCopy = { ...item };
        const id = itemCopy._id;
        delete itemCopy._id;

        const dataStr = JSON.stringify(itemCopy);

        if (id) {
          const stmt = sqlite.prepare('UPDATE bot_collections SET data = ? WHERE id = ? AND bot_id = ? AND collection = ?');
          stmt.run(dataStr, id, botId, String(collectionName));
          return { _id: id, ...itemCopy };
        } else {
          const stmt = sqlite.prepare('INSERT INTO bot_collections (bot_id, collection, data, created_at) VALUES (?, ?, ?, ?)');
          const res = stmt.run(botId, String(collectionName), dataStr, now);
          return { _id: Number(res.lastInsertRowid), ...itemCopy };
        }
      }
    };
  }
}

module.exports = {
  BotDb,
  validateBotToken,
  encryptToken,
  decryptToken
};
