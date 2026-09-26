'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const { createControlBot } = require('../src/admin');
const { TelegramApi } = require('../src/telegram');
const { encrypt, decrypt } = require('../src/cryptoutil');
const wallet = require('../src/wallet');
const { containerTemplates, listTemplates } = require('../src/templates/registry');

const ENC = 'test-encryption-key-123';
const OWNER = 1001;
const USER = 2002;

// ------------------------------------------------------------------ harness
function makeHarness(opts = {}) {
  const db = createDb(':memory:');
  const controlLog = [];
  const controlApi = new TelegramApi('0:c', { mock: true, mockLog: controlLog });
  const cfg = {
    ENCRYPTION_KEY: ENC, PUBLIC_URL: 'https://x.example',
    OWNER_TELEGRAM_ID: String(OWNER), CONTROL_BOT_TOKEN: '0:c',
    TELETHON_API_ID: 1234, TELETHON_API_HASH: 'abcd'
  };

  // mock provisioner — records every call, scriptable gVisor availability
  const calls = [];
  const provisioner = {
    gvisorAvailable: async () => opts.gvisor !== false,
    provision: async (p) => {
      calls.push(['provision', p]);
      if (opts.gvisor === false) return { ok: false, reason: 'gvisor_missing' };
      return { ok: true, containerName: `bm2_c_${p.botId}`, volumeName: `bm2_c_${p.botId}_data` };
    },
    stop: async (id) => { calls.push(['stop', id]); return { ok: true }; },
    start: async (id) => { calls.push(['start', id]); return { ok: true }; },
    restart: async (id) => { calls.push(['restart', id]); return { ok: true }; },
    status: async (id) => { calls.push(['status', id]); return { ok: true, state: 'running' }; },
    destroy: async (id) => { calls.push(['destroy', id]); return { ok: true }; }
  };

  // scriptable telethon driver
  const telethon = opts.telethon || {
    startLogin: async (phone) => { calls.push(['login:start', phone]); return { ok: true, need: 'code', loginKey: 'LK1' }; },
    submitCode: async (key, code) => {
      calls.push(['login:code', key, code]);
      if (opts.twoFa) return { ok: true, need: 'password' };
      return { ok: true, need: 'session', session: 'SESSION_STRING_XYZ' };
    },
    submitPassword: async (key, pw) => { calls.push(['login:password', key]); return { ok: true, need: 'session', session: 'SESSION_STRING_XYZ' }; }
  };

  const apiFor = () => new TelegramApi('0:b', { mock: true, mockLog: [] });
  const makeApi = () => new TelegramApi('0:b', {
    mock: true, mockLog: [],
    mockResponses: { getMe: { ok: true, result: { id: 1, username: 'newbot', first_name: 'NB' } } }
  });
  const controlBot = createControlBot({
    db, cfg, registry: require('../src/templates/registry').registry,
    apiFor, makeApi, controlApi, provisioner, telethon,
    clock: { now: () => 5_000_000_000 }
  });
  const send = (t) => controlBot.processUpdate({ update_id: (Math.random() * 1e9) | 0, message: { message_id: 1, chat: { id: USER }, from: { id: USER }, text: t } });
  const click = (data, userId = USER) => controlBot.processUpdate({ update_id: (Math.random() * 1e9) | 0, callback_query: { id: 'cb', from: { id: userId }, message: { chat: { id: userId } }, data } });
  const lastSendText = () => {
    const s = [...controlLog].reverse().find((c) => c.method === 'sendMessage');
    return s ? s.payload.text : '';
  };
  return { db, calls, controlLog, send, click, lastSendText, provisioner };
}

// fund user and walk up to token entry for a given template/plan
async function startCreation(h, templateId, planId = 'pro') {
  wallet.credit(h.db, USER, 500000, 'topup', '');
  await h.click(`tpl:${templateId}`);
  await h.click(`plan:${templateId}:${planId}`);
  await h.send('123456:' + 'A'.repeat(35)); // BotFather token
}

