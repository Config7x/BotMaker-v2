'use strict';

const { escapeHtml } = require('../../utils/html');

const DEFAULT_TRACKS = [
  {
    id: 'tr1',
    title: 'Ghamgin - Remix 2026',
    artist: 'Artist One',
    duration: '03:45',
    audioUrl: 'https://example.com/audio1.mp3'
  },
  {
    id: 'tr2',
    title: 'Shad & Energy - Track 02',
    artist: 'Artist Two',
    duration: '02:50',
    audioUrl: 'https://example.com/audio2.mp3'
  },
  {
    id: 'tr3',
    title: 'Aramesh - Piano Deep',
    artist: 'Artist Three',
    duration: '04:12',
    audioUrl: 'https://example.com/audio3.mp3'
  }
];

/**
 * Helper to retrieve or initialize music tracks in DB
 */
async function getTracks(db) {
  let tracks = await db.find('music_tracks', {});
  if (!tracks || tracks.length === 0) {
    for (const tr of DEFAULT_TRACKS) {
      await db.save('music_tracks', tr);
    }
    tracks = DEFAULT_TRACKS;
  }
  return tracks;
}

/**
 * Check if user is joined in required channel
 */
async function checkForceJoin(api, db, userId) {
  const settings = (await db.get('settings')) || {};
  const channel = settings.requiredChannel;
  if (!channel) return { required: false, joined: true };

  try {
    const member = await api.getChatMember(channel, userId);
    const status = member?.status || 'left';
    const joined = ['creator', 'administrator', 'member', 'restricted'].includes(status);
    return { required: true, channel, joined };
  } catch (_) {
    // If API error (e.g. mock or non-admin in channel), fallback to allowing access
    return { required: true, channel, joined: true };
  }
}

/**
 * Main Music Downloader Handler
 */
