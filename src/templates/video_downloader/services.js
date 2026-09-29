'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateUrl } = require('../../utils/ssrf');

const TG_LIMIT_MB = 50; // hard cap of the cloud Bot API for uploads
const EXTRACT_TIMEOUT_MS = 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// Same format selectors as the original bot
const QUALITY_FORMATS = {
  '360': 'bestvideo[height<=360]+bestaudio/best[height<=360]',
  '480': 'bestvideo[height<=480]+bestaudio/best[height<=480]',
  '720': 'bestvideo[height<=720]+bestaudio/best[height<=720]',
  '1080': 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
  best: 'bestvideo+bestaudio/best',
  mp3: 'bestaudio/best'
};
const QUALITY_HEIGHTS = [360, 480, 720, 1080];

class CancelledError extends Error {
  constructor() { super('CANCELLED'); this.code = 'CANCELLED'; }
}

let _ffmpeg = null;
function ffmpegAvailable() {
  if (_ffmpeg === null) {
    try {
      require('child_process').execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
      _ffmpeg = true;
    } catch (_) { _ffmpeg = false; }
  }
  return _ffmpeg;
}

/** True only for public http(s) links that pass SSRF validation. */
function isSafeHttpUrl(text) {
  if (typeof text !== 'string') return false;
  const v = text.trim();
  if (!/^https?:\/\//i.test(v)) return false;
  return validateUrl(v).safe === true;
}

function normalizeUrl(raw) {
  const v = String(raw || '').trim();
  return /^www\./i.test(v) ? `https://${v}` : v;
}

/** Map a yt-dlp error to a safe, user-facing error key (never leaks details). */
function friendlyErrorKey(err) {
  const text = String((err && (err.stderr || err.message)) || '').toLowerCase();
  if (text.includes('engine_missing')) return 'errEngine';
  if (text.includes('unsupported url')) return 'errUnsupported';
  if (text.includes('requested format') || text.includes('format not available')) return 'errFormat';
  if (text.includes('private')) return 'errPrivate';
  if (text.includes('removed') || text.includes('unavailable') || text.includes('not available')) return 'errGone';
  if ((text.includes('geo') && text.includes('restrict')) || text.includes('not available in your country')) return 'errGeo';
  if (text.includes('sign in') || text.includes('login') || text.includes('cookies') || text.includes('confirm you')) return 'errLogin';
  if (text.includes('404') || text.includes('not found')) return 'errNotFound';
  if (text.includes('timed out') || text.includes('timeout') || text.includes('network') || text.includes('connection')) return 'errNetwork';
  if (text.includes('ffmpeg')) return 'errFfmpeg';
  return 'errInfo';
}

function runJson(args, timeout) {
  return new Promise((resolve, reject) => {
    // execFile (no shell): user input can never be interpreted as shell syntax
    execFile('yt-dlp', args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error(err.code === 'ENOENT' ? 'ENGINE_MISSING' : String(stderr || err.message || 'FAILED').slice(0, 400));
        e.stderr = String(stderr || '');
        return reject(e);
      }
      resolve(stdout.toString());
    });
  });
}

/** Extract metadata (no download). Returns the yt-dlp info object. */
async function extractInfo(url) {
  if (!isSafeHttpUrl(url)) throw new Error('BAD_URL');
  const out = await runJson(
    ['-J', '--no-warnings', '--no-playlist', '--socket-timeout', '20', '--retries', '2', '--', url],
    EXTRACT_TIMEOUT_MS
  );
  let info = JSON.parse(out);
  if (info && Array.isArray(info.entries)) {
    const first = info.entries.find(Boolean);
    if (!first) throw new Error('empty playlist result');
    info = first;
  }
  return info;
}

/** Qualities really present in the source (same bucket logic as the original). */
function availableQualities(info) {
  const heights = new Set();
  let hasVideo = false;
  for (const f of (info.formats || [])) {
    if (!f.vcodec || f.vcodec === 'none') continue;
    hasVideo = true;
    if (f.height) heights.add(Number(f.height));
  }
  if (info.height) { heights.add(Number(info.height)); hasVideo = true; }
  const out = [];
  for (const q of QUALITY_HEIGHTS) {
    const low = q - 60;
    if ([...heights].some(h => h >= low && h <= q)) out.push(String(q));
  }
  if (!out.length && hasVideo) out.push('best');
  return out;
}

/** Rough size estimate (best video + best audio) in bytes, or null. */
function estimateSize(info) {
  const approx = info.filesize || info.filesize_approx;
  if (approx) return Number(approx);
  let bv = 0, ba = 0;
  for (const f of (info.formats || [])) {
    const s = f.filesize || f.filesize_approx;
    if (!s) continue;
    const isVideo = f.vcodec && f.vcodec !== 'none';
    const isAudio = f.acodec && f.acodec !== 'none';
    if (isVideo) bv = Math.max(bv, Number(s));
    else if (isAudio) ba = Math.max(ba, Number(s));
  }
  return (bv || ba) ? bv + ba : null;
}