// ==================================================================== tests
test('registry: containerized templates #10 and #11 listed with flags', () => {
  const all = listTemplates();
  const vpn = all.find((t) => t.id === 'vpn_shop');
  const scraper = all.find((t) => t.id === 'config_scraper');
  assert.ok(vpn && vpn.containerized && vpn.paidOnly);
  assert.ok(scraper && scraper.containerized && scraper.paidOnly);
  assert.deepStrictEqual(vpn.panelTypes.sort(),
    ['marzban', 'pasarguard', 'remnawave', 'wgdashboard', 'x-ui'].sort());
  assert.ok(scraper.tosRisk.includes('ریسک')); // ban-risk disclosure exists
});

test('plan gating: free/demo NEVER offered for containerized templates', async () => {
  const h = makeHarness();
  await h.click('tpl:vpn_shop');
  const kb = [...h.controlLog].reverse().find((c) => c.method === 'sendMessage').payload.reply_markup;
  const offered = kb.inline_keyboard.map((r) => r[0].callback_data);
  assert.ok(offered.some((d) => d.includes(':pro')), 'pro offered');
  assert.ok(offered.some((d) => d.includes(':vip')), 'vip offered');
  assert.ok(!offered.some((d) => d.includes(':free')), 'free never offered');

  // forged free-plan callback is refused outright
  await h.click('plan:vpn_shop:free');
  assert.ok(/Pro \/ VIP|پرو \/ VIP|پرو/.test(h.lastSendText()));
});

test('vpn shop wizard: full flow, credentials AES-encrypted, container provisioned', async () => {
  const h = makeHarness();
  await startCreation(h, 'vpn_shop');
  const bots = h.db.listBotsByOwner(String(USER));
  assert.strictEqual(bots.length, 1);
  const botId = bots[0].id;
  assert.strictEqual(bots[0].status, 'provisioning');
  assert.ok(bots[0].config.containerized);

  // wizard step 1: panel type
  assert.ok(/پنل مدیریت VPN/.test(h.lastSendText()));
  await h.click(`cw:ptype:${botId}:marzban`);
  // step 2: panel URL
  await h.send('https://panel.mycustomer.ir');
  // step 3: panel user
  await h.send('admin');
  // step 4: panel password
  await h.send('SuperSecretPanelPass123');

  // provisioned
  const bot = h.db.getBot(botId);
  assert.strictEqual(bot.status, 'active');
  assert.strictEqual(bot.config.panel_type, 'marzban');
  assert.strictEqual(bot.config.panel_url, 'https://panel.mycycustomer.ir' === bot.config.panel_url ? bot.config.panel_url : 'https://panel.mycustomer.ir');
  assert.strictEqual(bot.config.panel_user, 'admin');
  // password AES-256-GCM encrypted — plaintext never stored
  assert.ok(!JSON.stringify(bot.config).includes('SuperSecretPanelPass123'));
  assert.strictEqual(decrypt(bot.config.panel_pass_enc, ENC), 'SuperSecretPanelPass123');

  // container registered + provisioner called with injected env
  const c = h.db.getContainer(botId);
  assert.ok(c && c.status === 'running');
  const prov = h.calls.find((x) => x[0] === 'provision')[1];
  assert.strictEqual(prov.image, 'botmaker/vpn_shop:latest');
  assert.strictEqual(prov.env.BM_PANEL_TYPE, 'marzban');
  assert.strictEqual(prov.env.BM_PANEL_URL, 'https://panel.mycustomer.ir');
  assert.strictEqual(prov.env.BM_PANEL_USER, 'admin');
  assert.strictEqual(prov.env.BM_PANEL_PASS, 'SuperSecretPanelPass123'); // injected decrypted
  assert.ok(prov.env.BM_BOT_TOKEN.startsWith('123456:'));
});

test('vpn shop: fail-closed without gVisor -> failed_provision + retry button', async () => {
  const h = makeHarness({ gvisor: false });
  await startCreation(h, 'vpn_shop');
  const botId = h.db.listBotsByOwner(String(USER))[0].id;
  await h.click(`cw:ptype:${botId}:x-ui`);
  await h.send('https://panel.example.com');
  await h.send('admin');
  await h.send('pass123');

  const bot = h.db.getBot(botId);
  assert.strictEqual(bot.status, 'failed_provision');
  assert.ok(/gVisor/.test(h.lastSendText()));
  // retry offered in panel
  await h.click(`openpanel:${botId}`);
  const kb = [...h.controlLog].reverse().find((x) => x.method === 'sendMessage').payload.reply_markup;
  assert.ok(JSON.stringify(kb).includes('cw:retryprovision'));
});

