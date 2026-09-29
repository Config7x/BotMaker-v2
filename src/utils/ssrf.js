'use strict';

const { URL } = require('url');

/**
 * Checks whether an IP address string is a private / loopback / link-local IP.
 * @param {string} ip 
 * @returns {boolean} True if private or unsafe
 */
function isPrivateIp(ip) {
  if (!ip) return false;
  
  // Normalize IPv6 mapped IPv4
  let cleanIp = ip.replace(/^::ffff:/i, '');

  if (cleanIp === 'localhost' || cleanIp === '0.0.0.0') return true;

  // IPv4 Checks
  const parts = cleanIp.split('.').map(Number);
  if (parts.length === 4 && parts.every(p => !isNaN(p) && p >= 0 && p <= 255)) {
    const [a, b] = parts;
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;
    // 10.0.0.0/8 (Private)
    if (a === 10) return true;
    // 172.16.0.0/12 (Private)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (Private)
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (Link Local / Cloud Metadata)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
  }

  // IPv6 Checks
  if (cleanIp === '::1' || cleanIp.toLowerCase().startsWith('fe80:') || cleanIp.toLowerCase().startsWith('fc00:')) {
    return true;
  }

  return false;
}

/**
 * Validates a URL string against SSRF attacks.
 * @param {string} urlString 
 * @returns {{ safe: boolean, reason?: string, url?: URL }}
 */
function validateUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return { safe: false, reason: 'لینک وارد شده معتبر نیست.' };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlString.trim());
  } catch (err) {
    return { safe: false, reason: 'فرمت URL معتبر نیست.' };
  }

  // Check Protocol (Must be http or https, prefer https)
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { safe: false, reason: 'فقط پروتکل‌های HTTP و HTTPS پشتیبانی می‌شوند.' };
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  // Check hostname keywords and private TLDs
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.localhost')
  ) {
    return { safe: false, reason: 'دسترسی به دامنه‌ها و شبکه‌های داخلی امکان‌پذیر نیست (SSRF Protection).' };
  }

  // Check IP addresses
  if (isPrivateIp(hostname)) {
    return { safe: false, reason: 'دسترسی به IPهای داخلی و خصوصی مسدود شده است (SSRF Protection).' };
  }

  return { safe: true, url: parsedUrl };
}

module.exports = {
  isPrivateIp,
  validateUrl
};
