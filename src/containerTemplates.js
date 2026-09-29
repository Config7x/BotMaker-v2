'use strict';

/**
 * Containerized template registry (§3.10 VPN Shop & §3.11 Config Auto-Scraper).
 * These run as their own gVisor container per bot — NOT as in-process webhook
 * modules. Pre-built + code-reviewed: no AI scan / no admin approval (unlike
 * the Custom Source feature). Pro/VIP only — free/demo is refused outright.
 */

const containerTemplates = {
  vpn_shop: {
    id: 'vpn_shop',
    containerized: true,
    paidOnly: true,          // Pro/VIP only — never free/demo
    wizard: 'panel',
    image: 'botmaker/vpn_shop:latest',   // pre-built, code-reviewed (PHP + MySQL + cron + Mini App)
    mem: '512m', cpus: 1.0, shm: '256m', // MySQL headroom
    name: 'فروشگاه اشتراک VPN (VPN Shop)',
    description: 'فروش اشتراک VPN با اتصال به پنل مدیریت شما (Marzban / PasarGuard / WGDashboard / Remnawave / x-ui)، مینی‌اپ تلگرام و کرون تمدیدها. کانتینر اختصاصی با MySQL خودش.',
    features: [
      'اتصال به پنل VPN که خودتان مدیریت می‌کنید (Marzban, PasarGuard, WGDashboard, Remnawave, x-ui)',
      'فروش اشتراک، کیف پول، مینی‌اپ تلگرام و پنل آمار داخل کانتینر اختصاصی',
      'دیتابیس MySQL و کرون تمدید/انقضا مخصوص خود ربات',
      'فقط پلن‌های Pro / VIP (بدون دمو)'
    ],
    panelTypes: ['marzban', 'pasarguard', 'wgdashboard', 'remnawave', 'x-ui']
  },
  config_scraper: {
    id: 'config_scraper',
    containerized: true,
    paidOnly: true,
    wizard: 'telethon',
    image: 'botmaker/config_scraper:latest', // pre-built, code-reviewed (Python Telethon)
    mem: '384m', cpus: 0.8, shm: '128m',
    name: 'اسکرپر و پستر خودکار کانفیگ (Config Auto-Scraper)',
    description: 'رصد کانال‌های منبع شما برای کانفیگ‌های VPN و انتشار خودکار موارد تأییدشده در کانال مقصد، با سشن اکانت تلگرام خودتان (Telethon). کانتینر اختصاصی.',
    features: [
      'رصد خودکار کانال‌های منبع و ارسال به صف تأیید',
      'تأیید/رد ادمین و انتشار خط‌به‌خط کانفیگ‌ها با دکمه کپی هش‌محور',
      'لاگین با شماره موبایل + کد + رمز دوم (سشن اکانت خودتان)',
      'فقط پلن‌های Pro / VIP (بدون دمو) — مدیریت کانال‌های منبع از پنل'
    ],
    tosRisk: '⚠️ اسکرپر با <b>اکانت شخصی تلگرام خودتان</b> کار می‌کند، نه با ربات BotFather. استفاده خودکار از اکانت شخصی طبق قوانین تلگرام <b>ریسک محدودیت/مسدودی</b> دارد و این ریسک با شماست، نه پلتفرم. ادامه می‌دهید؟'
  }
};

const isContainerized = (id) => !!containerTemplates[id];

module.exports = {
  containerTemplates,
  isContainerized
};
