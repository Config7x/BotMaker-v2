'use strict';

/**
 * Thin Telegram Bot API HTTP client with a mock mode for tests (MOCK_TELEGRAM=true
 * or mock:true). No external bot framework.
 * Security: inline button `style` params are sanitized to 'primary' only,
 * because 'success'/'destructive' 400-error on non-Premium accounts.
 */
const { isBlockedIp } = require('./utils/ssrf');

const STYLE_ALLOWED = new Set([undefined, null, '', 'primary']);

function sanitizeButtons(replyMarkup) {
  if (!replyMarkup || !Array.isArray(replyMarkup.inline_keyboard)) return replyMarkup;
  replyMarkup.inline_keyboard = replyMarkup.inline_keyboard.map((row) =>
    row.map((btn) => {
      if (btn.style !== undefined && !STYLE_ALLOWED.has(btn.style)) {
        const { style, ...rest } = btn; // eslint-disable-line no-unused-vars
        return { ...rest, style: 'primary' };
      }
      return btn;
    })
  );
  return replyMarkup;
}

class TelegramApiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

class TelegramApi {
  constructor(token, opts = {}) {
    this.token = token;
    this.mock = !!(opts.mock || process.env.MOCK_TELEGRAM === 'true');
    this.baseUrl = opts.baseUrl || 'https://api.telegram.org';
    this.mockLog = opts.mockLog || [];
    this.mockResponses = opts.mockResponses || {}; // method -> result / function(payload)
    this.mockChatMemberStatus = opts.mockChatMemberStatus;
    this.uploadLimitBytes = opts.uploadLimitBytes || 20 * 1024 * 1024; // 20MB Bot API download limit
  }

  _record(method, payload) {
    this.mockLog.push({ method, payload });
    const preset = this.mockResponses[method];
    if (typeof preset === 'function') return preset(payload);
    if (preset !== undefined) return preset;
    // sensible default mock results
    switch (method) {
      case 'getMe': return { ok: true, result: { id: 1, username: 'mockbot', first_name: 'MockBot' } };
      case 'getChatMember': return { ok: true, result: { status: this.mockChatMemberStatus || 'member' } };
      case 'answerCallbackQuery': return { ok: true, result: true };
      case 'setWebhook': case 'deleteWebhook': return { ok: true, result: true };
      case 'sendMessage': return { ok: true, result: { message_id: Math.floor(Math.random() * 100000), chat: { id: payload.chat_id } } };
      default: return { ok: true, result: true };
    }
  }

  async call(method, payload = {}) {
    if (payload.reply_markup) payload.reply_markup = sanitizeButtons(payload.reply_markup);
    if (this.mock) return this._record(method, payload);
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new TelegramApiError(data.description || `Telegram API ${method} failed`, data.error_code);
    return data;
  }

  /** multipart upload (document/photo) from buffer */
  async upload(method, { chat_id, buffer, filename, caption, parse_mode, reply_markup, extra = {} }) {
    if (payload_reply_markup_has_style(reply_markup)) reply_markup = sanitizeButtons(reply_markup);
    if (this.mock) {
      return this._record(method, { chat_id, filename, caption, ...extra });
    }
    const form = new FormData();
    form.append('chat_id', String(chat_id));
    form.append(method === 'sendDocument' ? 'document' : 'photo', new Blob([buffer]), filename);
    if (caption) form.append('caption', caption);
    if (parse_mode) form.append('parse_mode', parse_mode);
    if (reply_markup) form.append('reply_markup', JSON.stringify(sanitizeButtons(reply_markup)));
    for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    const res = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new TelegramApiError(data.description || `${method} failed`, data.error_code);
    return data;
  }

  /**
   * sendDocument accepting either a Buffer (direct upload) or an HTTPS URL.
   * For URLs the file is downloaded with SSRF re-checks (DNS-pinning) and must
   * stay under the 20MB Bot API limit — otherwise an error is thrown and
   * callers can fall back to sending the link.
   */
  async sendDocument(chatId, file, opts = {}) {
    if (typeof file === 'string' && /^https?:\/\//i.test(file)) {
      const fetched = await this.fetchUrlAsBuffer(file); // throws on oversize/SSRF
      return this.upload('sendDocument', { chat_id: chatId, buffer: fetched.buffer, filename: fetched.filename || 'file.bin', caption: opts.caption, parse_mode: opts.parse_mode, reply_markup: opts.reply_markup });
    }
    return this.upload('sendDocument', { chat_id: chatId, buffer: file, filename: opts.filename || 'file.bin', caption: opts.caption, parse_mode: opts.parse_mode, reply_markup: opts.reply_markup, extra: opts.extra });
  }

  async fetchUrlAsBuffer(url) {
    let u;
    try { u = new URL(url); } catch (_) { throw new TelegramApiError('invalid URL'); }
    if (!/^https?:$/.test(u.protocol)) throw new TelegramApiError('only http(s) allowed');
    if (isBlockedIp(u.hostname)) throw new TelegramApiError('blocked host (SSRF)');
    if (this.mock) return { buffer: Buffer.alloc(4, 1), filename: 'mock.bin' };
    const dns = require('dns').promises;
    try {
      const addrs = await dns.lookup(u.hostname, { all: true });
      for (const a of addrs) if (isBlockedIp(a.address)) throw new TelegramApiError('resolved to private address (SSRF)');
    } catch (e) { if (e instanceof TelegramApiError) throw e; }
    const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new TelegramApiError(`download failed: HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > this.uploadLimitBytes) throw new TelegramApiError('file exceeds 20MB Bot API limit');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > this.uploadLimitBytes) throw new TelegramApiError('file exceeds 20MB Bot API limit');
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename="?([^";]+)"?/i);
    return { buffer, filename: m ? m[1] : (u.pathname.split('/').pop() || 'file.bin') };
  }

  getMe() { return this.call('getMe'); }
  setWebhook(url, secretToken, extra = {}) {
    return this.call('setWebhook', { url, secret_token: secretToken, drop_pending_updates: true, allowed_updates: ['message', 'callback_query'], ...extra });
  }
  deleteWebhook() { return this.call('deleteWebhook', { drop_pending_updates: false }); }
  sendMessage(chatId, text, opts = {}) {
    return this.call('sendMessage', { chat_id: chatId, text, ...opts });
  }
  sendPhoto(chatId, photo, opts = {}) { return this.call('sendPhoto', { chat_id: chatId, photo, ...opts }); }
  sendPoll(chatId, question, options, opts = {}) {
    return this.call('sendPoll', { chat_id: chatId, question, options, is_anonymous: false, ...opts });
  }
  answerCallbackQuery(id, opts = {}) { return this.call('answerCallbackQuery', { callback_query_id: id, ...opts }); }
  editMessageText(chatId, messageId, text, opts = {}) {
    return this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, ...opts });
  }
  pinChatMessage(chatId, messageId, opts = {}) { return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, ...opts }); }
  getChatMember(chatId, userId) { return this.call('getChatMember', { chat_id: chatId, user_id: userId }); }
  copyMessage(chatId, fromChatId, messageId, opts = {}) {
    return this.call('copyMessage', { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId, ...opts });
  }
  forwardMessage(chatId, fromChatId, messageId) {
    return this.call('forwardMessage', { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId });
  }
  async getUpdates(offset, timeoutSec = 25) {
    if (this.mock) return this._record('getUpdates', { offset });
    return this.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] });
  }
}

function payload_reply_markup_has_style(rm) { return !!rm; }

module.exports = { TelegramApi, TelegramApiError };