async function handle({ update, bot, api, db }) {
  const message = update.message;
  const callback = update.callback_query;
  const isOwner = (userId) => Number(userId) === Number(bot.owner_id);

  // 1. Handle Inline Button Callbacks
  if (callback) {
    const chatId = callback.message?.chat?.id;
    const data = callback.data || '';
    const queryId = callback.id;
    const userId = callback.from?.id;

    // Force Join Verification
    const fjCheck = await checkForceJoin(api, db, userId);
    if (fjCheck.required && !fjCheck.joined && data !== 'music:check_join') {
      await api.answerCallbackQuery(queryId, { text: '⚠️ ابتدا باید در کانال عضو شوید!', show_alert: true });
      const joinMsg = `<b>⚠️ قفل عضویت اجباری:</b>\n\n` +
        `برای استفاده از ربات و دانلود موزیک، ابتدا باید در کانال زیر عضو شوید:\n` +
        `<b>کانال:</b> ${escapeHtml(fjCheck.channel)}`;

      const keyboard = [
        [{ text: '📢 عضویت در کانال', url: fjCheck.channel.startsWith('http') ? fjCheck.channel : `https://t.me/${fjCheck.channel.replace('@', '')}` }],
        [{ text: '✅ تایید عضویت', callback_data: 'music:check_join' }]
      ];

      return api.sendMessage(chatId, joinMsg, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    if (data === 'music:check_join') {
      const reCheck = await checkForceJoin(api, db, userId);
      if (reCheck.required && !reCheck.joined) {
        return api.answerCallbackQuery(queryId, { text: '❌ هنوز در کانال عضو نشده‌اید!', show_alert: true });
      }
      await api.answerCallbackQuery(queryId, { text: '✅ عضویت شما تایید شد!' });
      return api.sendMessage(chatId, '<b>🎉 عضویت تایید شد!</b>\nاکنون می‌توانید نام موزیک یا خواننده مورد نظر را ارسال کنید.', { parse_mode: 'HTML' });
    }

    if (data.startsWith('music:dl:')) {
      await api.answerCallbackQuery(queryId, { text: 'در حال ارسال فایل صوتی...' });
      const trackId = data.replace('music:dl:', '');
      const tracks = await getTracks(db);
      const track = tracks.find(t => String(pId(t)) === String(trackId));

      function pId(item) { return item.id; }

      if (!track) {
        return api.sendMessage(chatId, '❌ موزیک مورد نظر یافت نشد.');
      }

      const caption = `<b>🎵 ${escapeHtml(track.title)}</b>\n` +
        `<b>🎤 خواننده:</b> ${escapeHtml(track.artist)}\n` +
        `<b>⏱ زمان:</b> ${escapeHtml(track.duration)}\n\n` +
        `<i>@${escapeHtml(bot.name || 'Bot')}</i>`;

      const keyboard = [
        [{ text: '⭐ افزودن به علاقه‌مندی‌ها', callback_data: `music:fav:${track.id}` }]
      ];

      return api.sendDocument(chatId, track.audioUrl, {
        caption,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      }).catch(async () => {
        return api.sendMessage(chatId, `${caption}\n\n<b>لینک دانلود مستقیم:</b>\n<a href="${escapeHtml(track.audioUrl)}">دانلود موزیک</a>`, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: keyboard }
        });
      });
    }

    if (data.startsWith('music:fav:')) {
      const trackId = data.replace('music:fav:', '');
      const favoritesKey = `favs_${userId}`;
      const currentFavs = (await db.get(favoritesKey)) || [];

      if (currentFavs.includes(trackId)) {
        const updated = currentFavs.filter(id => id !== trackId);
        await db.set(favoritesKey, updated);
        await api.answerCallbackQuery(queryId, { text: '❌ از لیست علاقه‌مندی‌ها حذف شد.' });
      } else {
        currentFavs.push(trackId);
        await db.set(favoritesKey, currentFavs);
        await api.answerCallbackQuery(queryId, { text: '⭐ به لیست علاقه‌مندی‌ها اضافه شد!' });
      }
      return;
    }

    if (data === 'music:list_favs') {
      await api.answerCallbackQuery(queryId);
      const favoritesKey = `favs_${userId}`;
      const currentFavs = (await db.get(favoritesKey)) || [];
      const tracks = await getTracks(db);
      const userTracks = tracks.filter(t => currentFavs.includes(String(t.id)));

      if (!userTracks || userTracks.length === 0) {
        return api.sendMessage(chatId, '⭐ هیچ موزیکی در لیست علاقه‌مندی‌های شما قرار ندارد.', { parse_mode: 'HTML' });
      }

      const keyboard = userTracks.map(t => ([
        { text: `🎵 ${t.title} - ${t.artist}`, callback_data: `music:dl:${t.id}` }
      ]));

      return api.sendMessage(chatId, '<b>⭐ لیست موزیک‌های مورد علاقه شما:</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  }

  // 2. Handle Text Messages
  if (message) {
    const chatId = message.chat?.id;
    const text = (message.text || '').trim();
    const userId = message.from?.id;

    // Force Join Verification for commands/text
    const fjCheck = await checkForceJoin(api, db, userId);
    if (fjCheck.required && !fjCheck.joined) {
      const joinMsg = `<b>⚠️ قفل عضویت اجباری:</b>\n\n` +
        `برای استفاده از ربات، ابتدا باید در کانال زیر عضو شوید:\n` +
        `<b>کانال:</b> ${escapeHtml(fjCheck.channel)}`;

      const keyboard = [
        [{ text: '📢 عضویت در کانال', url: fjCheck.channel.startsWith('http') ? fjCheck.channel : `https://t.me/${fjCheck.channel.replace('@', '')}` }],
        [{ text: '✅ تایید عضویت', callback_data: 'music:check_join' }]
      ];

      return api.sendMessage(chatId, joinMsg, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    if (text.startsWith('/start') || text === '/help') {
      const welcome = `<b>🎵 به ربات جستجو و دانلود موزیک خوش آمدید!</b>\n\n` +
        `نام آهنگ یا خواننده مورد نظر خود را ارسال کنید تا لیست موزیک‌ها نمایش داده شود.\n\n` +
        `<b>دستورات کاربر:</b>\n` +
        `• <code>/favorites</code> - لیست موزیک‌های مورد علاقه\n` +
        `• <code>/help</code> - راهنمای استفاده`;

      const keyboard = [
        [{ text: '⭐ لیست علاقه‌مندی‌ها', callback_data: 'music:list_favs' }]
      ];

      return api.sendMessage(chatId, welcome, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    if (text === '/favorites') {
      const favoritesKey = `favs_${userId}`;
      const currentFavs = (await db.get(favoritesKey)) || [];
      const tracks = await getTracks(db);
      const userTracks = tracks.filter(t => currentFavs.includes(String(t.id)));

      if (!userTracks || userTracks.length === 0) {
        return api.sendMessage(chatId, '⭐ هیچ موزیکی در لیست علاقه‌مندی‌های شما موجود نیست.', { parse_mode: 'HTML' });
      }

      const keyboard = userTracks.map(t => ([
        { text: `🎵 ${t.title} - ${t.artist}`, callback_data: `music:dl:${t.id}` }
      ]));

      return api.sendMessage(chatId, '<b>⭐ لیست موزیک‌های مورد علاقه شما:</b>', {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }

    // Owner Commands
    if (text.startsWith('/setchannel')) {
      if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز به تنظیم کانال اجباری است.');
      const channel = text.replace('/setchannel', '').trim();
      const current = (await db.get('settings')) || {};
      await db.set('settings', { ...current, requiredChannel: channel || null });

      if (channel) {
        return api.sendMessage(chatId, `✅ کانال قفل اجباری با موفقیت به <b>${escapeHtml(channel)}</b> تغییر یافت.`, { parse_mode: 'HTML' });
      } else {
        return api.sendMessage(chatId, '✅ قفل کانال اجباری غیرفعال شد.');
      }
    }

    if (text.startsWith('/addtrack')) {
      if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک ربات مجاز است.');
      const body = text.replace('/addtrack', '').trim();
      const parts = body.split('|').map(s => s.trim());

      if (parts.length < 4) {
        return api.sendMessage(chatId, '❌ فرمت نادرست.\nفرمت صحیح:\n<code>/addtrack عنوان | خواننده | زمان | لینک_صوتی</code>', { parse_mode: 'HTML' });
      }

      const newTrack = {
        title: parts[0],
        artist: parts[1],
        duration: parts[2],
        audioUrl: parts[3]
      };

      const saved = await db.save('music_tracks', newTrack);
      return api.sendMessage(chatId, `✅ موزیک با موفقیت اضافه شد:\n<b>${escapeHtml(saved.title)} - ${escapeHtml(saved.artist)}</b>`, { parse_mode: 'HTML' });
    }

    if (text === '/stats') {
      if (!isOwner(userId)) return api.sendMessage(chatId, '⛔️ فقط مالک مجاز است.');
      const tracks = await getTracks(db);
      const settings = (await db.get('settings')) || {};
      return api.sendMessage(chatId, `<b>📊 آمار ربات موزیک:</b>\n\nتعداد کل موزیک‌ها: <b>${tracks.length}</b>\nکانال اجباری: <b>${escapeHtml(settings.requiredChannel || 'تنظیم نشده')}</b>`, { parse_mode: 'HTML' });
    }

    // Search Music Query
    const query = text.toLowerCase();
    const tracks = await getTracks(db);
    const matched = tracks.filter(t =>
      t.title.toLowerCase().includes(query) ||
      t.artist.toLowerCase().includes(query)
    );

    if (!matched || matched.length === 0) {
      return api.sendMessage(chatId, `❌ موزیکی متناسب با عبارت «<b>${escapeHtml(text)}</b>» یافت نشد.`, { parse_mode: 'HTML' });
    }

    const keyboard = matched.map(t => ([
      { text: `🎵 ${t.title} - ${t.artist} (${t.duration})`, callback_data: `music:dl:${t.id}` }
    ]));

    const searchMsg = `<b>🔍 نتایج جستجو برای «${escapeHtml(text)}»:</b>\n\nلطفاً جهت دانلود روی موزیک مورد نظر کلیک کنید:`;

    return api.sendMessage(chatId, searchMsg, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  }
}

module.exports = { handle, getTracks };
