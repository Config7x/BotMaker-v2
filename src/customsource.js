'use strict';

/**
 * Paid "Custom Source" hosting pipeline (§6).
 * Order is strict: payment gate -> structure validation -> security scan ->
 * bug/logic scan -> owner approval -> hardened sandbox run (gVisor, fail-closed).
 */

const crypto = require('crypto');

const LIMITS = {
  maxZipBytes: 10 * 1024 * 1024,   // 10MB
  maxFiles: 500,
  maxRatio: 100                    // decompression ratio
};

const ALLOWED_RUNTIMES = new Set(['node20', 'python3.11']);

// static security patterns — flagged BEFORE any AI pass (fail fast, save cost)
const SECURITY_PATTERNS = [
  { re: /\beval\s*\(/, label: 'استفاده از eval' },
  { re: /\bnew\s+Function\s*\(/, label: 'استفاده از new Function' },
  { re: /\bchild_process\b|\bsubprocess\b|\bspawn\s*\(|\bexecSync\b|\bexec\s*\(/, label: 'اجرا/فراخوانی فرایند سیستم (child_process/exec)' },
  { re: /\bnet\.Socket\b|\bdgram\b|\braw\s+socket\b/i, label: 'سوکت خام (net.Socket/dgram)' },
  { re: /\bfs\.rm\b|\bfs\.unlink|\brimraf\b|\brm\s+-rf\b|\bshutil\.rmtree\b|\bos\.remove\b/, label: 'API حذف فایل' },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bsk-[A-Za-z0-9]{20,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'راز هاردکد شده (کلید/توکن)' }
];

const DISALLOWED_START_FLAGS = /--privileged|--cap-add|--network[^=]*=(?!none)\S|--volume\s+\//i;

// ---------------------------------------------------------------- payment gate
/** Must pass BEFORE any validation/scanning/AI review. */
function checkPaymentGate(db, userId, cfg) {
  const user = db.getUser(userId);
  if (!user) return { ok: false, reason: 'user_not_found' };
  const hasPaidPlan = db.listBotsByOwner(userId).some((b) => b.plan_id !== 'free' && b.status === 'active');
  if (!hasPaidPlan && user.plan_id === 'free') return { ok: false, reason: 'no_paid_plan' };
  if (!hasPaidPlan && !user.plan_id) return { ok: false, reason: 'no_paid_plan' };
  if (user.wallet_balance < cfg.CUSTOM_SOURCE_PRICE) {
    return { ok: false, reason: 'insufficient_balance', shortfall: cfg.CUSTOM_SOURCE_PRICE - user.wallet_balance };
  }
  return { ok: true };
}

// -------------------------------------------------------- structure validation
/**
 * Validate extracted source dir contents. `readManifest`/`listFiles` are
 * injectable for tests; default uses fs on the extracted dir.
 */
async function validateStructure({ runtime, startCommand, files, totalBytes, zipBytes }) {
  const problems = [];
  if (!ALLOWED_RUNTIMES.has(runtime)) {
    problems.push(`ران‌تایم «${runtime}» پشتیبانی نمی‌شود. مجاز: node20 یا python3.11`);
    return { ok: false, problems };
  }
  if (!startCommand || typeof startCommand !== 'string') {
    problems.push('فیلد start در manifest.json الزامی است');
  } else if (DISALLOWED_START_FLAGS.test(startCommand)) {
    problems.push('دستور start شامل فلگ‌های مجاز (privileged/cap/network/volume) است');
  }
  if (files.length > LIMITS.maxFiles) problems.push(`تعداد فایل‌ها بیش از حد مجاز (${LIMITS.maxFiles})`);
  if (totalBytes > zipBytes * LIMITS.maxRatio) {
    problems.push(`نسبت حجم استخراج به ZIP بیش از ${LIMITS.maxRatio}:1 است (ratio: ${(totalBytes / zipBytes).toFixed(1)}:1)`);
  }
  const hasStart = files.some((f) => {
    if (runtime === 'node20') return f.name === 'index.js' || f.name === 'main.js' || /package\.json$/.test(f.name);
    return f.name === 'main.py' || f.name === 'app.py' || /requirements\.txt$/.test(f.name);
  });
  if (!problems.length && !hasStart) problems.push('فایل نقطه شروع پروژه (index.js/main.py و غیره) یافت نشد');
  return { ok: problems.length === 0, problems };
}

// -------------------------------------------------------------- security scan
function securityScan(fileContents) {
  const findings = [];
  for (const { name, content } of fileContents) {
    for (const p of SECURITY_PATTERNS) {
      if (p.re.test(content)) findings.push({ file: name, finding: p.label });
    }
  }
  return { ok: findings.length === 0, findings };
}

// ------------------------------------------------------- AI-assisted scans
/**
 * aiSecurityReview / aiBugScan are injectable async functions.
 * Bug scan ONLY runs on projects that passed the security scan (spec §6.3).
 */
async function runReviewPipeline({ aiSecurityReview, aiBugScan }, { files, manifest }) {
  const sec = securityScan(files.map((f) => ({ name: f.name, content: f.content })));
  const report = { security: sec, bug: null, aiSecurity: null };
  if (!sec.ok) return { ok: false, stage: 'security', report };
  if (aiSecurityReview) {
    report.aiSecurity = await aiSecurityReview(files);
    if (report.aiSecurity && report.aiSecurity.ok === false) {
      return { ok: false, stage: 'ai_security', report };
    }
  }
  if (aiBugScan) {
    report.bug = await aiBugScan(files);
    if (report.bug && report.bug.ok === false) return { ok: false, stage: 'bug', report };
  }
  return { ok: true, stage: 'passed', report };
}

// ------------------------------------------------------------- sandbox runner
/** Build the hardened docker command. Fails closed without gVisor (runsc). */
function buildSandboxCommand({ runtime, startCommand, sourceDir, projectId }) {
  if (!isGvisorAvailable()) {
    return { ok: false, reason: 'gvisor_missing', command: null }; // FAIL CLOSED
  }
  const image = runtime === 'node20' ? 'node:20-slim' : 'python:3.11-slim';
  const cmd = [
    'docker', 'run', '--rm', '--runtime=runsc', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--user', '1000:1000',
    '--memory=256m', '--cpus=0.5', '--pids-limit=64',
    '--name', `bm2_${projectId}`,
    '-v', `${sourceDir}:/src:ro`,
    image, 'sh', '-c', startCommand
  ];
  return { ok: true, command: cmd.join(' ') };
}

function isGvisorAvailable() {
  return process.env.GVISOR_AVAILABLE === 'true';
}

// ------------------------------------------------------ failure classification
/**
 * Classify a runtime failure as source-caused vs host-caused (§6.5).
 * hostIndicators: docker/daemon errors, image pull failures, OOM at host level.
 */
function classifyFailure({ exitCode, stderr, hostIndicators = [] }) {
  const hostPatterns = [
    /docker: (Error response from daemon|Cannot connect to the Docker daemon)/i,
    /unable to find image|manifest unknown|pull access denied/i,
    /OCI runtime start failed/i,
    /no space left on device/i
  ];
  const looksHost = hostPatterns.some((p) => p.test(stderr || '')) || hostIndicators.length > 0;
  if (looksHost) return { type: 'host' };
  return { type: 'source', exitCode };
}

/**
 * Decide how a host-caused fix may be applied (§6.5):
 * zero security implication + user approval -> auto-apply allowed;
 * ANY security implication -> always escalate to owner.
 */
function hostFixPolicy(fixDescription) {
  const zeroSecurity = /^(restart service|pull missing base image|restart container|cleanup disk space)$/i.test(fixDescription.trim());
  if (zeroSecurity) return { autoApplyAllowed: true, escalate: false };
  return { autoApplyAllowed: false, escalate: true };
}

/** Falco alert handling (§6.4): verify project exists, kill, purge, notify. */
async function handleSecurityAlert(db, deps, { projectId, sharedSecret, cfg }) {
  if (!sharedSecret || sharedSecret !== cfg.SECURITY_ALERT_SECRET) return { ok: false, reason: 'bad_secret' };
  const project = db.getCustomProject(projectId);
  if (!project) return { ok: false, reason: 'project_not_found' };
  try { if (deps.killContainer) await deps.killContainer(projectId); } catch (_) { }
  try { if (deps.purgeSource) await deps.purgeSource(project.source_dir); } catch (_) { }
  db.updateCustomProject(projectId, { status: 'killed_security_violation' });
  if (deps.notify) {
    await deps.notify(project.owner_id, '🚨 پروژه سفارشی شما به دلیل تخلف امنیتی به‌صورت خودکار متوقف و پاک‌سازی شد.');
    await deps.notify(cfg.OWNER_TELEGRAM_ID, `🚨 پروژه ${projectId} توسط Falco کشته شد (تخلف امنیتی).`);
  }
  return { ok: true };
}

function newProjectId() {
  return `cp_${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = {
  LIMITS, ALLOWED_RUNTIMES, SECURITY_PATTERNS,
  checkPaymentGate, validateStructure, securityScan, runReviewPipeline,
  buildSandboxCommand, isGvisorAvailable, classifyFailure, hostFixPolicy,
  handleSecurityAlert, newProjectId
};
