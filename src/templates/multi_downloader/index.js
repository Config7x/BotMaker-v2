'use strict';

const { handle } = require('./multi_downloader');

module.exports = {
  id: 'multi_downloader',
  category: 'downloader',
  name: 'دانلودر چندپلتفرمه رسانه (Multi-Platform Media Downloader)',
  description: 'استخراج و دریافت ویدیو و رسانه از اینستاگرام، تیک‌تاک، یوتیوب، ساندکلاد، توییتر و لینک مستقیم زیر ۲۰ مگابایت.',
  features: [
    'پشتیبانی از پلتفرم‌های متنوع (Instagram, TikTok, YouTube, SoundCloud, Twitter, Pinterest)',
    'منوی انتخاب کیفیت ویدیو و استخراج صوت MP3',
    'محافظت جامع SSRF و چک دامنه‌های عمومی',
    'محدودیت حجم ۲۰ مگابایت مطابق ضوابط API تلگرام'
  ],
  handle
};
