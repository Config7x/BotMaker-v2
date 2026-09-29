'use strict';

const { handle } = require('./quiz');

module.exports = {
  id: 'quiz',
  category: 'entertainment',
  name: 'ربات کوویز و مسابقه (Quiz Bot)',
  description: 'مسابقه چهارگزینه‌ای با ثبت امتیازات، بازخورد لحظه‌ای و جدول برترین‌ها (Leaderboard).',
  features: [
    'سوالات چندگزینه‌ای با دکمه‌های شیشه‌ای',
    'ارائه بازخورد آنی و توضیحات علمی پاسخ',
    'محاسبه امتیاز و ثبت در جدول رتبه‌بندی کاربران',
    'قابلیت توسعه لیست سوالات در دیتابیس'
  ],
  handle
};
