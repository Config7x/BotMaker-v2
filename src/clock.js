'use strict';

/**
 * Injectable clock. Production uses real time; tests use fakeClock
 * so lifecycle/demo-cycle logic NEVER sleeps and time is fully controlled.
 */
function realClock() {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args),
    clearInterval: (t) => clearInterval(t),
    setInterval: (fn, ms) => setInterval(fn, ms)
  };
}

/** Test clock: manual time, no real timers. */
function fakeClock(start = 0) {
  let t = start;
  const timers = [];
  return {
    now: () => t,
    advance(ms) {
      t += ms;
      for (;;) { // fire due timers in order
        const due = timers.filter((x) => !x.cancelled && x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cancelled = true;
        due.fn();
      }
    },
    setTimeout: (fn, ms) => {
      const h = { at: t + ms, fn, cancelled: false };
      timers.push(h);
      return h;
    },
    clearInterval: () => {},
    setInterval: () => ({ fake: true })
  };
}

module.exports = { realClock, fakeClock };
