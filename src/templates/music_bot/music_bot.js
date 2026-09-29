'use strict';

const { escapeHtml } = require('../../utils/html');
const { LANGUAGES, t } = require('./i18n');
const services = require('./services');

const busyUsers = new Set(); // prevents one user from starting many parallel downloads

function langKeyboard() {
  const codes = Object.keys(LANGUAGES);
  const rows = [];
  for (let i = 0; i < codes.length; i += 2) {
    rows.push(codes.slice(i, i + 2).map(c => ({ text: LANGUAGES[c], callback_data: `mb:lang:${c}`, style: 'primary' })));
  }
  return { inline_keyboard: rows };
}

function menuKeyboard(lang) {
  return {
    inline_keyboard: [[
      { text: t(lang, 'btnMusic'), callback_data: 'mb:music', style: 'success' },
      { text: t(lang, 'btnInstagram'), callback_data: 'mb:instagram', style: 'primary' }
    ]]
  };
}

async function getUser(db, userId) {
  return (await db.get(`user_${userId}`)) || { lang: 'fa', mode: null };
}
async function setUser(db, userId, patch) {
  const cur = await getUser(db, userId);
  await db.set(`user_${userId}`, { ...cur, ...patch });
}

function errorKey(err) {
  if (err && err.message === 'ENGINE_MISSING') return 'unavailable';
  if (err && err.message === 'TOO_BIG') return 'tooBig';
  if (err && err.message === 'BAD_URL') return 'badLink';
  return null;
}

async function sendAudioFile(api, chatId, url, lang, fallbackErrKey) {
  let file;
  try {
    file = await services.downloadAudio(url);
    const res = await api.sendAudio(chatId, { path: file.path }, { title: file.title });
    if (res && res.ok === false) throw new Error('SEND_FAILED');
  } catch (err) {
    await api.sendMessage(chatId, t(lang, errorKey(err) || fallbackErrKey));
  } finally {
    if (file) file.cleanup();
  }
}

async function handle({ update, api, db }) {
  const callback = update.callback_query;
  const message = update.message;

  // ---------- Inline button presses ----------
  if (callback) {
    const chatId = callback.message?.chat?.id;
    const userId = callback.from?.id;
    const data = callback.data || '';
    if (!chatId || !userId || !data.startsWith('mb:')) return;

    const user = await getUser(db, userId);
    const lang = user.lang;
    await api.answerCallbackQuery(callback.id).catch(() => {});

    if (data.startsWith('mb:lang:')) {
      const code = data.slice(8);
      if (!LANGUAGES[code]) return;
      await setUser(db, userId, { lang: code, mode: null });
      return api.editMessageText(chatId, callback.message.message_id, t(code, 'langChosen'), { reply_markup: menuKeyboard(code) });
    }

    if (data === 'mb:music' || data === 'mb:instagram') {
      const mode = data === 'mb:music' ? 'music' : 'instagram';
      await setUser(db, userId, { mode });
      return api.editMessageText(chatId, callback.message.message_id, t(lang, mode === 'music' ? 'askMusic' : 'askInstagram'), { reply_markup: menuKeyboard(lang) });
    }

    if (data.startsWith('mb:pick:')) {
      const id = data.slice(8);
      if (!/^[\w-]{6,20}$/.test(id)) return;
      if (busyUsers.has(userId)) return api.sendMessage(chatId, t(lang, 'busy'));
      busyUsers.add(userId);
      try {
        await api.sendMessage(chatId, t(lang, 'downloading'));
        await sendAudioFile(api, chatId, `https://www.youtube.com/watch?v=${id}`, lang, 'dlFailed');
      } finally {
        busyUsers.delete(userId);
      }
    }
    return;
  }

  // ---------- Text messages ----------
  if (!message) return;
  const chatId = message.chat?.id;
  const userId = message.from?.id;
  const text = (message.text || '').trim();
  if (!chatId || !userId) return;

  if (text.startsWith('/start') || text === '/lang') {
    return api.sendMessage(chatId, `${t('en', 'chooseLang')}\n${t('fa', 'chooseLang')}`, { reply_markup: langKeyboard() });
  }

  const user = await getUser(db, userId);
  const lang = user.lang;
  if (!user.mode) return api.sendMessage(chatId, t(lang, 'pickFirst'));
  if (!text) return;

  if (user.mode === 'music') {
    await api.sendMessage(chatId, t(lang, 'searching'));
    try {
      const results = await services.searchMusic(text, 10);
      if (!results.length) return api.sendMessage(chatId, t(lang, 'noResults'));
      const keyboard = results.map(r => {
        const id = (r.url.match(/[?&]v=([\w-]{6,20})/) || [])[1];
        return id ? [{ text: r.title.slice(0, 55), callback_data: `mb:pick:${id}`, style: 'primary' }] : null;
      }).filter(Boolean);
      if (!keyboard.length) return api.sendMessage(chatId, t(lang, 'noResults'));
      return api.sendMessage(chatId, t(lang, 'results'), { reply_markup: { inline_keyboard: keyboard } });
    } catch (err) {
      return api.sendMessage(chatId, t(lang, errorKey(err) || 'searchFailed'));
    }
  }

  if (user.mode === 'instagram') {
    if (!services.isSafeHttpUrl(text)) return api.sendMessage(chatId, t(lang, 'badLink'));
    if (busyUsers.has(userId)) return api.sendMessage(chatId, t(lang, 'busy'));
    busyUsers.add(userId);
    try {
      await api.sendMessage(chatId, t(lang, 'preparing'));
      await sendAudioFile(api, chatId, text, lang, 'linkFailed');
    } finally {
      busyUsers.delete(userId);
    }
  }
}

module.exports = { handle, langKeyboard, menuKeyboard };
