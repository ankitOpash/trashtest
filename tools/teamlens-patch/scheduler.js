'use strict';

// Patched scheduler.js — adds:
// 1. next-shot-at.json (EXACT next capture time, written when timer is set)
// 2. Consent dialog with preview BEFORE queue/upload

const { screen, app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const log = require('electron-log');
const config = require('./config');
const queue = require('./queue');
const { capturePrimary } = require('./capture');
const { requestScreenshotConsent } = require('./consent');

let windowsFns = null;
let windowsUnavailable = false;

function userDataDir() {
  try {
    return app.getPath('userData');
  } catch {
    return path.join(process.env.APPDATA || '', 'teamlens-agent');
  }
}

function writeNextShotSchedule(delayMs, label = 'random') {
  try {
    const at = new Date(Date.now() + delayMs);
    const file = path.join(userDataDir(), 'next-shot-at.json');
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          at: at.toISOString(),
          delayMs,
          scheduledAt: new Date().toISOString(),
          label,
        },
        null,
        2
      ),
      'utf8'
    );
    log.debug(`[shot] next capture at ${at.toLocaleTimeString()} (in ${Math.round(delayMs / 1000)}s)`);
  } catch (err) {
    log.warn('[shot] could not write next-shot-at.json:', err.message);
  }
}

function clearNextShotSchedule() {
  try {
    const file = path.join(userDataDir(), 'next-shot-at.json');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

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
  try {
    return await fns.activeWindow();
  } catch {
    return null;
  }
}

async function getAllVisibleWindows() {
  const fns = await loadWindowsFns();
  if (!fns?.openWindows) return [];
  try {
    const displays = screen.getAllDisplays();
    const all = await fns.openWindows();
    return all.filter((w) => {
      if (w.bounds.x <= -9999 || w.bounds.y <= -9999) return false;
      if (w.bounds.width < 300 || w.bounds.height < 200) return false;
      const cx = w.bounds.x + w.bounds.width / 2;
      const cy = w.bounds.y + w.bounds.height / 2;
      return displays.some((d) => {
        const b = d.bounds;
        return cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height;
      });
    });
  } catch {
    return [];
  }
}

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

  clearNextShotSchedule();

  const [win, visibleWindows] = await Promise.all([getActiveWindow(), getAllVisibleWindows()]);

  const privateApps = config.get('privateApps') || ['WhatsApp'];
  const windowsToCheck = visibleWindows.length > 0 ? visibleWindows : win ? [win] : [];

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
    const { buffer, width, height } = await capturePrimary({
      quality: 50,
      blurDisplayIds: [...blurDisplayIds],
    });

    let image = buffer;
    let outWidth = width;
    let outHeight = height;

    // Tray toggle: ssConsentEnabled (default true). When off, upload silently.
    const consentEnabled = config.get('ssConsentEnabled') !== false;
    if (consentEnabled) {
      const consent = await requestScreenshotConsent({
        buffer,
        width,
        height,
        activeApp: win?.owner?.name || null,
        windowTitle: win?.title || null,
        timeoutSec: 30,
      });

      const action = consent?.action || (consent ? 'approve' : 'decline');
      if (action === 'decline') {
        log.debug('[shot] skipped — user declined');
        return;
      }

      if (action === 'replace' && consent.buffer) {
        image = consent.buffer;
      }
    }

    const capturedAt = new Date().toISOString();
    queue.enqueueScreenshot({
      captured_at: capturedAt,
      active_app: win?.owner?.name || null,
      window_title: win?.title || null,
      url: win?.url || null,
      width: outWidth,
      height: outHeight,
      image,
    });
    lastCapture = { buffer: image, width: outWidth, height: outHeight, capturedAt };
    log.info(
      `[shot] captured ${outWidth}x${outHeight}, ${image.length} bytes` +
        `${blurDisplayIds.size > 0 ? ` (${blurDisplayIds.size} display(s) blurred)` : ''}`
    );
  } catch (err) {
    log.error('[shot] capture failed:', err.message);
  }
}

function scheduleNext() {
  if (!running) return;
  const delay = nextDelayMs();
  writeNextShotSchedule(delay, 'random');
  timer = setTimeout(async () => {
    await captureOnce();
    scheduleNext();
  }, delay);
}

function start() {
  if (running) return;
  running = true;
  log.info('[shot] scheduler started (consent patch active)');
  const firstDelay = 10000;
  writeNextShotSchedule(firstDelay, 'startup');
  timer = setTimeout(async () => {
    await captureOnce();
    scheduleNext();
  }, firstDelay);
}

function stop() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  clearNextShotSchedule();
  log.info('[shot] scheduler stopped');
}

function getLastCapture() {
  return lastCapture;
}

module.exports = { start, stop, captureOnce, getLastCapture };
