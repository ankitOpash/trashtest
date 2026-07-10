'use strict';
const log = require('electron-log');
const queue = require('./queue');
const api = require('./api');

const FLUSH_MS = 20000; // try to drain every 20s
let timer = null;
let busy = false;

async function flushScreenshots() {
  const rows = queue.nextScreenshots(5);
  for (const row of rows) {
    try {
      const { ok, status } = await api.uploadScreenshot(row);
      if (ok) {
        queue.deleteScreenshot(row.id);
      } else if (status === 401) {
        log.warn('[upload] device unauthorized; will retry after re-check');
        return false; // stop; main will re-validate enrollment
      } else {
        queue.bumpScreenshotAttempt(row.id);
        log.warn(`[upload] screenshot ${row.id} failed status ${status}`);
      }
    } catch (err) {
      queue.bumpScreenshotAttempt(row.id);
      log.warn('[upload] screenshot network error:', err.message);
      return false; // likely offline; back off
    }
  }
  return true;
}

async function flushActivity() {
  const rows = queue.nextActivity(100);
  if (!rows.length) return true;
  const events = rows.map((r) => ({
    startAt: r.start_at,
    endAt: r.end_at,
    durationSec: r.duration_sec,
    state: r.state,
    activeApp: r.active_app,
    windowTitle: r.window_title,
    url: r.url,
  }));
  try {
    const { ok, status } = await api.uploadActivity(events);
    if (ok) {
      queue.deleteActivity(rows.map((r) => r.id));
    } else if (status === 401) {
      return false;
    } else {
      queue.bumpActivityAttempts(rows.map((r) => r.id));
    }
  } catch (err) {
    queue.bumpActivityAttempts(rows.map((r) => r.id));
    log.warn('[upload] activity network error:', err.message);
    return false;
  }
  return true;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await flushActivity();
    // keep draining screenshots while there are more and uploads succeed
    let ok = true;
    while (ok && queue.stats().screenshots > 0) {
      ok = await flushScreenshots();
      if (!ok) break;
    }
    queue.prune();
  } catch (err) {
    log.error('[upload] tick error:', err.message);
  } finally {
    busy = false;
  }
}

function start() {
  if (timer) return;
  log.info('[upload] flusher started');
  timer = setInterval(tick, FLUSH_MS);
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
