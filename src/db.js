'use strict';

const Database = require('better-sqlite3');

/**
 * Database layer: schema init, idempotent migrations, CRUD helpers.
 * createDb(':memory:') for tests, file path for production.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'user',
  wallet_balance INTEGER NOT NULL DEFAULT 0,
  plan_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  secret_token TEXT NOT NULL UNIQUE,
  username TEXT,
  template_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  config TEXT NOT NULL DEFAULT '{}',
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_kv (
  bot_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, key)
);
CREATE TABLE IF NOT EXISTS bot_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  max_bots INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  bot_id TEXT,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  sender_role TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  source_dir TEXT,
  token_encrypted TEXT,
  runtime TEXT,
  start_command TEXT,
  status TEXT NOT NULL DEFAULT 'pending_review',
  report TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_template_demos (
  user_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, template_id)
);
CREATE TABLE IF NOT EXISTS containers (
  bot_id TEXT PRIMARY KEY,
  container_name TEXT NOT NULL,
  image TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const DEFAULT_PLANS = [
  { id: 'free', name: 'رایگان / دمو', price: 0, max_bots: 1, duration_days: 0, description: 'یک ربات، ۶۰ دقیقه دمو، یک بار برای هر نوع قالب' },
  { id: 'pro', name: 'پرو', price: 200000, max_bots: 5, duration_days: 30, description: '۵ ربات، ۳۰ روزه' },
  { id: 'vip', name: 'ویژه (VIP)', price: 500000, max_bots: 15, duration_days: 30, description: '۱۵ ربات، ۳۰ روزه' }
];

function createDb(filePath) {
  const db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  // --- idempotent migrations (ALTER TABLE pattern, guarded by pragma table_info) ---
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const addColumn = (table, col, ddl) => {
    if (!cols(table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addColumn('bots', 'auto_renew', 'auto_renew INTEGER NOT NULL DEFAULT 0');

  // seed default plans idempotently
  const insPlan = db.prepare('INSERT OR IGNORE INTO plans (id, name, price, max_bots, duration_days, description, created_at) VALUES (?,?,?,?,?,?,?)');
  const now = Date.now();
  for (const p of DEFAULT_PLANS) insPlan.run(p.id, p.name, p.price, p.max_bots, p.duration_days, p.description, now);

  // ------------------------------------------------------------------ helpers
  const j = (v) => JSON.stringify(v ?? null);
  const pj = (v) => { try { return JSON.parse(v); } catch (_) { return null; } };

  const api = {
    raw: db,

    // ---- users
    upsertUser(telegramId, extra = {}) {
      db.prepare('INSERT INTO users (telegram_id, role, wallet_balance, created_at) VALUES (?,?,0,?) ON CONFLICT(telegram_id) DO NOTHING')
        .run(String(telegramId), extra.role || 'user', Date.now());
      if (extra.role) db.prepare('UPDATE users SET role=? WHERE telegram_id=?').run(extra.role, String(telegramId));
      return api.getUser(telegramId);
    },
    getUser(telegramId) {
      const row = db.prepare('SELECT * FROM users WHERE telegram_id=?').get(String(telegramId));
      if (row) row.plan = row.plan_id;
      return row;
    },
    setBalance(telegramId, balance) {
      db.prepare('UPDATE users SET wallet_balance=? WHERE telegram_id=?').run(Math.floor(balance), String(telegramId));
    },

    // ---- plans
    getPlan(id) { return db.prepare('SELECT * FROM plans WHERE id=?').get(id); },
    listPlans() { return db.prepare('SELECT * FROM plans ORDER BY price').all(); },

    // ---- bots
    createBot(bot) {
      const now = bot.created_at || Date.now(); // injectable for tests
      db.prepare(`INSERT INTO bots (id, owner_id, token_encrypted, secret_token, username, template_id, plan_id, status, config, expires_at, created_at, updated_at, auto_renew)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(bot.id, String(bot.owner_id), bot.token_encrypted, bot.secret_token, bot.username || null,
          bot.template_id, bot.plan_id, bot.status || 'active', j(bot.config || {}), bot.expires_at || null, now, now, bot.auto_renew ? 1 : 0);
      return api.getBot(bot.id);
    },
    getBot(id) {
      const row = db.prepare('SELECT * FROM bots WHERE id=?').get(id);
      if (row) row.config = pj(row.config) || {};
      return row;
    },
    getBotBySecret(secret) {
      const row = db.prepare('SELECT * FROM bots WHERE secret_token=?').get(secret);
      if (row) row.config = pj(row.config) || {};
      return row;
    },
    updateBot(id, patch) {
      const bot = api.getBot(id);
      if (!bot) return null;
      const merged = { ...bot, ...patch };
      if (patch.config) merged.config = j({ ...bot.config, ...patch.config });
      const configStr = typeof merged.config === 'string' ? merged.config : j(merged.config ?? {});
      db.prepare(`UPDATE bots SET token_encrypted=?, secret_token=?, username=?, template_id=?, plan_id=?, status=?, config=?, expires_at=?, auto_renew=?, updated_at=? WHERE id=?`)
        .run(merged.token_encrypted, merged.secret_token, merged.username, merged.template_id, merged.plan_id, merged.status, configStr, merged.expires_at, merged.auto_renew ? 1 : 0, Date.now(), id);
      return api.getBot(id);
    },
    deleteBot(id) {
      db.prepare('DELETE FROM bot_kv WHERE bot_id=?').run(id);
      db.prepare('DELETE FROM bot_collections WHERE bot_id=?').run(id);
      db.prepare('DELETE FROM bots WHERE id=?').run(id);
    },
    listBotsByOwner(ownerId) {
      return db.prepare(`SELECT * FROM bots WHERE owner_id=? AND status != 'deleted' ORDER BY created_at DESC`).all(String(ownerId)).map((r) => { r.config = pj(r.config) || {}; return r; });
    },
    listBotsByStatus(status) {
      return db.prepare('SELECT * FROM bots WHERE status=?').all(status).map((r) => { r.config = pj(r.config) || {}; return r; });
    },
    countBotsByOwner(ownerId, templateId) {
      if (templateId) return db.prepare(`SELECT COUNT(*) c FROM bots WHERE owner_id=? AND template_id=? AND status != 'deleted'`).get(String(ownerId), templateId).c;
      return db.prepare(`SELECT COUNT(*) c FROM bots WHERE owner_id=? AND status != 'deleted'`).get(String(ownerId)).c;
    },
    wipeBotData(botId) {
      db.prepare('DELETE FROM bot_kv WHERE bot_id=?').run(botId);
      db.prepare('DELETE FROM bot_collections WHERE bot_id=?').run(botId);
    },

    // ---- per-bot kv / collections (template storage scope)
    botStore(botId) {
      return {
        async get(key) {
          const row = db.prepare('SELECT value FROM bot_kv WHERE bot_id=? AND key=?').get(botId, key);
          return row ? pj(row.value) : null;
        },
        async set(key, value) {
          db.prepare(`INSERT INTO bot_kv (bot_id, key, value, updated_at) VALUES (?,?,?,?)
                      ON CONFLICT(bot_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
            .run(botId, key, j(value), Date.now());
        },
        async find(collection, filter = {}) {
          const rows = db.prepare('SELECT * FROM bot_collections WHERE bot_id=? AND collection=? ORDER BY id').all(botId, collection);
          return rows
            .map((r) => ({ id: String(r.id), ...pj(r.data) }))
            .filter((item) => Object.entries(filter).every(([k, v]) => String(item[k]) === String(v)));
        },
        async save(collection, data) {
          const res = db.prepare('INSERT INTO bot_collections (bot_id, collection, data, created_at) VALUES (?,?,?,?)')
            .run(botId, collection, j(data), Date.now());
          return { id: String(res.lastInsertRowid), ...data };
        },
        async delete(collection, id) {
          db.prepare('DELETE FROM bot_collections WHERE bot_id=? AND collection=? AND id=?').run(botId, collection, String(id));
        }
      };
    },

    // ---- demo eligibility (ONE free demo per user per template)
    hasUsedDemo(userId, templateId) {
      return !!db.prepare('SELECT 1 FROM user_template_demos WHERE user_id=? AND template_id=?').get(String(userId), templateId);
    },
    markDemoUsed(userId, templateId) {
      db.prepare('INSERT OR IGNORE INTO user_template_demos (user_id, template_id, created_at) VALUES (?,?,?)').run(String(userId), templateId, Date.now());
    },

    // ---- wallet transactions
    addTransaction(userId, amount, type, description) {
      const res = db.prepare('INSERT INTO wallet_transactions (user_id, amount, type, description, created_at) VALUES (?,?,?,?,?)')
        .run(String(userId), Math.floor(amount), type, description || null, Date.now());
      return res.lastInsertRowid;
    },
    listTransactions(userId) {
      return db.prepare('SELECT * FROM wallet_transactions WHERE user_id=? ORDER BY id DESC LIMIT 20').all(String(userId));
    },
    listAllTransactions() {
      return db.prepare('SELECT * FROM wallet_transactions ORDER BY id DESC LIMIT 200').all();
    },

    // ---- support tickets
    createTicket(userId, subject, botId) {
      const res = db.prepare('INSERT INTO support_tickets (user_id, bot_id, subject, status, created_at) VALUES (?,?,?,?,?)')
        .run(String(userId), botId || null, subject, 'open', Date.now());
      return api.getTicket(res.lastInsertRowid);
    },
    getTicket(id) {
      const t = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(id);
      if (t) t.messages = db.prepare('SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY id').all(id);
      return t;
    },
    listTickets(status) {
      const rows = status
        ? db.prepare('SELECT * FROM support_tickets WHERE status=? ORDER BY id DESC').all(status)
        : db.prepare('SELECT * FROM support_tickets ORDER BY id DESC').all();
      return rows;
    },
    addTicketMessage(ticketId, senderRole, message) {
      db.prepare('INSERT INTO ticket_messages (ticket_id, sender_role, message, created_at) VALUES (?,?,?,?)').run(ticketId, senderRole, message, Date.now());
    },
    setTicketStatus(id, status) {
      db.prepare('UPDATE support_tickets SET status=? WHERE id=?').run(status, id);
    },

    // ---- custom projects
    // ------------------------------------------------ containerized templates
    upsertContainer(rec) {
      const now = Date.now();
      db.prepare(`INSERT INTO containers (bot_id, container_name, image, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(bot_id) DO UPDATE SET container_name=excluded.container_name,
          image=excluded.image, status=excluded.status, updated_at=excluded.updated_at`)
        .run(rec.bot_id, rec.container_name, rec.image, rec.status || 'provisioning', now, now);
      return api.getContainer(rec.bot_id);
    },
    getContainer(botId) {
      const r = db.prepare('SELECT * FROM containers WHERE bot_id=?').get(botId);
      return r || null;
    },
    updateContainer(botId, patch) {
      const c = api.getContainer(botId);
      if (!c) return null;
      db.prepare('UPDATE containers SET status=?, updated_at=? WHERE bot_id=?')
        .run(patch.status ?? c.status, Date.now(), botId);
      return api.getContainer(botId);
    },
    deleteContainer(botId) {
      db.prepare('DELETE FROM containers WHERE bot_id=?').run(botId);
    },

    createCustomProject(p) {
      db.prepare('INSERT INTO custom_projects (id, owner_id, source_dir, token_encrypted, runtime, start_command, status, report, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(p.id, String(p.owner_id), p.source_dir || null, p.token_encrypted || null, p.runtime || null, p.start_command || null, p.status || 'pending_review', j(p.report || null), Date.now());
      return api.getCustomProject(p.id);
    },
    getCustomProject(id) {
      const row = db.prepare('SELECT * FROM custom_projects WHERE id=?').get(id);
      if (row) row.report = pj(row.report);
      return row;
    },
    updateCustomProject(id, patch) {
      const cur = api.getCustomProject(id);
      if (!cur) return null;
      const merged = { ...cur, ...patch };
      db.prepare('UPDATE custom_projects SET status=?, report=?, runtime=?, start_command=? WHERE id=?')
        .run(merged.status, j(merged.report ?? null), merged.runtime ?? null, merged.start_command ?? null, id);
      return api.getCustomProject(id);
    },
    listCustomProjects() { return db.prepare('SELECT * FROM custom_projects ORDER BY created_at DESC').all().map((r) => { r.report = pj(r.report); return r; }); },

    // ---- stats (admin console)
    stats() {
      return {
        users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
        bots: db.prepare(`SELECT COUNT(*) c FROM bots WHERE status != 'deleted'`).get().c,
        revenue: db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM wallet_transactions WHERE type IN ('purchase','renew','topup','custom_source')`).get().s,
        openTickets: db.prepare(`SELECT COUNT(*) c FROM support_tickets WHERE status='open'`).get().c
      };
    }
  };

  return api;
}

module.exports = { createDb, DEFAULT_PLANS };
