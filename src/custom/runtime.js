'use strict';

/**
 * PRIVATE LAB-ONLY Hardened Docker Runner API
 * BotMaker v2 Core Engine
 *
 * Implements isolated, non-host container runner for reviewed bot source code.
 * Requires explicit environment approval (REVIEWED=true and TEST_LAB_MODE=true).
 * Direct host execution fallback (npm/pip/node/python) is strictly prohibited.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { checkDockerAvailable, checkGvisorAvailable } = require('./container');
const { validateManifestAndStartCommand, validateRuntime, validateStartCommand } = require('./manifest');
const { DEFAULT_CONFIG } = require('./constants');

/**
 * Isolation Notice & Security Caveats
 */
const ISOLATION_NOTICE = [
  'Docker container isolation provides OS-level resource limits and network isolation for private lab testing only.',
  'Docker containers share the host Linux kernel and cannot guarantee strong tenant isolation for untrusted arbitrary code in multi-tenant public environments.',
  'Direct execution on host (npm, pip, node, python) is strictly prohibited. Package installations and execution occur exclusively inside hardened containers.',
  'Lab execution requires explicit review and gating flags (REVIEWED=true, TEST_LAB_MODE=true and LAB_ALLOW_NETWORK=true).',
  'Docker bridge networking is required for Telegram and dependencies. It can reach host/internal networks without additional firewall rules; never use for public untrusted tenants.'
];

// In-memory registry tracking active bot container runtimes
const containerRegistry = new Map();

/**
 * Ensure lab environment flags are explicitly set
 */
function verifyLabEnvironment() {
  if (process.env.REVIEWED !== 'true' || process.env.TEST_LAB_MODE !== 'true') {
    throw new Error('Lab execution prohibited: REVIEWED=true and TEST_LAB_MODE=true environment variables are required.');
  }
}

/**
 * Verify Docker CLI & daemon availability failing closed without host fallback
 * @param {Function} [execFileFn]
 * @returns {Promise<string>}
 */
async function verifyDockerAvailable(execFileFn = execFile) {
  return new Promise((resolve, reject) => {
    execFileFn('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) {
        return reject(
          new Error(
            `Docker is absent or unavailable on host: ${err.message || stderr || 'Command failed'}. Direct host execution fallback is strictly prohibited.`
          )
        );
      }
      resolve(stdout ? stdout.trim() : 'Ready');
    });
  });
}

/**
 * Classify a runtime error into cause ('source' | 'host') and flag whether security review is required.
 *
 * Heuristics:
 * - SOURCE-caused: Application syntax errors, unhandled exceptions, missing modules in code, type errors.
 * - HOST-caused: Docker daemon errors, gVisor failures, disk space full, system permission errors, kernel/container runtime failures.
 * - Security Implication: Any error involving privileged paths, permission denied on host resources, syscall violations, memory corruption (SIGSEGV), or ambiguous environment errors defaults to requiresSecurityReview = true.
 *
 * @param {Error|Object|string} errorInfo
 * @returns {{ cause: 'source'|'host', requiresSecurityReview: boolean }}
 */
