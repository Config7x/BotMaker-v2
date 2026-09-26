'use strict';

const { escapeHtml } = require('../../utils/html');

module.exports = {
  id: 'quiz',
  category: 'engagement',
  name: 'کوئیز (Quiz Bot)',
  description: 'ساخت آزمون چندگزینه‌ای، ثبت امتیاز و جدول رتبه‌بندی.',
  features: ['افزودن سؤال', 'اجرای آزمون با نظرسنجی تلگرام', 'امتیازدهی و لیدربورد'],
  async handle({ update, bot, api, db }) {
    const msg = update.message;
    const isOwner = (id) => Number(id) === Number(bot.owner_id);

    // poll answer scoring
    if (update.poll_answer) {
      const pa = update.poll_answer;
      const poll = await db.get(`poll_${pa.poll_id}`);
      if (!poll || poll.expired) return;
      if (poll.correctOptionIds && poll.correctOptionIds.includes(pa.option_ids?.[0]) && poll.quizMode) {
        const scores = (await db.get('scores')) || {};
        scores[pa.user.id] = (scores[pa.user.id] || 0) + 1;
        await db.set('scores', scores);
      }
      return;
    }

    if (!msg) return;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (text.startsWith('/start') || text === '/help') {
      return api.sendMessage(chatId,
        `🧠 <b>ربات کوئیز</b>\n• سؤال جدید: <code>/addq سؤال | گزینه۱ | گزینه۲ | ... | پاسخ: شماره</code>\n• شروع: <code>/quiz</code>\n• جدول امتیاز: <code>/leaderboard</code>`,
        { parse_mode: 'HTML' });
    }

    if (text.startsWith('/addq') && isOwner(msg.from.id)) {
      const body = text.replace('/addq', '').trim();
      const parts = body.split('|').map((s) => s.trim());
      const ansIdx = parts.findIndex((p) => /^پاسخ\s*:?\s*\d+/i.test(p));
      const correct = ansIdx !== -1 ? parseInt(parts[ansIdx].replace(/\D+/g, ''), 10) : -1;
      const opts = parts.filter((_, i) => i !== ansIdx);
      if (opts.length < 3 || correct < 1 || correct > opts.length) {
        return api.sendMessage(chatId, 'فرمت: <code>/addq سؤال | گزیده۱ | گزینه۲ | ... | پاسخ: ۲</code>\nحداقل ۳ گزینه لازم است.', { parse_mode: 'HTML' });
      }
      await db.save('questions', { question: opts[0], options: opts.slice(1), correct });
      return api.sendMessage(chatId, '✅ سؤال ذخیره شد.');
    }

    if (text === '/quiz') {
      const questions = await db.find('questions', {});
      if (!questions.length) return api.sendMessage(chatId, 'هنوز سوالی ثبت نشده است.');
      const q = questions[Math.floor(Math.random() * questions.length)];
      const r = await api.call('sendPoll', {
        chat_id: chatId,
        question: q.question,
        options: JSON.stringify(q.options),
        is_anonymous: false,
        type: 'quiz',
        correct_option_id: q.correct - 1
      });
      await db.set(`poll_${r.result?.message_id ?? Date.now()}`, { quizMode: true, correctOptionIds: [q.correct - 1], expired: false });
      return;
    }

    if (text === '/leaderboard') {
      const scores = (await db.get('scores')) || {};
      const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (!entries.length) return api.sendMessage(chatId, 'هنوز امتیازی ثبت نشده است.');
      return api.sendMessage(chatId, '🏆 <b>جدول امتیاز</b>\n' + entries.map((e, i) => `${i + 1}. کاربر <code>${e[0]}</code> — <b>${e[1]}</b>`).join('\n'), { parse_mode: 'HTML' });
    }
  }
};
