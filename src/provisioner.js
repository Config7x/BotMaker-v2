'use strict';

/**
 * Containerized-template provisioner (§3 items 10 & 11).
 * Each containerized bot instance runs in its OWN Docker container reusing
 * the gVisor sandbox infra from §6: --runtime=runsc, cap-drop=ALL,
 * no-new-privileges, resource limits, read-only rootfs + writable data volume.
 * FAIL CLOSED: without gVisor, provisioning is refused outright.
 *
 * Unlike §6 custom-source, there is NO AI scan / admin approval — the source
 * is pre-built, code-reviewed, and ships with the platform.
 *
 * The docker executor is injectable for tests.
 */
const { execFile } = require('child_process');

function realExec(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err ? err.message : '') });
    });
  });
}

function createProvisioner(opts = {}) {
  const exec = opts.exec || realExec;
  const docker = async (args) => exec('docker', args);
  const netName = opts.network || 'botmaker_bridge';

  async function gvisorAvailable() {
    if (opts.gvisor !== undefined) return opts.gvisor;
    if (process.env.GVISOR_AVAILABLE === 'true') return true;
    if (process.env.GVISOR_AVAILABLE === 'false') return false;
    const r = await docker(['info', '--format', '{{json .Runtimes}}']);
    return r.ok && /runsc/.test(r.stdout);
  }

  /**
   * Provision one container for a bot instance.
   * @param {object} p { botId, image, env: {K:V}, mem, cpus, requiresNetwork }
   */
  async function provision(p) {
    if (!(await gvisorAvailable())) {
      // FAIL CLOSED — never fall back to a non-gVisor runtime
      return { ok: false, reason: 'gvisor_missing' };
    }
    const name = `bm2_c_${p.botId}`;
    // dedicated bridge network (outbound: Telegram API + customer panel)
    await docker(['network', 'create', '--driver', 'bridge', netName]).catch(() => {});
    // data volume keeps MySQL/SQLite/session state across restarts
    await docker(['volume', 'create', `${name}_data`]).catch(() => {});

    const args = ['run', '-d', '--name', name,
      '--runtime=runsc',
      '--restart=unless-stopped',
      '--network', netName,
      '--cap-drop=ALL',
      '--security-opt', 'no-new-privileges',
      '--read-only',
      '--tmpfs', '/tmp:rw,size=64m,noexec',
      '--pids-limit', String(p.pidsLimit || 512),
      '--memory', p.mem || '512m',
      '--cpus', String(p.cpus || 1.0),
      '-v', `${name}_data:/app/data`,
      '--shm-size', p.shm || '128m'];
    for (const [k, v] of Object.entries(p.env || {})) args.push('-e', `${k}=${v}`);
    args.push(p.image);

    const r = await docker(args);
    if (!r.ok) {
      await docker(['rm', '-f', name]).catch(() => {});
      return { ok: false, reason: 'docker_run_failed', stderr: r.stderr };
    }
    return { ok: true, containerName: name, volumeName: `${name}_data` };
  }

  async function action(botId, act) {
    const name = `bm2_c_${botId}`;
    const r = await docker([act, name]);
    return { ok: r.ok, stderr: r.stderr };
  }
  const stop = (botId) => action(botId, 'stop');
  const start = (botId) => action(botId, 'start');
  const restart = (botId) => action(botId, 'restart');

  async function status(botId) {
    const name = `bm2_c_${botId}`;
    const r = await docker(['inspect', '-f', '{{.State.Status}}', name]);
    if (!r.ok) return { ok: false, state: 'missing' };
    return { ok: true, state: r.stdout.trim() };
  }

  /** Destroy the container AND its data volume (irreversible). */
  async function destroy(botId) {
    const name = `bm2_c_${botId}`;
    await docker(['rm', '-f', name]);
    const v = await docker(['volume', 'rm', `${name}_data`]);
    return { ok: v.ok };
  }

  return { gvisorAvailable, provision, stop, start, restart, status, destroy };
}

module.exports = { createProvisioner };
