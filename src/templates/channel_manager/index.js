'use strict';

const { handle } = require('./channel_manager');

module.exports = {
  id: 'channel_manager',
  category: 'channel_manager',
  name: 'مدیریت محدود کانال (Channel Manager)',
  description: 'مجموعه دستورات منتخب مدیریت کانال شامل ارسال پست، پین پیام و چک دسترسی بدون ادعای مدیریت کامل.',
  features: [
    'ارسال مستقیم پست به کانال',
    'پین کردن پیام‌های مهم',
    'استعلام و سنجش سطح دسترسی ادمین ربات',
    'بیان شفاف حدود و عدم ادعای مدیریت کامل'
  ],
  handle
};
