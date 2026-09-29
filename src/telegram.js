'use strict';

const http = require('http');
const https = require('https');
const { escapeHtml } = require('./utils/html');

// Global in-memory log of mock API calls for assertions in unit tests
const mockCalls = [];

function clearMockCalls() {
  mockCalls.length = 0;
}

function getMockCalls() {
  return [...mockCalls];
}

/**
 * Low-level call to Telegram API or Mock Handler
 */
async function callTelegramApi(token, method, payload = {}, options = {}) {
  const isMock = options.mock || process.env.MOCK_TELEGRAM === 'true';

  if (isMock) {
    const callRecord = {
      token,
      method,
      payload,
      timestamp: new Date().toISOString()
    };
    mockCalls.push(callRecord);

    // Mock responses by method
    switch (method) {
      case 'getFile':
        return {ok:true,result:{file_path:'mock.zip',file_size:100}};
      case 'getMe':
        return {
          ok: true,
          result: {
            id: 100000000 + Math.abs(hashCode(token) % 800000000),
            is_bot: true,
            first_name: 'MockBot',
            username: 'mock_bot_' + Math.abs(hashCode(token) % 10000)
          }
        };

      case 'setWebhook':
      case 'deleteWebhook':
        return {
          ok: true,
          result: true,
          description: `Mock method ${method} executed successfully`
        };

      case 'deleteMessage':
        return {ok:true,result:true};
      case 'sendMessage':
        return {
          ok: true,
          result: {
            message_id: Math.floor(Math.random() * 100000) + 1,
            chat: { id: payload.chat_id || 0 },
            date: Math.floor(Date.now() / 1000),
            text: payload.text || ''
          }
        };

      case 'sendPhoto':
      case 'sendDocument':
      case 'sendAudio':
        return {
          ok: true,
          result: {
            message_id: Math.floor(Math.random() * 100000) + 1,
            chat: { id: payload.chat_id || 0 },
            date: Math.floor(Date.now() / 1000),
            caption: payload.caption || ''
          }
        };

      case 'sendPoll':
        return {
          ok: true,
          result: {
            message_id: Math.floor(Math.random() * 100000) + 1,
            chat: { id: payload.chat_id || 0 },
            poll: {
              id: String(Math.floor(Math.random() * 1000000)),
              question: payload.question,
              options: (payload.options || []).map(o => ({ text: o, voter_count: 0 }))
            }
          }
        };

      case 'answerCallbackQuery':
        return { ok: true, result: true };

      case 'editMessageText':
        return {
          ok: true,
          result: {
            message_id: payload.message_id || 1,
            chat: { id: payload.chat_id || 0 },
            text: payload.text || ''
          }
        };

      case 'pinChatMessage':
      case 'unpinChatMessage':
        return { ok: true, result: true };

      case 'getChatMember':
        return {
          ok: true,
          result: {
            user: { id: payload.user_id || 0, is_bot: false, first_name: 'TestUser' },
            status: 'member'
          }
        };

      case 'copyMessage':
      case 'forwardMessage':
        return {
          ok: true,
          result: {
            message_id: Math.floor(Math.random() * 100000) + 1
          }
        };

      default:
        return { ok: true, result: true };
    }
  }

  // Real HTTPS request
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const data = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        },
        timeout: 10000
      },
      (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse Telegram API response: ${body}`));
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Telegram API request timed out'));
    });

    req.write(data);
    req.end();
  });
}

/**
 * Uploads a local file as multipart/form-data (used for sendAudio with a real file).
 * Uses Node 18+ built-in fetch/FormData/Blob, so no extra dependency is needed.
 */
async function uploadLocalFile(token, method, fileField, filePath, fields = {}, options = {}) {
  const fs = require('fs');
  const path = require('path');
  const isMock = options.mock || process.env.MOCK_TELEGRAM === 'true';
  if (isMock) {
    return callTelegramApi(token, method, { ...fields, [fileField]: `file://${filePath}` }, options);
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const buf = fs.readFileSync(filePath);
  form.append(fileField, new Blob([buf]), path.basename(filePath));
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', body: form });
  return res.json();
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/**
 * Removes the non-standard `style` field from inline keyboard buttons.
 * Telegram's Bot API accepts `style` ("primary" | "success" | "danger") on
 * some accounts/clients but rejects it (400) on others (observed mainly on
 * non-Premium accounts for "success"/"danger" — "primary" is broadly safe).
 * We optimistically send WITH style first, and only strip+retry on failure,
 * so accounts/clients that do render the color keep the colored buttons.
 */
function stripStyles(replyMarkup) {
  if (!replyMarkup) return replyMarkup;
  return JSON.parse(JSON.stringify(replyMarkup, (k, v) => (k === 'style' ? undefined : v)));
}

function hasStyledButtons(replyMarkup) {
  if (!replyMarkup || !Array.isArray(replyMarkup.inline_keyboard)) return false;
  return replyMarkup.inline_keyboard.some(row => Array.isArray(row) && row.some(btn => btn && btn.style));
}

/**
 * Sends a Telegram API call that may include styled buttons, retrying once
 * without the `style` field if the first attempt is rejected.
 */
async function callWithStyleFallback(token, method, payload, options) {
  const result = await callTelegramApi(token, method, payload, options);
  if (result && result.ok === false && payload.reply_markup && hasStyledButtons(payload.reply_markup)) {
    return callTelegramApi(token, method, { ...payload, reply_markup: stripStyles(payload.reply_markup) }, options);
  }
  return result;
}

/**
 * Creates Telegram API interface matching TEMPLATES_INTERFACE.md
 */
function createTelegramApi(botToken, options = {}) {
  return {
    async deleteMessage(chatId, messageId) { return callTelegramApi(botToken, 'deleteMessage', {chat_id:chatId,message_id:messageId}, options); },
    async sendMessage(chatId, text, opts = {}) {
      return callWithStyleFallback(botToken, 'sendMessage', { chat_id: chatId, text, ...opts }, options);
    },

    async sendPhoto(chatId, photo, opts = {}) {
      return callWithStyleFallback(botToken, 'sendPhoto', { chat_id: chatId, photo, ...opts }, options);
    },

    async sendAudio(chatId, audio, opts = {}) {
      // `audio` may be a file_id / URL (string) or {path: '/local/file.mp3'} for a local upload
      if (audio && typeof audio === 'object' && audio.path) {
        const { reply_markup, ...rest } = opts;
        return uploadLocalFile(botToken, 'sendAudio', 'audio', audio.path, { chat_id: chatId, ...rest, reply_markup }, options);
      }
      return callWithStyleFallback(botToken, 'sendAudio', { chat_id: chatId, audio, ...opts }, options);
    },

    async sendVideo(chatId, video, opts = {}) {
      // `video` may be a file_id / URL (string) or {path: '/local/file.mp4'} for a local upload
      if (video && typeof video === 'object' && video.path) {
        const { reply_markup, ...rest } = opts;
        return uploadLocalFile(botToken, 'sendVideo', 'video', video.path, { chat_id: chatId, ...rest, reply_markup }, options);
      }
      return callWithStyleFallback(botToken, 'sendVideo', { chat_id: chatId, video, ...opts }, options);
    },

    async sendDocument(chatId, document, opts = {}) {
      return callWithStyleFallback(botToken, 'sendDocument', { chat_id: chatId, document, ...opts }, options);
    },

    async sendPoll(chatId, question, pollOpts, extraOpts = {}) {
      return callTelegramApi(botToken, 'sendPoll', {
        chat_id: chatId,
        question,
        options: pollOpts,
        ...extraOpts
      }, options);
    },

    async answerCallbackQuery(callbackQueryId, opts = {}) {
      return callTelegramApi(botToken, 'answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        ...opts
      }, options);
    },

    async editMessageText(chatId, messageId, text, opts = {}) {
      return callWithStyleFallback(botToken, 'editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text,
        ...opts
      }, options);
    },

    async pinChatMessage(chatId, messageId, opts = {}) {
      return callTelegramApi(botToken, 'pinChatMessage', {
        chat_id: chatId,
        message_id: messageId,
        ...opts
      }, options);
    },

    async getMe() { return callTelegramApi(botToken,'getMe',{},options); },

    async getChat(chatId) { return callTelegramApi(botToken, 'getChat', { chat_id: chatId }, options); },

    async getChatMember(chatId, userId) {
      return callTelegramApi(botToken, 'getChatMember', {
        chat_id: chatId,
        user_id: userId
      }, options);
    },

    async copyMessage(chatId, fromChatId, messageId, opts = {}) {
      return callTelegramApi(botToken, 'copyMessage', {
        chat_id: chatId,
        from_chat_id: fromChatId,
        message_id: messageId,
        ...opts
      }, options);
    },

    async forwardMessage(chatId, fromChatId, messageId, opts = {}) {
      return callTelegramApi(botToken, 'forwardMessage', {
        chat_id: chatId,
        from_chat_id: fromChatId,
        message_id: messageId,
        ...opts
      }, options);
    }
  };
}

