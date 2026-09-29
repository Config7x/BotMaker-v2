'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateUrl } = require('../../utils/ssrf');

const MAX_BYTES = 50 * 1024 * 1024; // Telegram Bot API upload limit for audio
const SEARCH_TIMEOUT_MS = 45 * 1000;
const DOWNLOAD_TIMEOUT_MS = 4 * 60 * 1000;

function run(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    // execFile (no shell) => user input can never be interpreted as shell syntax
    execFile(cmd, args, { timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(err.code === 'ENOENT' ? 'ENGINE_MISSING' : (stderr || err.message || 'FAILED').toString().slice(0, 300));
        e.code = err.code;
        return reject(e);
      }
      resolve(stdout.toString());
    });
  });
}

/** True only for public http(s) links that pass SSRF validation. */
function isSafeHttpUrl(text) {
  if (typeof text !== 'string') return false;
  const value = text.trim();
  if (!/^https?:\/\//i.test(value)) return false;
  return validateUrl(value).safe === true;
}

/** Search YouTube via yt-dlp. Returns [{ title, url }]. */
async function searchMusic(query, limit = 10) {
  const q = String(query || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
  if (!q) return [];
  const out = await run(
    'yt-dlp',
    ['--flat-playlist', '--no-warnings', '--print', '%(title)s\t%(webpage_url)s\t%(id)s', `ytsearch${limit}:${q}`],
    SEARCH_TIMEOUT_MS
  );
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [title, url, id] = line.split('\t');
      const finalUrl = url && /^https?:\/\//.test(url) ? url : (id ? `https://www.youtube.com/watch?v=${id}` : null);
      return { title: title || 'Untitled', url: finalUrl };
    })
    .filter(r => r.url);
}

/** Download a link as MP3 into a private temp dir. Caller must call cleanup(). */
async function downloadAudio(url) {
  if (!isSafeHttpUrl(url)) throw new Error('BAD_URL');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'music_bot_'));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    await run(
      'yt-dlp',
      [
        '--no-playlist', '--no-warnings',
        '--max-filesize', String(MAX_BYTES),
        '-f', 'bestaudio/best',
        '-x', '--audio-format', 'mp3', '--audio-quality', '128K',
        '-o', path.join(dir, '%(title).80B.%(ext)s'),
        '--', url.trim()
      ],
      DOWNLOAD_TIMEOUT_MS
    );
    const file = fs.readdirSync(dir).find(f => f.toLowerCase().endsWith('.mp3'));
    if (!file) throw new Error('NO_OUTPUT');
    const full = path.join(dir, file);
    if (fs.statSync(full).size > MAX_BYTES) throw new Error('TOO_BIG');
    return { path: full, title: path.basename(file, '.mp3'), cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

module.exports = { searchMusic, downloadAudio, isSafeHttpUrl, MAX_BYTES };
