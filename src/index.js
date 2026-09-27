'use strict';

/**
 * BotMaker v2 entrypoint: inits config/db, starts the webhook dispatcher
 * (Express), the control-bot getUpdates loop (single instance to avoid
 * Telegram 409 conflicts), and the lifecycle scheduler (demo cycle +
 * auto-renewals). Single instance enforced via a lock file.
 */
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { createDb } = require('./db');
const { TelegramApi } = require('./telegram');
const { decrypt } = require('./cryptoutil');
const { createWebhookApp } = require('./webhook');
const { createControlBot } = require('./admin');
const { registry } = require('./templates/registry');
const lifecycle = require('./lifecycle');
const customsource = require('./customsource');
const { realClock } = require('./clock');
const { createMonitoring } = require('./monitoring');

/** Acquire a single-instance lock; exits if another process holds it. */
function acquireLock(lockPath) {
  if (fs.existsSync(lockPath)) {
    const pid = fs.readFileSync(lockPath, 'utf8').trim();
    if (pid && Number.isFinite(Number(pid))) {
      try { process.kill(Number(pid), 0); throw new Error('locked'); } catch (e) {
        if (e.message === 'locked') {
          console.error(`Another BotMaker instance (pid ${pid}) is running. Exiting to avoid Telegram 409 conflicts.`);
          process.exit(2);
        }
        // stale lock -> take over
      }
    }
  }
  fs.writeFileSync(lockPath, String(process.pid));
}

function start(opts = {}) {
  const cfg = loadConfig(opts.envPath);
  if (cfg.problems.length && !opts.allowIncomplete) {
    console.error('Config problems:\n- ' + cfg.problems.join('\n- '));
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(cfg.DB_PATH), { recursive: true });
  acquireLock(path.join(path.dirname(cfg.DB_PATH), 'botmaker.lock'));

  const db = createDb(cfg.DB_PATH);
  const clock = opts.clock || realClock();
  const monitoring = opts.monitoring || createMonitoring();
  const isMock = !!opts.mockTelegram;
  const mockLog = opts.mockLog || [];

  const makeApi = (token) => new TelegramApi(token, {
    mock: isMock, mockLog,
    mockChatMemberStatus: opts.mockChatMemberStatus
  });
  const apiFor = (bot) => makeApi(decrypt(bot.token_encrypted, cfg.ENCRYPTION_KEY));
  const controlApi = makeApi(cfg.CONTROL_BOT_TOKEN || 'mock:mock');

  const controlBot = createControlBot({ db, cfg, registry, apiFor, makeApi, controlApi, clock });

  function notifyUser(id, text) {
    return controlApi.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});
  }

  const app = createWebhookApp({
    db, cfg, registry, apiFor, monitoring,
    onSecurityAlert: ({ projectId, sharedSecret }) => customsource.handleSecurityAlert(
      db,
      {
        killContainer: opts.killContainer,   // e.g. `docker kill bm2_<id>` (owner host)
        purgeSource: opts.purgeSource,      // rm -rf extracted source dir
        notify: (id, text) => notifyUser(id, text)
      },
      { projectId, sharedSecret, cfg }
    )
  });

  let httpServer = null;
  function startHttp(port) {
    httpServer = app.listen(port, () => console.log(`[botmaker] webhook dispatcher on :${port}`));
  }

  // control bot long-polling loop (single instance — no parallel pollers)
  let offset = 0;
  let polling = false;
  async function pollLoop() {
    polling = true;
    while (polling) {
      try {
        const r = await controlApi.getUpdates(offset);
        monitoring.markControlSuccess();
        for (const u of r.result || []) {
          offset = Math.max(offset, (u.update_id || 0) + 1);
          try { await controlBot.processUpdate(u); } catch (err) { console.error('[control] handler error:', err.message); }
        }
      } catch (err) {
        monitoring.markControlError(err);
        console.error('[control] poll error:', err.message);
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
  }

  // lifecycle scheduler: demo warnings/grace/deletion + auto-renewals
  function scheduleLifecycle(intervalMs = 30000) {
    return setInterval(() => {
      const started = Date.now();
      lifecycle.tick(db, { apiFor, publicUrl: cfg.PUBLIC_URL }, clock.now())
        .then(() => monitoring.markLifecycleSuccess(Date.now() - started))
        .catch((e) => {
          monitoring.markLifecycleError(e, Date.now() - started);
          console.error('[lifecycle] tick error:', e.message);
        });
    }, intervalMs);
  }

  return {
    cfg, db, controlBot, controlApi, app, apiFor, makeApi, monitoring,
    startHttp, pollLoop, scheduleLifecycle,
    stop() { polling = false; if (httpServer) httpServer.close(); }
  };
}

module.exports = { start };

if (require.main === module) {
  const app = start();
  app.startHttp(app.cfg.PORT);
  if (!app.cfg.MOCK_TELEGRAM) app.pollLoop();
  app.scheduleLifecycle();
  console.log('[botmaker] running');
}