test('scraper wizard: ToS disclosure FIRST — phone only after acceptance', async () => {
  const h = makeHarness();
  await startCreation(h, 'config_scraper');
  const botId = h.db.listBotsByOwner(String(USER))[0].id;

  // ToS ban-risk disclosure shown; sending a phone BEFORE accepting does nothing
  assert.ok(/ریسک/.test(h.lastSendText()));
  await h.send('+989121234567');
  const bot = h.db.getBot(botId);
  assert.strictEqual(bot.config.session_enc, undefined, 'no session before ToS accept');
  assert.ok(h.calls.every((c) => c[0] !== 'login:start'));

  // accept ToS -> now phone works
  await h.click(`cw:tosaccept:${botId}`);
  await h.send('+989121234567');
  assert.ok(h.calls.some((c) => c[0] === 'login:start' && c[1] === '+989121234567'));
});

test('scraper wizard: phone -> OTP -> session (no 2FA) -> dest -> provisioned; session encrypted', async () => {
  const h = makeHarness();
  await startCreation(h, 'config_scraper');
  const botId = h.db.listBotsByOwner(String(USER))[0].id;
  await h.click(`cw:tosaccept:${botId}`);
  await h.send('+989121234567');
  await h.send('54321'); // OTP
  await h.send('@my_configs'); // destination channel

  const bot = h.db.getBot(botId);
  assert.strictEqual(bot.status, 'active');
  assert.strictEqual(bot.config.dest_channel, '@my_configs');
  // session AES-256-GCM encrypted at rest
  assert.ok(!JSON.stringify(bot.config).includes('SESSION_STRING_XYZ'));
  assert.strictEqual(decrypt(bot.config.session_enc, ENC), 'SESSION_STRING_XYZ');

  const prov = h.calls.find((c) => c[0] === 'provision')[1];
  assert.strictEqual(prov.image, 'botmaker/config_scraper:latest');
  assert.strictEqual(prov.env.TELETHON_SESSION_STRING, 'SESSION_STRING_XYZ');
  assert.strictEqual(prov.env.OWNER_ID, String(USER));
  assert.strictEqual(prov.env.DEST_CHANNEL_USERNAME, '@my_configs');
});

test('scraper wizard: 2FA password path reaches the same session', async () => {
  const h = makeHarness({ twoFa: true });
  await startCreation(h, 'config_scraper');
  const botId = h.db.listBotsByOwner(String(USER))[0].id;
  await h.click(`cw:tosaccept:${botId}`);
  await h.send('+989121234567');
  await h.send('54321');
  assert.ok(/رمز دوم|دو مرحله‌ای/.test(h.lastSendText()), 'asks for 2FA password');
  await h.send('My2FAPass');
  await h.send('@dest_ch');
  const bot = h.db.getBot(botId);
  assert.strictEqual(bot.status, 'active');
  assert.strictEqual(decrypt(bot.config.session_enc, ENC), 'SESSION_STRING_XYZ');
});

test('scraper panel: manage source channels — add, list, remove', async () => {
  const h = makeHarness();
  await startCreation(h, 'config_scraper');
  const botId = h.db.listBotsByOwner(String(USER))[0].id;
  await h.click(`cw:tosaccept:${botId}`);
  await h.send('+989121234567');
  await h.send('54321');
  await h.send('@dest_ch');

  // panel includes source-channel management (scraper only)
  await h.click(`openpanel:${botId}`);
  const kb = [...h.controlLog].reverse().find((x) => x.method === 'sendMessage').payload.reply_markup;
  assert.ok(JSON.stringify(kb).includes('cw:channels'));

  await h.click(`cw:channels:${botId}`);
  assert.ok(/خالی/.test(h.lastSendText()));
  await h.click(`cw:addchannel:${botId}`);
  await h.send('@source_one');
  await h.send('@source_two');
  assert.deepStrictEqual(h.db.getBot(botId).config.source_channels, ['@source_one', '@source_two']);

  // remove the first
  await h.click(`cw:rmchannel:${botId}:0`);
  assert.deepStrictEqual(h.db.getBot(botId).config.source_channels, ['@source_two']);
});

