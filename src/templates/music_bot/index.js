'use strict';

const { handle } = require('./music_bot');

module.exports = {
  id: 'music_bot',
  category: 'downloader',
  name: 'ربات جستجوی موزیک و دانلود صوتی اینستاگرام (Music & Instagram Audio)',
  description: 'انتخاب زبان (۱۰ زبان)، جستجوی آهنگ با ۱۰ نتیجه و دانلود MP3، و استخراج صدای پست/ریل اینستاگرام با yt-dlp.',
  features: [
    'انتخاب زبان در شروع ربات (فارسی، English، العربية، Türkçe، Русский، Deutsch، Français، Español، Português، हिन्दी)',
    'جستجوی آهنگ و نمایش ۱۰ نتیجه به صورت دکمه',
    'دانلود صوتی MP3 با yt-dlp و ffmpeg',
    'استخراج صدای لینک پست/ریل اینستاگرام (در صورت پشتیبانی yt-dlp)',
    'اعتبارسنجی لینک و محافظت SSRF، محدودیت ۵۰ مگابایت طبق تلگرام'
  ],
  handle
};