function classifyRuntimeError(errorInfo) {
  const text = String(
    errorInfo?.message ||
    errorInfo?.stderr ||
    errorInfo?.logs ||
    (typeof errorInfo === 'string' ? errorInfo : JSON.stringify(errorInfo || ''))
  );

  // Security sensitive keywords / patterns
  const securityPatterns = [
    /\/etc\/(passwd|shadow|hosts)/i,
    /\/proc\/|\/sys\//i,
    /docker\.sock/i,
    /SIGSEGV|segmentation fault|bus error/i,
    /EACCES|EPERM|permission denied/i,
    /unauthorized syscall|seccomp|cap_drop|capability/i,
    /root access|privilege escalation|chroot|ptrace/i
  ];

  const hasSecurityImplication = securityPatterns.some((pattern) => pattern.test(text));

  // Host error patterns
  const hostPatterns = [
    /docker: Error response from daemon/i,
    /Cannot connect to the Docker daemon/i,
    /runsc: /i,
    /gVisor/i,
    /no space left on device/i,
    /Out of memory/i,
    /pids limit reached/i,
    /container runtime error/i,
    /No such image/i,
    /port is already allocated/i
  ];

  const isHostError = hostPatterns.some((pattern) => pattern.test(text));

  // Source error patterns
  const sourcePatterns = [
    /SyntaxError/i,
    /ReferenceError/i,
    /TypeError/i,
    /RangeError/i,
    /UnhandledPromiseRejection/i,
    /MODULE_NOT_FOUND/i,
    /Cannot find module/i,
    /IndentationError/i,
    /NameError/i,
    /ModuleNotFoundError/i,
    /ImportError/i,
    /AttributeError/i,
    /IndexError/i,
    /KeyError/i
  ];

  const isSourceError = sourcePatterns.some((pattern) => pattern.test(text));

  let cause = 'source';
  if (isHostError) {
    cause = 'host';
  } else if (isSourceError) {
    cause = 'source';
  } else {
    // Ambiguous case: err toward host if it looks like system error, or source if unknown app error
    cause = text.includes('docker') || text.includes('host') ? 'host' : 'source';
  }

  // Ambiguous or security-pattern-matched cases must err toward requiresSecurityReview = true
  const requiresSecurityReview = hasSecurityImplication || (!isSourceError && !isHostError);

  return {
    cause,
    requiresSecurityReview
  };
}

class DockerRunner {
  constructor(options = {}) {
    this.options = options;
    this.execFileFn = options.execFile || execFile;
  }