test('containerized panel: pause stops container, resume starts it, delete destroys + volume', async () => {
  const h = makeHarness();
  await startCreation(h, 'vpn_shop');
  const botId = h.db.listBotsByOwner(String(USER))[0].id;
  await h.click(`cw:ptype:${botId}:marzban`);
  await h.send('https://panel.example.com');
  await h.send('admin');
  await h.send('pass');

  // pause -> container stop, NO webhook calls
  await h.click(`botpanel:pause:${botId}`);
  assert.strictEqual(h.db.getBot(botId).status, 'paused');
  assert.ok(h.calls.some((c) => c[0] === 'stop' && c[1] === botId));
  // resume -> container start
  await h.click(`botpanel:pause:${botId}`);
  assert.strictEqual(h.db.getBot(botId).status, 'active');
  assert.ok(h.calls.some((c) => c[0] === 'start' && c[1] === botId));

  // container status action
  await h.click(`cw:status:${botId}`);
  assert.ok(/running/.test(h.lastSendText()));

  // delete: confirm-first, then full teardown (container + registry row)
  await h.click(`botpanel:deleteconfirm:${botId}`);
  await h.click(`botpanel:delete:${botId}`);
  assert.ok(h.calls.some((c) => c[0] === 'destroy' && c[1] === botId));
  assert.strictEqual(h.db.getContainer(botId), null);
  assert.strictEqual(h.db.listBotsByOwner(String(USER)).length, 0);
});

test('webhook: containerized bots never dispatch to in-process templates', async () => {
  const { createWebhookApp } = require('../src/webhook');
  const db = createDb(':memory:');
  db.upsertUser(USER);
  db.createBot({
    id: 'cbot', owner_id: USER, token_encrypted: encrypt('1:' + 'A'.repeat(35), ENC),
    secret_token: 'secC', username: 'cb', template_id: 'vpn_shop', plan_id: 'pro',
    status: 'active', config: { containerized: true }
  });
  const app = createWebhookApp({
    db, cfg: { SECURITY_ALERT_SECRET: 's' }, registry: { quiz: { handle: async () => { throw new Error('must not run'); } } },
    apiFor: () => { throw new Error('api must not be built'); }
  });
  const server = app.listen(0);
  const port = server.address().port;
  const r = await fetch(`http://localhost:${port}/webhook/secC`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'secC' },
    body: JSON.stringify({ message: { chat: { id: 1 }, text: 'hi' } })
  });
  const body = await r.json();
  server.close();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(body.skipped, 'containerized');
});

test('provisioner: hardened docker flags; fail-closed without gVisor', async () => {
  const { createProvisioner } = require('../src/provisioner');
  const cmds = [];
  const exec = async (file, args) => {
    cmds.push(args);
    if (args[0] === 'info') return { ok: true, stdout: '{"runc":{}}', stderr: '' };
    return { ok: true, stdout: 'containerid123', stderr: '' };
  };

  // gVisor absent -> refusal, zero docker run
  const p1 = createProvisioner({ exec });
  const r1 = await p1.provision({ botId: 'b1', image: 'img', env: {} });
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, 'gvisor_missing');
  assert.ok(!cmds.some((a) => a[0] === 'run'));

  // gVisor present -> hardened flags
  const p2 = createProvisioner({ exec, gvisor: true });
  const r2 = await p2.provision({ botId: 'b2', image: 'img', env: { A: 'B' } });
  assert.strictEqual(r2.ok, true);
  const run = cmds.find((a) => a[0] === 'run');
  const joined = run.join(' ');
  for (const flag of ['--runtime=runsc', '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--read-only', '--pids-limit', '--memory', '--cpus', '-e', 'A=B']) {
    assert.ok(joined.includes(flag), `missing ${flag}`);
  }
  assert.ok(joined.includes('bm2_c_b2_data:/app/data'), 'data volume mounted');

  // destroy removes container AND volume
  await p2.destroy('b2');
  const rmArgs = cmds.filter((a) => a[0] === 'rm' || a[0] === 'volume');
  assert.ok(rmArgs.some((a) => a.includes('bm2_c_b2')));
  assert.ok(rmArgs.some((a) => a.includes('bm2_c_b2_data')));
});
