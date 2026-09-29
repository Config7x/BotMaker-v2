'use strict';

/**
 * Escapes unsafe HTML characters to prevent HTML injection in Telegram messages.
 * @param {string} str Unsafe text string
 * @returns {string} Safe HTML string
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = {
  escapeHtml
};
