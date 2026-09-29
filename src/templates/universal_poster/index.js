'use strict';

const { handle } = require('./universal_poster');

module.exports = {
  id: 'universal_poster',
  category: 'poster',
  name: 'پست‌ساز جامع و پارسر کانفیگ (Universal Poster & Config Parser)',
  description: 'پست‌ساز هوشمند با پشتیبانی پارس کانفیگ‌های multi-protocol (VLESS/VMess/Trojan/WireGuard/OpenVPN)، استخر کانفیگ رایگان و تنظیمات اختصاصی مالک.',
  features: [
    'پارس خودکار کانفیگ‌های VLESS, VMess, Trojan, SS, Hysteria, Tuic, WireGuard و OpenVPN',
    'پشتیبانی از قالب‌بندی سفارشی کپشن و برندینگ کانال',
    'مدیریت استخر کانفیگ رایگان برای کاربران',
    'پنل تنظیمات کامل ویژه مالک ربات (Owner Settings)'
  ],
  handle
};
