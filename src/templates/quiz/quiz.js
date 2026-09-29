'use strict';

const { escapeHtml } = require('../../utils/html');

const DEFAULT_QUESTIONS = [
  {
    id: 0,
    question: 'پایتخت کشور ایران کدام شهر است؟',
    options: ['اصفهان', 'شیراز', 'تهران', 'تبریز'],
    correct: 2,
    explanation: 'شهر تهران از سال ۱۱۶۵ شمسی پایتخت ایران بوده است.'
  },
  {
    id: 1,
    question: 'کدام زبان برنامه‌نویسی برای هوش مصنوعی و یادگیری ماشین بسیار محبوب است؟',
    options: ['C++', 'Python', 'PHP', 'HTML'],
    correct: 1,
    explanation: 'پایتون به دلیل کتابخانه‌های غنی مانند PyTorch و TensorFlow کاربرد فراوانی دارد.'
  },
  {
    id: 2,
    question: 'بزرگ‌ترین اقیانوس جهان کدام است؟',
    options: ['اقیانوس اطلس', 'اقیانوس آرام', 'اقیانوس هند', 'اقیانوس منجمد شمالی'],
    correct: 1,
    explanation: 'اقیانوس آرام (کبیر) پهناورترین اقیانوس زمین است.'
  }
];

async function getQuestions(db) {
  let questions = await db.find('quiz_questions', {});
  if (!questions || questions.length === 0) {
    for (const q of DEFAULT_QUESTIONS) {
      await db.save('quiz_questions', q);
    }
    questions = DEFAULT_QUESTIONS;
  }
  return questions;
}

async function renderQuestion(api, chatId, q, currentNum, total) {
  const keyboard = q.options.map((opt, idx) => ([
    { text: `${idx + 1}. ${opt}`, callback_data: `quiz:ans:${q.id}:${idx}` }
  ]));

  const text = `<b>❓ سوال ${currentNum} از ${total}:</b>\n\n` +
    `<b>${escapeHtml(q.question)}</b>`;

  return api.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function handle({ update, bot, api, db }) {
  const message = update.message;
  const callback = update.callback_query;

  // 1. Handle Callback Answer Clicks
  if (callback) {
    const chatId = callback.message?.chat?.id;
    const data = callback.data || '';
    const userId = callback.from?.id;
    const userObj = callback.from || {};

    if (data.startsWith('quiz:ans:')) {
      const parts = data.split(':');
      const qId = Number(parts[2]);
      const selectedOption = Number(parts[3]);

      const questions = await getQuestions(db);
      const question = questions.find(q => Number(q.id) === qId);

      const stateKey = `quiz_session_${userId}`;
      let session = (await db.get(stateKey)) || { score: 0, currentIdx: 0 };

      if (!question) {
        await api.answerCallbackQuery(callback.id, { text: 'سوال یافت نشد.' });
        return;
      }

      const isCorrect = selectedOption === question.correct;
      if (isCorrect) {
        session.score += 10;
        await api.answerCallbackQuery(callback.id, { text: '✅ پاسخ صحیح بود! (+۱۰ امتیاز)' });
      } else {
        await api.answerCallbackQuery(callback.id, { text: `❌ پاسخ نادرست! (پاسخ درست: ${question.options[question.correct]})` });
      }

      // Send answer result feedback message
      const feedback = isCorrect ?
        `<b>✅ آفرین! پاسخ صحیح بود.</b>\n<i>${escapeHtml(question.explanation)}</i>` :
        `<b>❌ پاسخ شما نادرست بود.</b>\n<b>پاسخ صحیح:</b> ${escapeHtml(question.options[question.correct])}\n<i>${escapeHtml(question.explanation)}</i>`;

      await api.sendMessage(chatId, feedback, { parse_mode: 'HTML' });

      session.currentIdx += 1;
      await db.set(stateKey, session);

      // Check if quiz completed
      if (session.currentIdx >= questions.length) {
        // Save leaderboard score
        const username = userObj.username || userObj.first_name || `کاربر ${userId}`;
        await db.save('quiz_leaderboard', {
          userId,
          username,
          score: session.score,
          date: new Date().toISOString()
        });

        const finalMsg = `<b>🎉 پایان مسابقه!</b>\n\n` +
          `<b>امتیاز نهایی شما:</b> <code>${session.score}</code> از <code>${questions.length * 10}</code>\n\n` +
          `جهت شروع مجدد، دستور <code>/quiz</code> را ارسال کنید.\n` +
          `جهت مشاهده رتبه‌بندی، دستور <code>/leaderboard</code> را ارسال کنید.`;

        await db.delete(stateKey);
        return api.sendMessage(chatId, finalMsg, { parse_mode: 'HTML' });
      } else {
        // Next question
        const nextQ = questions[session.currentIdx];
        return renderQuestion(api, chatId, nextQ, session.currentIdx + 1, questions.length);
      }
    }
  }

  // 2. Handle Messages
  if (message) {
    const chatId = message.chat?.id;
    const text = (message.text || '').trim();
    const userId = message.from?.id;

    if (text.startsWith('/start') || text === '/quiz') {
      const questions = await getQuestions(db);
      // Reset user state
      const stateKey = `quiz_session_${userId}`;
      await db.set(stateKey, { score: 0, currentIdx: 0 });

      const welcome = `<b>🧠 به ربات کوویز و مسابقه خوش آمدید!</b>\n\n` +
        `تعداد سوالات این دوره: <b>${questions.length}</b> سوال\n` +
        `هر پاسخ صحیح: <b>۱۰ امتیاز</b>\n\n` +
        `آیا برای پاسخ‌گویی به سوالات آماده هستید؟ به اولین سوال پاسخ دهید:`;

      await api.sendMessage(chatId, welcome, { parse_mode: 'HTML' });
      return renderQuestion(api, chatId, questions[0], 1, questions.length);
    }

    if (text === '/leaderboard') {
      const scores = await db.find('quiz_leaderboard', {});
      if (!scores || scores.length === 0) {
        return api.sendMessage(chatId, '📊 هنوز هیچ امتیازی در جدول رتبه‌بندی ثبت نشده است.', { parse_mode: 'HTML' });
      }

      // Sort descending by score
      scores.sort((a, b) => b.score - a.score);

      const topList = scores.slice(0, 10).map((s, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : '👤';
        return `${medal} <b>${escapeHtml(s.username)}</b> - <code>${s.score}</code> امتیاز`;
      }).join('\n');

      return api.sendMessage(chatId, `<b>🏆 جدول برترین‌های مسابقه:</b>\n\n${topList}`, { parse_mode: 'HTML' });
    }

    if (text === '/help') {
      const help = `<b>📖 راهنمای ربات مسابقه:</b>\n\n` +
        `/quiz - شروع مسابقه هوش و اطلاعات عمومی\n` +
        `/leaderboard - مشاهده جدول برترین‌ها\n` +
        `/help - راهنما`;
      return api.sendMessage(chatId, help, { parse_mode: 'HTML' });
    }
  }
}

module.exports = { handle, DEFAULT_QUESTIONS };
