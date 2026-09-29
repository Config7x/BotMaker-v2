'use strict';

/**
 * Template Manager — lets the platform owner (admin) add, list, enable/disable
 * and remove custom bot templates from inside the Telegram admin console,
 * without touching the server or the built-in template files.
 *
 * A custom template is a ZIP (same rules as the "Custom Source" feature reuses
 * the safe zip-extraction/validation pipeline) that must contain an entry point
 * the webhook loader can find: index.js (module.exports.handle) at the ZIP root.
 *
 * Custom templates are stored under data/custom_templates/<id>/ and are merged
 * with the built-in TEMPLATE_NAMES map at runtime, so they show up in the normal
 * "create bot" template list and are dispatched by webhook.js exactly like a
 * built-in template.
 */

const fs = require('fs');
const path = require('path');
const { validateUploadArchive, cleanupExtractedSource } = require('./custom/validator');

class TemplateManager {
  constructor({ db, config }) {
    this.db = db;
    this.config = config || {};
    this.root = path.resolve(
      this.config.custom_templates_dir || path.join(__dirname, '..', 'data', 'custom_templates')
    );
    fs.mkdirSync(this.root, { recursive: true });

    this.db.sqlite.exec(`CREATE TABLE IF NOT EXISTS custom_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      source_dir TEXT NOT NULL,
      added_by INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    )`);
  }

  list() {
    return this.db.sqlite.prepare('SELECT * FROM custom_templates ORDER BY created_at DESC').all();
  }

  listEnabled() {
    return this.db.sqlite.prepare('SELECT * FROM custom_templates WHERE enabled = 1 ORDER BY created_at DESC').all();
  }

  get(id) {
    if (!id) return null;
    return this.db.sqlite.prepare('SELECT * FROM custom_templates WHERE id = ?').get(id) || null;
  }

  exists(id) {
    return !!this.get(id);
  }

  /** Merge built-in + enabled custom templates into one { id: label } map */
  namesMap(builtInNames) {
    const map = { ...builtInNames };
    for (const row of this.listEnabled()) {
      map[row.id] = `🧩 ${row.name}`;
    }
    return map;
  }

  async addFromZip({ id, name, description, zipPath, addedBy }) {
    const cleanId = String(id || '').toLowerCase().trim().replace(/[^a-z0-9_]/g, '');
    if (!cleanId || cleanId.length < 3 || cleanId.length > 40) {
      throw new Error('شناسه قالب باید بین ۳ تا ۴۰ کاراکتر و فقط شامل حروف انگلیسی کوچک، عدد و _ باشد.');
    }
    if (this.exists(cleanId)) {
      throw new Error('این شناسه قالب قبلاً ثبت شده است. یک شناسه دیگر انتخاب کنید یا اول قالب قبلی را حذف کنید.');
    }
    if (!name || !name.trim()) {
      throw new Error('نام نمایشی قالب الزامی است.');
    }

    const destDir = path.join(this.root, cleanId);

    const result = await validateUploadArchive(zipPath, {
      targetDir: destDir,
      maxZipSizeBytes: 10 * 1024 * 1024
    });

    if (!result || !result.valid) {
      cleanupExtractedSource(destDir);
      const errs = (result && result.errors) || ['اعتبارسنجی فایل ناموفق بود.'];
      throw new Error(errs.join(' | '));
    }

    const hasEntry = fs.existsSync(path.join(destDir, 'index.js')) || fs.existsSync(path.join(destDir, `${cleanId}.js`));
    if (!hasEntry) {
      cleanupExtractedSource(destDir);
      throw new Error('فایل ورودی پیدا نشد. باید یک فایل index.js (با module.exports.handle یا module.exports = function) در ریشه ZIP وجود داشته باشد.');
    }

    // Sanity-check the entry point actually loads and exposes a handler
    try {
      const entryPath = fs.existsSync(path.join(destDir, 'index.js'))
        ? path.join(destDir, 'index.js')
        : path.join(destDir, `${cleanId}.js`);
      delete require.cache[require.resolve(entryPath)];
      const mod = require(entryPath);
      const hasHandle = typeof mod.handle === 'function' || typeof mod === 'function' || (mod.default && typeof mod.default.handle === 'function');
      if (!hasHandle) {
        cleanupExtractedSource(destDir);
        throw new Error('فایل ورودی باید یک تابع handle(...) خروجی بدهد: module.exports = { handle: async ({update, bot, api, db}) => {...} }');
      }
    } catch (err) {
      cleanupExtractedSource(destDir);
      throw new Error(`بارگذاری فایل ورودی با خطا مواجه شد: ${String(err.message).slice(0, 300)}`);
    }

    const nowIso = new Date().toISOString();
    this.db.sqlite
      .prepare('INSERT INTO custom_templates (id, name, description, source_dir, added_by, enabled, created_at) VALUES (?,?,?,?,?,1,?)')
      .run(cleanId, name.trim(), (description || '').trim(), destDir, addedBy || null, nowIso);

    return this.get(cleanId);
  }

  remove(id) {
    const row = this.get(id);
    if (!row) return false;
    cleanupExtractedSource(row.source_dir);
    this.db.sqlite.prepare('DELETE FROM custom_templates WHERE id = ?').run(id);
    return true;
  }

  setEnabled(id, enabled) {
    const row = this.get(id);
    if (!row) return false;
    this.db.sqlite.prepare('UPDATE custom_templates SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return true;
  }

  /** Extra search path for webhook.js's loadTemplateModule to also check custom templates dir */
  resolveEntryPath(id) {
    const row = this.get(id);
    if (!row) return null;
    const candidates = [
      path.join(row.source_dir, 'index.js'),
      path.join(row.source_dir, `${id}.js`)
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
  }
}

module.exports = { TemplateManager };
