'use strict';
const { screen } = require('electron');
const log = require('electron-log');
const config = require('./config');
const queue = require('./queue');
const { capturePrimary } = require('./capture');

let windowsFns = null;
let windowsUnavailable = false;

async function loadWindowsFns() {
  if (windowsUnavailable) return null;
  if (!windowsFns) {
    try {
      const mod = await import('get-windows');
      windowsFns = { activeWindow: mod.activeWindow, openWindows: mod.openWindows };
    } catch (err) {
      windowsUnavailable = true;
      log.warn('[shot] get-windows unavailable; screenshots will have no app/window context:', err.message);
    }
  }
  return windowsFns;
}

async function getActiveWindow() {
  const fns = await loadWindowsFns();
  if (!fns) return null;
  try { return await fns.activeWindow(); } catch { return null; }
}

// Returns substantial, visible windows across every monitor — suitable for privacy checks.
// Filters out: minimised windows (Windows puts them at -32000,-32000), small notification
// toasts, and any window whose centre doesn't fall inside a real display.
async function getAllVisibleWindows() {
  const fns = await loadWindowsFns();
  if (!fns?.openWindows) return [];
  try {
    const displays = screen.getAllDisplays();
    const all = await fns.openWindows();
    return all.filter((w) => {
      // Minimised windows on Windows get bounds.x = bounds.y = -32000
      if (w.bounds.x <= -9999 || w.bounds.y <= -9999) return false;
      // Ignore tiny popups / notification toasts — main app windows are at least 300×200
      if (w.bounds.width < 300 || w.bounds.height < 200) return false;
      // Window centre must lie within an actual display (rules out off-screen ghosts)
      const cx = w.bounds.x + w.bounds.width / 2;
      const cy = w.bounds.y + w.bounds.height / 2;
      return displays.some((d) => {
        const b = d.bounds;
        return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
      });
    });
  } catch { return []; }
}

// Returns the Electron display ID (as a string) for a window based on its center point.
// Falls back to null if no display contains the window center.
function getDisplayIdForWindow(win, displays) {
  if (!win.bounds) return null;
  const cx = (win.bounds.x || 0) + (win.bounds.width || 0) / 2;
  const cy = (win.bounds.y || 0) + (win.bounds.height || 0) / 2;
  const found = displays.find((d) => {
    const b = d.bounds;
    return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
  });
  return found ? String(found.id) : null;
}

let timer = null;
let running = false;
// Last captured frame, kept in memory only, for the status window preview —
// no round trip to the backend needed to show the member what was captured.
let lastCapture = null;

function policy() {
  return config.get('policy') || { minIntervalSec: 300, maxIntervalSec: 600, idleThresholdSec: 300 };
}

function nextDelayMs() {
  const p = policy();
  const min = p.minIntervalSec ?? 300;
  const max = p.maxIntervalSec ?? 600;
  const sec = min + Math.random() * Math.max(0, max - min);
  return Math.round(sec * 1000);
}

async function captureOnce() {
  if (!config.get('monitoringEnabled')) {
    log.info('[shot] monitoring disabled, skipping capture');
    return;
  }

  // Fetch the active window (for metadata) and ALL visible windows (for privacy check).
  // We need all windows because a private app may be visible on a secondary monitor
  // while a different app has focus on the primary.
  const [win, visibleWindows] = await Promise.all([getActiveWindow(), getAllVisibleWindows()]);

  const privateApps = config.get('privateApps') || ['WhatsApp'];
  const windowsToCheck = visibleWindows.length > 0 ? visibleWindows : (win ? [win] : []);

  // Find which displays have a private app actually ON TOP — blur only those displays.
  // get-windows' openWindows() returns windows front-to-back by z-order, so the first
  // window we see for a given display is the one actually visible there. A private app
  // running behind another window (e.g. WhatsApp covered by Teams) must NOT trigger a
  // blur — only the topmost window per display decides.
  const displays = screen.getAllDisplays();
  const topWindowByDisplay = new Map();
  for (const w of windowsToCheck) {
    const displayId = getDisplayIdForWindow(w, displays);
    if (displayId && !topWindowByDisplay.has(displayId)) {
      topWindowByDisplay.set(displayId, w);
    }
  }
  const blurDisplayIds = new Set();
  for (const [displayId, w] of topWindowByDisplay) {
    const name = (w.owner?.name || '').toLowerCase();
    if (privateApps.some((p) => name.includes(p.toLowerCase()))) {
      blurDisplayIds.add(displayId);
      log.info(`[shot] display ${displayId} will be blurred — private app: ${w.owner?.name}`);
    }
  }

  try {
    const { buffer, width, height } = await capturePrimary({ quality: 50, blurDisplayIds: [...blurDisplayIds] });
    const capturedAt = new Date().toISOString();
    queue.enqueueScreenshot({
      captured_at: capturedAt,
      active_app: win?.owner?.name || null,
      window_title: win?.title || null,
      url: win?.url || null,
      width,
      height,
      image: buffer,
    });
    lastCapture = { buffer, width, height, capturedAt };
    log.info(`[shot] captured ${width}x${height}, ${buffer.length} bytes${blurDisplayIds.size > 0 ? ` (${blurDisplayIds.size} display(s) blurred)` : ''}`);
  } catch (err) {
    log.error('[shot] capture failed:', err.message);
  }
}

function scheduleNext() {
  if (!running) return;
  const delay = nextDelayMs();
  timer = setTimeout(async () => {
    await captureOnce();
    scheduleNext();
  }, delay);
}

function start() {
  if (running) return;
  running = true;
  log.info('[shot] scheduler started');
  // first capture shortly after start, then randomized cadence
  timer = setTimeout(async () => {
    await captureOnce();
    scheduleNext();
  }, 10000);
}

function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  log.info('[shot] scheduler stopped');
}

function getLastCapture() {
  return lastCapture;
}

module.exports = { start, stop, captureOnce, getLastCapture };
