'use strict';

/**
 * Telethon login driver (§3.11) — drives the ONE-SHOT login helper
 * container (templates/containerized/config_scraper/shims/login_service.py)
 * over HTTP for the creation wizard: phone → OTP → optional 2FA → session.
 *
 * The session string is returned ONCE to the platform, stored AES-256-GCM
 * encrypted, and the helper container is destroyed immediately after.
 *
 * Mockable in tests by injecting a fake driver as deps.telethon.
 */
const { execFile } = require('child_process');
const crypto = require('crypto');

function realExec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err || '') });
    });
  });
}

function createTelethonDriver(opts = {}) {
  const exec = opts.exec || realExec;
  const cfg = opts.cfg || {};
  const helperImage = opts.image || 'botmaker/config_scraper:latest';
  const helperPort = 8731;
  const logins = new Map(); // loginKey -> { container, hostPort }

  async function docker(args) { return exec('docker', args); }

  async function post(loginKey, path, body) {
    const l = logins.get(loginKey);
    if (!l) return { ok: false, error: 'login session not found' };
    const fetchImpl = opts.fetchImpl || (global.fetch ? global.fetch.bind(global) : null);
    if (!fetchImpl) return { ok: false, error: 'no http client available' };
    const r = await fetchImpl(`http://127.0.0.1:${l.hostPort}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    return r.json();
  }

  async function startLogin(phone) {
    // fail-closed: the helper runs with gVisor like every containerized template
    if (cfg.GVISOR_AVAILABLE === 'false' || process.env.GVISOR_AVAILABLE === 'false') {
      return { ok: false, error: 'gVisor not available (fail-closed)' };
    }
    const key = crypto.randomBytes(8).toString('hex');
    const name = `bm2_login_${key}`;
    const r = await docker(['run', '-d', '--name', name,
      '--runtime=runsc', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,size=32m', '--pids-limit', '128',
      '--memory', '256m', '--cpus', '0.5',
      '-p', `127.0.0.1::${helperPort}`,
      '-e', `TELETHON_API_ID=${cfg.TELETHON_API_ID || ''}`,
      '-e', `TELETHON_API_HASH=${cfg.TELETHON_API_HASH || ''}`,
      '-e', `LOGIN_SERVICE_PORT=${helperPort}`,
      helperImage, 'python3', 'shims/login_service.py']);
    if (!r.ok) return { ok: false, error: 'failed to start login helper container' };
    const portR = await docker(['port', name, String(helperPort)]);
    // e.g. "127.0.0.1:49153"
    const hostPort = parseInt((portR.stdout.split(':')[1] || '').trim(), 10);
    if (!hostPort) { await cleanup(key); return { ok: false, error: 'no helper port mapped' }; }
    logins.set(key, { container: name, hostPort });
    const resp = await post(key, '/start', { phone });
    if (!resp.ok) { await cleanup(key); return { ok: false, error: resp.error || 'login start failed' }; }
    return { ok: true, need: 'code', loginKey: key };
  }

  async function submitCode(loginKey, code) {
    const resp = await post(loginKey, '/code', { code });
    if (!resp.ok) return { ok: false, error: resp.error || 'code rejected' };
    if (resp.need === 'password') return { ok: true, need: 'password' };
    const session = await finish(loginKey);
    return { ok: true, need: 'session', session };
  }

  async function submitPassword(loginKey, password) {
    const resp = await post(loginKey, '/password', { password });
    if (!resp.ok) return { ok: false, error: resp.error || 'password rejected' };
    const session = await finish(loginKey);
    return { ok: true, need: 'session', session };
  }

  async function finish(loginKey) {
    const resp = await post(loginKey, '/session', {});
    await cleanup(loginKey); // helper container destroyed right after
    return resp.ok ? resp.session : null;
  }

  async function cleanup(loginKey) {
    const l = logins.get(loginKey);
    logins.delete(loginKey);
    if (l) await docker(['rm', '-f', l.container]).catch(() => {});
  }

  return { startLogin, submitCode, submitPassword };
}

module.exports = { createTelethonDriver };
