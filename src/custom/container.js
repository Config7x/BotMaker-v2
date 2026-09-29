'use strict';

const { execFile } = require('child_process');
const path = require('path');
const { DEFAULT_CONFIG, SECURITY_CAVEATS } = require('./constants');

/**
 * Check if Docker CLI and daemon are available on host environment
 * @param {number} timeoutMs
 * @param {Function} [execFileFn]
 * @returns {Promise<{ available: boolean, reason: string|null, version: string|null }>}
 */
function checkDockerAvailable(timeoutMs = 3000, execFileFn = execFile) {
  return new Promise((resolve) => {
    execFileFn('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          available: false,
          reason: `Docker is unavailable on host: ${err.message || stderr || 'Command failed'}`,
          version: null
        });
      }
      return resolve({
        available: true,
        reason: null,
        version: stdout ? stdout.trim() : 'Unknown'
      });
    });
  });
}

/**
 * Check if gVisor (runsc) runtime is registered and available in Docker daemon
 * @param {number} timeoutMs
 * @param {Function} [execFileFn]
 * @returns {Promise<{ available: boolean, reason: string|null }>}
 */
function checkGvisorAvailable(timeoutMs = 3000, execFileFn = execFile) {
  return new Promise((resolve) => {
    execFileFn('docker', ['info', '--format', '{{json .Runtimes}}'], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          available: false,
          reason: `Failed to check Docker runtimes: ${err.message || stderr || 'Command failed'}`
        });
      }
      const output = stdout ? stdout.trim() : '';
      const hasGvisor = output.includes('runsc');
      if (hasGvisor) {
        return resolve({ available: true, reason: null });
      }
      return resolve({
        available: false,
        reason: 'gVisor (runsc) runtime is not configured or available in Docker environment.'
      });
    });
  });
}

/**
 * Build hardened Docker CLI arguments array
 *
 * Security Flags enforced:
 * - gVisor sandbox runtime (--runtime=runsc)
 * - Disposable container (--rm)
 * - Network disabled (--network none)
 * - Read-only root filesystem (--read-only)
 * - Tmpfs mounts for temporary files (--tmpfs)
 * - Privilege escalation prevention (--security-opt=no-new-privileges)
 * - Drop all Linux capabilities (--cap-drop=ALL)
 * - Non-root user execution (--user 1000:1000)
 * - Resource constraints (--cpus=0.5, --memory=256m, --pids-limit=64)
 * - Read-only source code mount (-v source:app:ro)
 * - Zero host secret environment variables or socket mounts passed
 *
 * @param {string} sourcePath Absolute path to extracted source directory
 * @param {Object} manifestInfo Validated manifest info ({ runtime, startCommand })
 * @param {Object} options Configuration overrides
 * @returns {string[]} Array of CLI arguments for docker run
 */
function buildContainerArgs(sourcePath, manifestInfo, options = {}) {
  const containerCfg = { ...DEFAULT_CONFIG.containerDefaults, ...options.container };
  const canonicalSourcePath = path.resolve(sourcePath);
  const runtime = manifestInfo ? manifestInfo.runtime : 'node20';
  const image = runtime === 'python311' ? containerCfg.images.python311 : containerCfg.images.node20;

  const args = [
    'run',
    '--rm',
    '--runtime=runsc',
    `--network=${containerCfg.networkMode}`,
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    `--user=${containerCfg.user}`,
    `--cpus=${containerCfg.cpuLimit}`,
    `--memory=${containerCfg.memoryLimit}`,
    `--memory-swap=${containerCfg.memorySwap}`,
    `--pids-limit=${containerCfg.pidsLimit}`
  ];

  if (containerCfg.readOnlyRoot) {
    args.push('--read-only');
  }

  for (const tmpfs of containerCfg.tmpfsMounts) {
    args.push(`--tmpfs=${tmpfs}`);
  }

  // Mount extracted source as READ-ONLY into container /app
  args.push('-v', `${canonicalSourcePath}:/app:ro`);
  args.push('-w', '/app');

  // Container image
  args.push(image);

  // Command inside container: safe diagnostic smoke test / version check
  if (runtime === 'python311') {
    args.push('python3', '-c', 'import sys; print(f"Container Python Ready: {sys.version}")');
  } else {
    args.push('node', '-e', 'console.log(`Container Node Ready: ${process.version}`)');
  }

  return args;
}

/**
 * Run private container diagnostics and smoke test ONLY if Docker and gVisor are available
 * and private testing review gate is explicitly enabled.
 *
 * Direct execution on host (npm/pip) is STRICTLY PROHIBITED and will never be attempted.
 *
 * @param {string} sourcePath
 * @param {Object} manifestInfo
 * @param {Object} options
 * @returns {Promise<Object>}
 */
async function runContainerDiagnostics(sourcePath, manifestInfo, options = {}) {
  const allowPrivateTest = Boolean(options.allowPrivateTestExecution || options.privateTestGate?.enabled);
  const execFileFn = options.execFile || execFile;

  // 1. Review Gate Check
  if (!allowPrivateTest) {
    return {
      status: 'disabled',
      tested: false,
      reason: 'Private container test execution gate is disabled. Enable after explicit admin review (options.allowPrivateTestExecution = true).',
      container: null,
      securityCaveats: SECURITY_CAVEATS
    };
  }

  // 2. Docker Availability Check
  const dockerStatus = await checkDockerAvailable(options.dockerTimeoutMs || 3000, execFileFn);

  if (!dockerStatus.available) {
    return {
      status: 'skipped',
      tested: false,
      reason: 'Docker is unavailable on host environment. Direct host execution fallback for npm/pip/node/python is strictly prohibited for security reasons.',
      dockerStatus,
      container: null,
      securityCaveats: SECURITY_CAVEATS
    };
  }

  // 3. gVisor Check
  const gvisorStatus = await checkGvisorAvailable(options.dockerTimeoutMs || 3000, execFileFn);
  if (!gvisorStatus.available) {
    return {
      status: 'failed',
      tested: false,
      reason: `gVisor (runsc) runtime is unavailable: ${gvisorStatus.reason}. Custom source container start failed closed.`,
      container: null,
      securityCaveats: SECURITY_CAVEATS
    };
  }

  // 4. Build Hardened Arguments
  const dockerArgs = buildContainerArgs(sourcePath, manifestInfo, options);

  // 5. Execute Disposable Container
  const timeout = options.timeoutMs || DEFAULT_CONFIG.containerDefaults.timeoutMs;

  return new Promise((resolve) => {
    execFileFn('docker', dockerArgs, { timeout }, (err, stdout, stderr) => {
      if (err) {
        return resolve({
          status: 'failed',
          tested: true,
          reason: `Container execution failed or timed out: ${err.message}`,
          exitCode: err.code || 1,
          stdout: stdout ? stdout.trim() : '',
          stderr: stderr ? stderr.trim() : '',
          securityCaveats: SECURITY_CAVEATS
        });
      }

      return resolve({
        status: 'completed',
        tested: true,
        reason: 'Container smoke test diagnostics completed successfully inside hardened container.',
        exitCode: 0,
        stdout: stdout ? stdout.trim() : '',
        stderr: stderr ? stderr.trim() : '',
        securityCaveats: SECURITY_CAVEATS
      });
    });
  });
}

module.exports = {
  checkDockerAvailable,
  checkGvisorAvailable,
  buildContainerArgs,
  runContainerDiagnostics
};
