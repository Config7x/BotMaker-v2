'use strict';

const { handle } = require('./uploader');

module.exports = {
  id: 'uploader',
  category: 'uploader',
  name: 'آپلودر و ذخیره‌ساز فایل (File Uploader)',
  description: 'دریافت و ذخیره ایمن فایل‌ها در محدوده حجم تلگرام با دریافت کد دسترسی.',
  features: [
    'ذخیره و فوروارد ایمن فایل‌ها تا سقف ۲۰ مگابایت',
    'صدور کد دسترسی اختصاصی جهت بازخوانی فایل',
    'عدم ادعای فضای ذخیره‌سازی نامحدود یا دائمی',
    'نمایش لیست فایل‌های آپلودشده کاربر'
  ],
  handle
};
