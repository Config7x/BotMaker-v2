'use strict';

/**
 * Small in-process monitoring registry. It deliberately keeps only aggregate
 * counters and timestamps so it is safe to expose through a Prometheus-style
 * endpoint without retaining user messages, tokens, or request bodies.
 */
function createMonitoring({ now = () => Date.now(), version = '2.0.0' } = {}) {
  const startedAt = now();
  const counters = {
    httpRequests: 0,
    httpErrors: 0,
    controlPolls: 0,
    controlPollErrors: 0,
    lifecycleRuns: 0,
    lifecycleErrors: 0
  };
  const responseClasses = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  const state = {
    control: { lastSuccessAt: null, lastErrorAt: null, lastError: null },
    lifecycle: { lastSuccessAt: null, lastErrorAt: null, lastError: null, lastDurationMs: null },
    http: { lastRequestAt: null, lastErrorAt: null },
    db: { lastSuccessAt: null, lastErrorAt: null, lastError: null }
  };

  const inc = (name, amount = 1) => { counters[name] = (counters[name] || 0) + amount; };

  return {
    startedAt,
    recordHttp({ statusCode = 200, durationMs = 0 } = {}) {
      inc('httpRequests');
      state.http.lastRequestAt = now();
      const group = `${Math.floor(Number(statusCode) / 100)}xx`;
      if (responseClasses[group] !== undefined) responseClasses[group] += 1;
      if (Number(statusCode) >= 500) {
        inc('httpErrors');
        state.http.lastErrorAt = now();
      }
      return durationMs;
    },
    markControlSuccess() {
      inc('controlPolls');
      state.control.lastSuccessAt = now();
      state.control.lastError = null;
    },
    markControlError(error) {
      inc('controlPollErrors');
      state.control.lastErrorAt = now();
      state.control.lastError = String(error?.message || error || 'unknown').slice(0, 240);
    },
    markLifecycleSuccess(durationMs = null) {
      inc('lifecycleRuns');
      state.lifecycle.lastSuccessAt = now();
      state.lifecycle.lastDurationMs = Number.isFinite(durationMs) ? durationMs : null;
      state.lifecycle.lastError = null;
    },
    markLifecycleError(error, durationMs = null) {
      inc('lifecycleRuns');
      inc('lifecycleErrors');
      state.lifecycle.lastErrorAt = now();
      state.lifecycle.lastDurationMs = Number.isFinite(durationMs) ? durationMs : null;
      state.lifecycle.lastError = String(error?.message || error || 'unknown').slice(0, 240);
    },
    snapshot({ db, cfg } = {}) {
      const timestamp = now();
      const database = { ok: false };
      try {
        if (!db?.raw) throw new Error('database unavailable');
        const result = db.raw.prepare('SELECT 1 AS ok').get();
        database.ok = result?.ok === 1;
        if (database.ok) {
          state.db.lastSuccessAt = timestamp;
          state.db.lastError = null;
        }
      } catch (error) {
        state.db.lastErrorAt = timestamp;
        state.db.lastError = String(error?.message || error || 'database check failed').slice(0, 240);
        database.error = state.db.lastError;
      }

      const configuration = {
        ok: !Array.isArray(cfg?.problems) || cfg.problems.length === 0,
        problems: Array.isArray(cfg?.problems) ? cfg.problems : []
      };
      const ready = database.ok && configuration.ok;
      return {
        ok: ready,
        status: ready ? 'ready' : 'not_ready',
        service: 'botmaker-v2',
        version,
        timestamp: new Date(timestamp).toISOString(),
        uptime_seconds: Math.max(0, Math.floor((timestamp - startedAt) / 1000)),
        checks: {
          database,
          configuration,
          control_bot: {
            last_success_at: state.control.lastSuccessAt ? new Date(state.control.lastSuccessAt).toISOString() : null,
            last_error_at: state.control.lastErrorAt ? new Date(state.control.lastErrorAt).toISOString() : null,
            last_error: state.control.lastError
          },
          lifecycle: {
            last_success_at: state.lifecycle.lastSuccessAt ? new Date(state.lifecycle.lastSuccessAt).toISOString() : null,
            last_error_at: state.lifecycle.lastErrorAt ? new Date(state.lifecycle.lastErrorAt).toISOString() : null,
            last_error: state.lifecycle.lastError,
            last_duration_ms: state.lifecycle.lastDurationMs
          }
        },
        counters: { ...counters },
        response_classes: { ...responseClasses }
      };
    },
    metrics({ db, cfg } = {}) {
      const s = this.snapshot({ db, cfg });
      const lines = [
        '# HELP botmaker_ready Whether the service is ready to accept traffic.',
        '# TYPE botmaker_ready gauge',
        `botmaker_ready ${s.ok ? 1 : 0}`,
        '# HELP botmaker_uptime_seconds Process uptime in seconds.',
        '# TYPE botmaker_uptime_seconds gauge',
        `botmaker_uptime_seconds ${s.uptime_seconds}`,
        '# HELP botmaker_http_requests_total Total HTTP responses.',
        '# TYPE botmaker_http_requests_total counter',
        `botmaker_http_requests_total ${s.counters.httpRequests}`,
        '# HELP botmaker_http_errors_total Total HTTP 5xx responses.',
        '# TYPE botmaker_http_errors_total counter',
        `botmaker_http_errors_total ${s.counters.httpErrors}`,
        '# HELP botmaker_control_poll_total Successful control-bot polls.',
        '# TYPE botmaker_control_poll_total counter',
        `botmaker_control_poll_total ${s.counters.controlPolls}`,
        '# HELP botmaker_control_poll_errors_total Failed control-bot polls.',
        '# TYPE botmaker_control_poll_errors_total counter',
        `botmaker_control_poll_errors_total ${s.counters.controlPollErrors}`,
        '# HELP botmaker_lifecycle_runs_total Lifecycle scheduler runs.',
        '# TYPE botmaker_lifecycle_runs_total counter',
        `botmaker_lifecycle_runs_total ${s.counters.lifecycleRuns}`,
        '# HELP botmaker_lifecycle_errors_total Failed lifecycle scheduler runs.',
        '# TYPE botmaker_lifecycle_errors_total counter',
        `botmaker_lifecycle_errors_total ${s.counters.lifecycleErrors}`
      ];
      for (const [klass, value] of Object.entries(s.response_classes)) lines.push(`botmaker_http_responses_total{class="${klass}"} ${value}`);
      return `${lines.join('\n')}\n`;
    }
  };
}

module.exports = { createMonitoring };