  /**
   * Start a reviewed bot in a hardened lab Docker container with gVisor (--runtime=runsc)
   *
   * @param {Object} params
   * @param {string} params.sourceDir Local directory path containing reviewed source code
   * @param {Object|string} [params.manifest] Optional manifest override object
   * @param {string|number} params.botId Bot ID
   * @param {string} [params.telegramToken] Telegram bot API token
   * @returns {Promise<Object>}
   */
  async start({ sourceDir, manifest, botId, telegramToken } = {}) {
    verifyLabEnvironment();

    if (!botId) {
      throw new Error('botId is required to start a Docker lab runner.');
    }
    if (!sourceDir) {
      throw new Error('sourceDir is required to start a Docker lab runner.');
    }

    const execFileFn = this.options.execFile || execFile;
    await verifyDockerAvailable(execFileFn);

    // Verify gVisor (runsc) availability
    if (!this.options.skipGvisorCheck) {
      const gvisor = await checkGvisorAvailable(3000, execFileFn);
      if (!gvisor.available) {
        throw new Error(`gVisor (runsc) runtime is unavailable: ${gvisor.reason}. Refusing to start custom-source container without gVisor sandbox.`);
      }
    }

    const canonicalSource = path.resolve(sourceDir);
    if (!fs.existsSync(canonicalSource)) {
      throw new Error(`Source directory does not exist: ${sourceDir}`);
    }

    // Parse / validate manifest
    let manifestInfo = null;

    if (manifest && typeof manifest === 'object') {
      const runtimeInput = manifest.runtime || 'node20';
      const startCmdInput = manifest.startCommand || manifest.start || (runtimeInput.includes('python') ? 'python main.py' : 'node index.js');

      const runtimeRes = validateRuntime(runtimeInput);
      if (!runtimeRes.valid) {
        throw new Error(`Manifest runtime validation failed: ${runtimeRes.error}`);
      }

      const startRes = validateStartCommand(startCmdInput, runtimeRes.normalizedRuntime, canonicalSource);
      if (!startRes.valid) {
        throw new Error(`Start command validation failed: ${startRes.error}`);
      }

      manifestInfo = {
        runtime: runtimeRes.normalizedRuntime,
        startCommand: startCmdInput
      };
    } else {
      const validated = validateManifestAndStartCommand(canonicalSource);
      if (!validated.valid) {
        throw new Error(`Manifest validation failed: ${(validated.errors || []).join('; ')}`);
      }
      manifestInfo = {
        runtime: validated.runtime,
        startCommand: validated.startCommand
      };
    }

    if (process.env.LAB_ALLOW_NETWORK !== 'true') throw new Error('Private bot needs Telegram network; set LAB_ALLOW_NETWORK=true only on a disposable dedicated VPS.');
    if (!/^src_[a-f0-9]{16}$/.test(String(botId)) && !this.options.execFile) throw new Error('Invalid project ID');

    // Deterministic name allows stop/restart after manager process restarts.
    await this.stop({ botId });

    const containerName = `botlab-${botId}`;

    const runtime = manifestInfo.runtime || 'node20';
    const containerCfg = { ...DEFAULT_CONFIG.containerDefaults, ...this.options.containerDefaults };
    const image = runtime === 'python311' ? containerCfg.images.python311 : containerCfg.images.node20;

    // Command tokens
    const commandTokens = manifestInfo.startCommand.trim().split(/\s+/);

    // Build Docker arguments array with gVisor enforcement (--runtime=runsc)
    const dockerArgs = [
      'run',
      '-d',
      '--runtime=runsc',
      `--name=${containerName}`,
      '--security-opt=no-new-privileges',
      '--cap-drop=ALL',
      `--user=${containerCfg.user || '1000:1000'}`,
      `--cpus=${containerCfg.cpuLimit || '0.5'}`,
      `--memory=${containerCfg.memoryLimit || '256m'}`,
      `--memory-swap=${containerCfg.memorySwap || '256m'}`,
      `--pids-limit=${containerCfg.pidsLimit || 64}`,
      '--read-only',
      '--tmpfs=/tmp:rw,noexec,nosuid',
      '--tmpfs=/root:rw,noexec,nosuid',
      '-v', `${canonicalSource}:/app:ro`,
      '-w', '/app',
      '--init',
      '--restart=no',
      '--network=bridge',
      '--tmpfs=/work:rw,nosuid,size=512m,uid=1000,gid=1000,mode=0755',
      '-e', 'HOME=/work'
    ];

    if (telegramToken) {
      dockerArgs.push('-e', `TELEGRAM_TOKEN=${telegramToken}`);
    }
    dockerArgs.push('-e', `BOT_ID=${botId}`);

    const entry = commandTokens[1];
    if (commandTokens.length !== 2 || !/^[A-Za-z0-9_.\/-]+$/.test(entry) || entry.startsWith('/') || entry.split('/').includes('..')) {
      throw new Error('Lab runner supports only node FILE.js or python FILE.py entry points');
    }
    const prepare = runtime === 'python311'
      ? `cp -a /app/. /work/ && cd /work && if test -f requirements.txt; then pip install --no-cache-dir --disable-pip-version-check --target /work/.deps -r requirements.txt || exit 1; fi; export PYTHONPATH=/work/.deps; exec python3 ${entry}`
      : `cp -a /app/. /work/ && cd /work && if test -f package.json; then npm install --ignore-scripts --omit=dev --no-audit --no-fund || exit 1; fi; exec node ${entry}`;
    dockerArgs.push(image, 'sh', '-c', prepare);

    return new Promise((resolve, reject) => {
      execFileFn('docker', dockerArgs, { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Failed to start container for bot ${botId}: Docker failed (details hidden to protect tokens)`));
        }

        const containerId = stdout ? stdout.trim() : containerName;
        const record = {
          botId: String(botId),
          containerName,
          containerId,
          sourceDir: canonicalSource,
          runtime,
          startedAt: new Date().toISOString(),
          status: 'running',
        };

        containerRegistry.set(String(botId), record);

        resolve({
          success: true,
          botId: String(botId),
          containerName,
          containerId,
          status: 'running',
          runtime,
          securityCaveats: ISOLATION_NOTICE
        });
      });
    });
  }

  /**
   * Stop and remove Docker container for a given botId
   *
   * @param {Object} params
   * @param {string|number} params.botId
   * @returns {Promise<Object>}
   */
  async stop({ botId } = {}) {
    verifyLabEnvironment();

    if (!botId) {
      throw new Error('botId is required to stop a Docker lab runner.');
    }

    const execFileFn = this.options.execFile || execFile;
    await verifyDockerAvailable(execFileFn);

    const record = containerRegistry.get(String(botId));
    const containerName = record ? record.containerName : `botlab-${botId}`;

    return new Promise((resolve, reject) => {
      execFileFn('docker', ['rm', '-f', containerName], { timeout: 10000 }, (err, stdout, stderr) => {
        if (record) {
          record.status = 'stopped';
          containerRegistry.delete(String(botId));
        }

        if (err && !err.message?.includes('No such container') && !stderr?.includes('No such container')) {
          return reject(new Error(`Failed to stop container for bot ${botId}: ${err.message || stderr}`));
        }

        resolve({
          success: true,
          botId: String(botId),
          containerName,
          status: 'stopped'
        });
      });
    });
  }

  /**
   * Check status of Docker container for a given botId
   *
   * @param {Object} params
   * @param {string|number} params.botId
   * @returns {Promise<Object>}
   */
  async status({ botId } = {}) {
    verifyLabEnvironment();

    if (!botId) {
      throw new Error('botId is required to check status.');
    }

    const execFileFn = this.options.execFile || execFile;
    await verifyDockerAvailable(execFileFn);

    const containerName = `botlab-${botId}`;

    return new Promise((resolve) => {
      execFileFn('docker', ['inspect', '--format', '{{.State.Running}}', containerName], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          return resolve({ running: false, botId: String(botId), containerName });
        }
        const isRunning = stdout ? stdout.trim() === 'true' : false;
        resolve({ running: isRunning, botId: String(botId), containerName });
      });
    });
  }

  /**
   * Fetch logs for a running or stopped container
   *
   * @param {Object} params
   * @param {string|number} params.botId
   * @param {number} [params.tail=100]
   * @returns {Promise<Object>}
   */
  async logs({ botId, tail = 100 } = {}) {
    verifyLabEnvironment();

    if (!botId) {
      throw new Error('botId is required to get logs.');
    }

    const execFileFn = this.options.execFile || execFile;
    await verifyDockerAvailable(execFileFn);

    const containerName = `botlab-${botId}`;

    return new Promise((resolve, reject) => {
      execFileFn('docker', ['logs', `--tail=${tail}`, containerName], { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Failed to fetch logs for bot ${botId}: ${err.message || stderr}`));
        }
        resolve({ botId: String(botId), logs: stdout || stderr || '' });
      });
    });
  }
}

let defaultRunner = new DockerRunner();

function setRunnerOptions(opts = {}) {
  defaultRunner = new DockerRunner(opts);
}

async function start(params, opts) {
  if (opts) {
    const runner = new DockerRunner(opts);
    return runner.start(params);
  }
  return defaultRunner.start(params);
}

async function stop(params, opts) {
  if (opts) {
    const runner = new DockerRunner(opts);
    return runner.stop(params);
  }
  return defaultRunner.stop(params);
}

async function status(params, opts) {
  if (opts) {
    const runner = new DockerRunner(opts);
    return runner.status(params);
  }
  return defaultRunner.status(params);
}

async function logs(params, opts) {
  if (opts) {
    const runner = new DockerRunner(opts);
    return runner.logs(params);
  }
  return defaultRunner.logs(params);
}

module.exports = {
  DockerRunner,
  start,
  stop,
  status,
  logs,
  setRunnerOptions,
  checkDockerAvailable: verifyDockerAvailable,
  checkGvisorAvailable,
  classifyRuntimeError,
  ISOLATION_NOTICE,
  SECURITY_CAVEATS: ISOLATION_NOTICE
};