async function setWebhook(botToken, publicBaseUrl, secretToken, options = {}) {
  const url = `${publicBaseUrl.replace(/\/$/, '')}/webhook/${secretToken}`;
  return callTelegramApi(botToken, 'setWebhook', {
    url,
    secret_token: secretToken,
    allowed_updates: ['message','callback_query']
  }, options);
}

async function deleteWebhook(botToken, options = {}) {
  return callTelegramApi(botToken, 'deleteWebhook', {}, options);
}

async function downloadBotFile(botToken, fileId, maxBytes = 10 * 1024 * 1024, options = {}) {
  const info = await callTelegramApi(botToken, 'getFile', { file_id: fileId }, options);
  if (!info?.ok || !info.result?.file_path) throw new Error('FILE_UNAVAILABLE');
  if (Number(info.result.file_size) > maxBytes) throw new Error('FILE_TOO_LARGE');
  const filePath = info.result.file_path;
  if (!/^[a-zA-Z0-9_./-]+$/.test(filePath) || filePath.includes('..') || filePath.startsWith('/')) throw new Error('INVALID_FILE_PATH');
  if (options.mock) return Buffer.from('mock data');
  const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new Error('FILE_DOWNLOAD_FAILED');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) { await response.body.cancel().catch(() => {}); throw new Error('FILE_TOO_LARGE'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function getMe(botToken, options = {}) {
  return callTelegramApi(botToken, 'getMe', {}, options);
}

module.exports = {
  callTelegramApi,
  createTelegramApi,
  setWebhook,
  deleteWebhook,
  getMe,
  downloadBotFile,
  mockCalls,
  clearMockCalls,
  getMockCalls,
  escapeHtml,
  stripStyles,
  hasStyledButtons
};
