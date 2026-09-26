'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDb } = require('../src/db');
const customsource = require('../src/customsource');
const wallet = require('../src/wallet');

const cfg = { CUSTOM_SOURCE_PRICE: 300000, OWNER_TELEGRAM_ID: '1001', SECURITY_ALERT_SECRET: 'sec-secret' };

function paidUser(db, id = '5005') {
  db.upsertUser(id);
  db.createBot({ id: 'paidbot', owner_id: id, token_encrypted: 'x', secret_token: 's', username: 'pb', template_id: 'shop', plan_id: 'pro', status: 'active' });
  return id;
}

// ---------------------------------------------------------------- payment gate
test('customsource: payment gate blocks BEFORE any validation', () => {
  const db = createDb(':memory:');

  db.upsertUser('1');
  let g = customsource.checkPaymentGate(db, '1', cfg);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'no_paid_plan');

  const id = paidUser(db, '2');
  g = customsource.checkPaymentGate(db, id, cfg);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'insufficient_balance');
  assert.strictEqual(g.shortfall, cfg.CUSTOM_SOURCE_PRICE);

  wallet.credit(db, id, cfg.CUSTOM_SOURCE_PRICE, 'topup', '');
  g = customsource.checkPaymentGate(db, id, cfg);
  assert.strictEqual(g.ok, true);
});

// ------------------------------------------------------------ review ordering
test('customsource: security scan fails fast — bug scan never runs', async () => {
  const files = [
    { name: 'index.js', content: 'const x = eval(userInput);' },
    { name: 'util.py', content: 'import subprocess' }
  ];
  let bugScanRan = false;
  const r = await customsource.runReviewPipeline(
    { aiBugScan: async () => { bugScanRan = true; return { ok: true }; } },
    { files, manifest: { runtime: 'node20', start: 'node index.js' } }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'security');
  assert.strictEqual(bugScanRan, false, 'bug scan must NOT run after security failure');
  assert.ok(r.report.security.findings.some((f) => /eval/.test(f.finding)));
});

test('customsource: bug scan runs only for projects that passed security', async () => {
  const files = [{ name: 'index.js', content: 'console.log("safe");' }];
  let securityPassed = false;
  const r = await customsource.runReviewPipeline(
    {
      aiSecurityReview: async () => ({ ok: true }),
      aiBugScan: async () => { securityPassed = true; return { ok: false, issues: ['missing await'] }; }
    },
    { files, manifest: { runtime: 'node20', start: 'node index.js' } }
  );
  assert.ok(securityPassed);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stage, 'bug');
});

// ---------------------------------------------------------- structure limits
test('customsource: zip/ratio/file-count/manifest validation rejects cheaply', async () => {
  let v = await customsource.validateStructure({ runtime: 'java8', startCommand: 'x', files: [{ name: 'index.js' }], totalBytes: 10, zipBytes: 10 });
  assert.strictEqual(v.ok, false);

  v = await customsource.validateStructure({ runtime: 'node20', startCommand: 'node index.js --privileged', files: [{ name: 'index.js' }], totalBytes: 10, zipBytes: 10 });
  assert.strictEqual(v.ok, false);

  v = await customsource.validateStructure({ runtime: 'node20', startCommand: 'node index.js', files: [{ name: 'index.js' }], totalBytes: 1000 * 1024, zipBytes: 1024 });
  assert.strictEqual(v.ok, false);

  v = await customsource.validateStructure({ runtime: 'node20', startCommand: 'node index.js', files: new Array(501).fill({ name: 'a.js' }), totalBytes: 10, zipBytes: 10 });
  assert.strictEqual(v.ok, false);

  v = await customsource.validateStructure({ runtime: 'python3.11', startCommand: 'python main.py', files: [{ name: 'main.py' }], totalBytes: 100, zipBytes: 100 });
  assert.strictEqual(v.ok, true);
});

// ------------------------------------------------------------- approval gate
test('customsource: sandbox hardened; FAILS CLOSED without gVisor', () => {
  process.env.GVISOR_AVAILABLE = 'false';
  let r = customsource.buildSandboxCommand({ runtime: 'node20', startCommand: 'node index.js', sourceDir: '/src/x', projectId: 'cp_1' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'gvisor_missing');

  process.env.GVISOR_AVAILABLE = 'true';
  r = customsource.buildSandboxCommand({ runtime: 'node20', startCommand: 'node index.js', sourceDir: '/src/x', projectId: 'cp_1' });
  assert.strictEqual(r.ok, true);
  const c = r.command;
  for (const flag of ['--runtime=runsc', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--rm', '--user 1000:1000', '--pids-limit', '--memory=256m', '--cpus=0.5']) {
    assert.ok(c.includes(flag), `missing ${flag}`);
  }
  delete process.env.GVISOR_AVAILABLE;
});

// -------------------------------------------------------- error classification
test('customsource: source vs host failure classification + fix policy', () => {
  let c = customsource.classifyFailure({ exitCode: 1, stderr: 'TypeError: undefined is not a function' });
  assert.strictEqual(c.type, 'source');

  c = customsource.classifyFailure({ exitCode: 1, stderr: 'docker: Cannot connect to the Docker daemon' });
  assert.strictEqual(c.type, 'host');

  c = customsource.classifyFailure({ exitCode: 0, stderr: 'unable to find image node:99' });
  assert.strictEqual(c.type, 'host');

  let p = customsource.hostFixPolicy('pull missing base image');
  assert.strictEqual(p.autoApplyAllowed, true);
  assert.strictEqual(p.escalate, false);

  p = customsource.hostFixPolicy('disable sandbox network isolation');
  assert.strictEqual(p.escalate, true);
  assert.strictEqual(p.autoApplyAllowed, false);
});

// ------------------------------------------------------------- Falco alerts
test('customsource: security alert verifies secret + project, kills and purges', async () => {
  const db = createDb(':memory:');
  db.upsertUser('9');
  db.createCustomProject({ id: 'cp_x', owner_id: '9', runtime: 'node20', status: 'approved', source_dir: '/tmp/cp_x' });
  const actions = [];
  const deps = {
    killContainer: async (id) => actions.push(`kill:${id}`),
    purgeSource: async (dir) => actions.push(`purge:${dir}`),
    notify: async (id, text) => actions.push(`notify:${id}`)
  };

  let r = await customsource.handleSecurityAlert(db, deps, { projectId: 'cp_x', sharedSecret: 'wrong', cfg });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad_secret');

  r = await customsource.handleSecurityAlert(db, deps, { projectId: 'cp_missing', sharedSecret: 'sec-secret', cfg });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'project_not_found');

  r = await customsource.handleSecurityAlert(db, deps, { projectId: 'cp_x', sharedSecret: 'sec-secret', cfg });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(db.getCustomProject('cp_x').status, 'killed_security_violation');
  assert.ok(actions.includes('kill:cp_x'));
  assert.ok(actions.includes('purge:/tmp/cp_x'));
  assert.ok(actions.includes('notify:9'));
  assert.ok(actions.includes('notify:1001'));
});