/**
 * Download with live progress. `state` is updated in place:
 *   { phase, percent, downloaded, total, speed, eta, cancelled }
 * Set state.cancelled = true to abort. Returns { path, cleanup }.
 */
function download(url, quality, state) {
  return new Promise((resolve, reject) => {
    if (!isSafeHttpUrl(url)) return reject(new Error('BAD_URL'));
    if (!QUALITY_FORMATS[quality]) return reject(new Error('BAD_QUALITY'));
    if (quality === 'mp3' && !ffmpegAvailable()) return reject(new Error('FFMPEG_MISSING'));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid_dl_'));
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
    const args = [
      '-f', QUALITY_FORMATS[quality],
      '--no-playlist', '--no-warnings', '--newline', '--progress',
      '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3',
      '--concurrent-fragments', '4',
      '--progress-template', 'download:PROG %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s',
      '--print', 'after_move:FILE %(filepath)s',
      '-o', path.join(dir, '%(title).80B.%(ext)s'),
      '--windows-filenames'
    ];
    if (quality === 'mp3') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '192K');
    else args.push('--merge-output-format', 'mp4');
    args.push('--', url);

    let child;
    try { child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true }); }
    catch (e) { cleanup(); return reject(new Error('ENGINE_MISSING')); }

    let filePath = null;
    let stderr = '';
    let killedByTimeout = false;
    // Kill the whole process group: yt-dlp spawns ffmpeg, and a plain child.kill()
    // would leave it holding the output pipe open (the 'close' event never fires).
    const killTree = () => {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (_) { try { child.kill('SIGKILL'); } catch (__) { /* already gone */ } }
    };
    const timer = setTimeout(() => { killedByTimeout = true; killTree(); }, DOWNLOAD_TIMEOUT_MS);
    const cancelPoll = setInterval(() => { if (state.cancelled) killTree(); }, 500);

    let buf = '';
    let doneBytes = 0, streamLast = 0, streamTotal = 0;
    child.stdout.on('data', chunk => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith('PROG ')) {
          const [, d, t, te, sp, eta] = line.split(/\s+/);
          const num = v => (v && v !== 'NA' && v !== 'None' && !isNaN(Number(v))) ? Number(v) : 0;
          const cur = num(d);
          const tot = num(t) || num(te);
          // yt-dlp downloads video and audio as separate streams; the byte counter
          // restarts for the next one. Detect the restart and accumulate finished streams.
          if (cur < streamLast) { doneBytes += streamTotal || streamLast; }
          streamLast = cur;
          if (tot) streamTotal = tot;
          state.phase = 'downloading';
          state.downloaded = doneBytes + cur;
          state.speed = num(sp);
          state.eta = num(eta);
          // the grand total is only known for streams seen so far, so never let the bar go backwards
          const knownTotal = doneBytes + (streamTotal || 0);
          state.total = Math.max(state.total || 0, knownTotal);
          if (state.total) state.percent = Math.max(state.percent || 0, Math.min(99, state.downloaded * 100 / state.total));
        } else if (line.startsWith('FILE ')) {
          filePath = line.slice(5).trim();
          state.phase = 'processing';
        }
      }
    });
    child.stderr.on('data', c => { stderr = (stderr + c.toString()).slice(-2000); });
    child.on('error', err => {
      clearTimeout(timer); clearInterval(cancelPoll); cleanup();
      reject(new Error(err.code === 'ENOENT' ? 'ENGINE_MISSING' : 'FAILED'));
    });
    child.on('close', code => {
      clearTimeout(timer); clearInterval(cancelPoll);
      if (state.cancelled) { cleanup(); return reject(new CancelledError()); }
      if (killedByTimeout) { cleanup(); return reject(Object.assign(new Error('timed out'), { stderr: 'timed out' })); }
      if (code !== 0) { cleanup(); return reject(Object.assign(new Error('FAILED'), { stderr })); }
      if (!filePath || !fs.existsSync(filePath)) {
        // fallback: newest file in the private temp dir
        try {
          const files = fs.readdirSync(dir).map(f => path.join(dir, f))
            .filter(f => fs.statSync(f).isFile())
            .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
          filePath = files[0] || null;
        } catch (_) { filePath = null; }
      }
      if (!filePath) { cleanup(); return reject(new Error('FILE_NOT_FOUND')); }
      state.percent = 100;
      resolve({ path: filePath, size: fs.statSync(filePath).size, cleanup });
    });
  });
}

// ---------- formatting helpers (same output style as the original utils) ----------
function formatSize(bytes) {
  if (!bytes) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(bytes), i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
}
function formatDuration(sec) {
  if (!sec && sec !== 0) return null;
  sec = Math.round(Number(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}
function progressBar(percent, width = 12) {
  const filled = Math.max(0, Math.min(width, Math.round(percent / 100 * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

module.exports = {
  TG_LIMIT_MB, QUALITY_FORMATS, CancelledError,
  ffmpegAvailable, isSafeHttpUrl, normalizeUrl, friendlyErrorKey,
  extractInfo, availableQualities, estimateSize, download,
  formatSize, formatDuration, progressBar
};
