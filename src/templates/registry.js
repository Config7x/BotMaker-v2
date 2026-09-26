'use strict';

/**
 * STATIC template registry. Only pre-built, code-reviewed modules are
 * require()'d here — no dynamic user code ever.
 *
 * §3.1-9: lightweight in-process templates (webhook-dispatched).
 * §3.10-11: containerized templates — separate runtimes (PHP+MySQL / Python
 * Telethon), provisioned as their own gVisor container per instance via the
 * provisioner. They are pre-built and code-reviewed: NO AI scan / admin
 * approval (unlike §6 custom source), and they are Pro/VIP-ONLY (never free/
 * demo). See containerTemplates below.
 */
const registry = {
  shop: require('./shop/index'),
  file_uploader: require('./file_uploader/index'),
  post_composer: require('./post_composer/index'),
  channel_manager: require('./channel_manager/index'),
  quiz: require('./quiz/index'),
  https_downloader: require('./https_downloader/index'),
  universal_poster: require('./universal_poster/index'),
  multi_downloader: require('./multi_downloader/index'),
  music_downloader: require('./music_downloader/index')
};

/**
 * Containerized templates (§3.10 & §3.11).
 * wizard: 'panel' (VPN shop credential collection) | 'telethon' (user-session login)
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

module.exports = {
  registry,
  containerTemplates,
  isContainerized: (id) => !!containerTemplates[id],
  listTemplates: () => [
    ...Object.entries(registry).map(([id, t]) => ({ id, ...t, handle: undefined })),
    ...Object.values(containerTemplates)
  ]
};
