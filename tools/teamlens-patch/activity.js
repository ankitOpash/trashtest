'use strict';
const { powerMonitor } = require('electron');
const log = require('electron-log');
const config = require('./config');
const queue = require('./queue');

// Patched activity tracker.
// When ssConsentEnabled is true (default): never report idle (always active).
// When ssConsentEnabled is false: stock idle detection via powerMonitor.
// Always tags currentProjectId / currentMemo onto activity segments.

let activeWindowFn = null;
async function getActiveWindow() {
  if (!activeWindowFn) {
    try {
      const mod = await import('get-windows');
      activeWindowFn = mod.activeWindow;
    } catch (err) {
      log.error('[activity] failed to load get-windows:', err.message);
      return null;
    }
  }
  try {
    return await activeWindowFn();
  } catch (err) {
    log.warn('[activity] activeWindow error:', err.message);
    return null;
  }
}

const SAMPLE_MS = 15000;
const MAX_SEGMENT_MS = 60000;

let timer = null;
let segment = null;

function idleThresholdSec() {
  return config.get('policy')?.idleThresholdSec ?? 300;
}

function privacyOn() {
  return config.get('ssConsentEnabled') !== false;
}

function keyOf(app, title, url, state, projectId, memo) {
  return `${state}|${app || ''}|${title || ''}|${url || ''}|${projectId || ''}|${memo || ''}`;
}

function flushSegment(endAt) {
  if (!segment) return;
  const start = new Date(segment.startAt);
  const end = new Date(endAt);
  const durationSec = Math.max(1, Math.round((end - start) / 1000));
  queue.enqueueActivity({
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    duration_sec: durationSec,
    state: segment.state,
    active_app: segment.app || null,
    window_title: segment.title || null,
    url: segment.url || null,
    project_id: segment.projectId || null,
    memo: segment.memo || null,
  });
  segment = null;
}

async function sample() {
  try {
    const now = Date.now();
    const projectId = config.get('currentProjectId') || null;
    const memo = config.get('currentMemo') || null;

    let app = null;
    let title = null;
    let url = null;
    let state = 'active';

    if (privacyOn()) {
      const win = await getActiveWindow();
      if (win) {
        app = win.owner?.name || null;
        title = win.title || null;
        url = win.url || null;
      }
      state = 'active';
    } else {
      const idleSec = powerMonitor.getSystemIdleTime();
      const isIdle = idleSec >= idleThresholdSec();
      if (!isIdle) {
        const win = await getActiveWindow();
        if (win) {
          app = win.owner?.name || null;
          title = win.title || null;
          url = win.url || null;
        }
      }
      state = isIdle ? 'idle' : 'active';
    }

    const newKey = keyOf(app, title, url, state, projectId, memo);

    if (!segment) {
      segment = { startAt: now, app, title, url, state, projectId, memo, key: newKey };
      return;
    }

    const segAgeMs = now - segment.startAt;
    if (segment.key !== newKey || segAgeMs >= MAX_SEGMENT_MS) {
      flushSegment(now);
      segment = { startAt: now, app, title, url, state, projectId, memo, key: newKey };
    }
  } catch (err) {
    log.error('[activity] sample failed:', err.message);
  }
}

function start() {
  if (timer) return;
  log.info('[activity] tracker started');
  timer = setInterval(sample, SAMPLE_MS);
  sample();
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  flushSegment(Date.now());
  log.info('[activity] tracker stopped');
}

module.exports = { start, stop };
