'use strict';
module.exports = {
  id:'downloader', category:'downloader', name:'دانلودر لینک مستقیم HTTPS',
  description:'ارسال فایل مستقیم قابل دسترسی برای تلگرام، بدون پشتیبانی سایت‌های ویدئویی',
  handle: require('./downloader').handle
};
