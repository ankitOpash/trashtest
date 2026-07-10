'use strict';
const { powerMonitor } = require('electron');
const log = require('electron-log');
const config = require('./config');
const queue = require('./queue');

// get-windows is ESM-only; load it lazily via dynamic import and cache it.
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
    // requireAccessibility ensures URL/title on macOS when permission granted
    return await activeWindowFn();
  } catch (err) {
    log.warn('[activity] activeWindow error:', err.message);
    return null;
  }
}

// Sampling model: every SAMPLE_MS we read foreground app + idle time. We
// accumulate a "current segment" and flush it as one activity event whenever
// the app/state changes or the segment exceeds MAX_SEGMENT_MS.
const SAMPLE_MS = 15000; // 15s sampling
const MAX_SEGMENT_MS = 60000; // cap each event at 60s

let timer = null;
let segment = null; // { startAt, app, title, url, state }

function idleThresholdSec() {
  return config.get('policy')?.idleThresholdSec ?? 300;
}

function keyOf(app, title, url, state) {
  return `${state}|${app || ''}|${title || ''}|${url || ''}`;
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
  });
  segment = null;
}

async function sample() {
  try {
    const idleSec = powerMonitor.getSystemIdleTime();
    const isIdle = idleSec >= idleThresholdSec();
    const now = Date.now();

    let app = null;
    let title = null;
    let url = null;

    if (!isIdle) {
      const win = await getActiveWindow();
      if (win) {
        app = win.owner?.name || null;
        title = win.title || null;
        url = win.url || null; // present on macOS for browsers; often null on Windows
      }
    }

    const state = isIdle ? 'idle' : 'active';
    const newKey = keyOf(app, title, url, state);

    if (!segment) {
      segment = { startAt: now, app, title, url, state, key: newKey };
      return;
    }

    const segAgeMs = now - segment.startAt;
    if (segment.key !== newKey || segAgeMs >= MAX_SEGMENT_MS) {
      flushSegment(now);
      segment = { startAt: now, app, title, url, state, key: newKey };
    }
  } catch (err) {
    log.error('[activity] sample failed:', err.message);
  }
}

function start() {
  if (timer) return;
  log.info('[activity] tracker started');
  timer = setInterval(sample, SAMPLE_MS);
  sample(); // immediate first sample
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
