'use strict';

const { handle } = require('./music_downloader');

module.exports = {
  id: 'music_downloader',
  category: 'downloader',
  name: 'دانلودر موزیک (Music Downloader)',
  description: 'جستجو و دانلود آهنگ، تحویل به‌صورت فایل صوتی تلگرام، علاقه‌مندی‌ها و قفل عضویت اجباری.',
  features: [
    'جستجوی موزیک با نام آهنگ یا خواننده',
    'قفل عضویت اجباری کانال (force join)',
    'لیست علاقه‌مندی‌ها و دستورات مالک (/addtrack, /setchannel, /stats)'
  ],
  handle
};
