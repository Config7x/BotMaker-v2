'use strict';

/**
 * Creates a mock Telegram API wrapper that records calls.
 */
function createMockApi() {
  const calls = [];

  return {
    calls,
    async sendMessage(chatId, text, options = {}) {
      const record = { method: 'sendMessage', chatId, text, options };
      calls.push(record);
      return { ok: true, result: { message_id: Math.floor(Math.random() * 10000) + 1, chat: { id: chatId }, text } };
    },
    async sendPhoto(chatId, photo, options = {}) {
      const record = { method: 'sendPhoto', chatId, photo, options };
      calls.push(record);
      return { ok: true, result: { message_id: Math.floor(Math.random() * 10000) + 1, chat: { id: chatId }, photo } };
    },
    async sendDocument(chatId, document, options = {}) {
      const record = { method: 'sendDocument', chatId, document, options };
      calls.push(record);
      return { ok: true, result: { message_id: Math.floor(Math.random() * 10000) + 1, chat: { id: chatId }, document } };
    },
    async sendPoll(chatId, question, options = [], extraOptions = {}) {
      const record = { method: 'sendPoll', chatId, question, options, extraOptions };
      calls.push(record);
      return { ok: true, result: { message_id: Math.floor(Math.random() * 10000) + 1, chat: { id: chatId }, poll: { question, options } } };
    },
    async answerCallbackQuery(callbackQueryId, options = {}) {
      const record = { method: 'answerCallbackQuery', callbackQueryId, options };
      calls.push(record);
      return { ok: true, result: true };
    },
    async editMessageText(chatId, messageId, text, options = {}) {
      const record = { method: 'editMessageText', chatId, messageId, text, options };
      calls.push(record);
      return { ok: true, result: { message_id: messageId, chat: { id: chatId }, text } };
    },
    async pinChatMessage(chatId, messageId, options = {}) {
      const record = { method: 'pinChatMessage', chatId, messageId, options };
      calls.push(record);
      return { ok: true, result: true };
    },
    async getChatMember(chatId, userId) {
      const record = { method: 'getChatMember', chatId, userId };
      calls.push(record);
      // Default mock returns administrator status
      return {
        ok: true,
        result: {
          status: 'administrator',
          user: { id: userId },
          can_post_messages: true,
          can_edit_messages: true,
          can_pin_messages: true
        }
      };
    },
    async copyMessage(chatId, fromChatId, messageId, options = {}) {
      const record = { method: 'copyMessage', chatId, fromChatId, messageId, options };
      calls.push(record);
      return { ok: true, result: { message_id: Math.floor(Math.random() * 10000) + 1 } };
    },
    async forwardMessage(chatId, fromChatId, messageId, options = {}) {
      const record = { method: 'forwardMessage', chatId, fromChatId, messageId, options };
      calls.push(record);
      return { ok: true, result: { message_id: Math.floor(Math.random() * 10000) + 1 } };
    }
  };
}

/**
 * Creates an in-memory mock database.
 */
function createMockDb(initialData = {}) {
  const store = new Map(Object.entries(initialData));
  const collections = new Map();

  return {
    async get(key) {
      return store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : null;
    },
    async set(key, value) {
      store.set(key, JSON.parse(JSON.stringify(value)));
      return true;
    },
    async delete(key) {
      return store.delete(key);
    },
    async find(collectionName, filter = {}) {
      const items = collections.get(collectionName) || [];
      return items.filter(item => {
        for (const [k, v] of Object.entries(filter)) {
          if (item[k] !== v) return false;
        }
        return true;
      });
    },
    async save(collectionName, item) {
      if (!collections.has(collectionName)) {
        collections.set(collectionName, []);
      }
      const items = collections.get(collectionName);
      const cloned = JSON.parse(JSON.stringify(item));
      if (!cloned.id) {
        cloned.id = 'id_' + Math.random().toString(36).substr(2, 9);
      }
      const existingIdx = items.findIndex(i => i.id === cloned.id);
      if (existingIdx >= 0) {
        items[existingIdx] = cloned;
      } else {
        items.push(cloned);
      }
      return cloned;
    }
  };
}

module.exports = {
  createMockApi,
  createMockDb
};
