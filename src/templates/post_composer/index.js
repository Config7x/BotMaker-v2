'use strict';

const { handle } = require('./post_composer');

module.exports = {
  id: 'post_composer',
  category: 'post_composer',
  name: 'پست‌ساز شیشه‌ای (Post Composer)',
  description: 'ساخت و پیش‌نمایش پست با دکمه‌های شیشه‌ای رنگ‌بندی‌شده با ایموجی و انتشار صریح در کانال.',
  features: [
    'پیش‌نمایش کامل قبل از انتشار',
    'رنگ‌بندی دکمه‌ها منحصراً از طریق ایموجی (🔴 🟢 🔵)',
    'چک کردن دسترسی ادمین کانال پیش از انتشار',
    'انتشار صریح پست پس از تایید کاربر'
  ],
  handle
};
