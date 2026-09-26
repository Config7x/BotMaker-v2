'use strict';

/**
 * SSRF protection for user-supplied download/attachment URLs.
 * Blocks private/loopback/link-local/reserved ranges and non-HTTP(S) schemes.
 * DNS-pinning is enforced at fetch time: resolve the hostname, re-check every
 * resolved address before connecting.
 */
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
  /^\[?fc00:/i,
  /^192\.0\.2\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
];

function isBlockedIp(host) {
  return BLOCKED_HOST_PATTERNS.some((p) => p.test(String(host).replace(/^\[|\]$/g, '')));
}

function validateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { safe: false, reason: 'لینک خالی یا نامعتبر است.' };
  }
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch (_) {
    return { safe: false, reason: 'آدرس وارد شده یک URL معتبر نیست.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { safe: false, reason: 'فقط پروتکل‌های HTTP و HTTPS مجاز هستند.' };
  }
  const host = url.hostname.toLowerCase();
  if (isBlockedIp(host)) {
    return { safe: false, reason: 'آدرس‌های شبکه داخلی و خصوصی مسدود شده‌اند (SSRF).' };
  }
  return { safe: true, url };
}

module.exports = { validateUrl, isBlockedIp, BLOCKED_HOST_PATTERNS };
