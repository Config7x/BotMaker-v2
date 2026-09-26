'use strict';

/**
 * HTML escaping for Telegram parse_mode:'HTML' messages.
 * All dynamic user-supplied text MUST go through this before sending.
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape user text into a code block body. */
function codeBlock(str) {
  return `<code>${escapeHtml(str)}</code>`;
}

module.exports = { escapeHtml, codeBlock };
