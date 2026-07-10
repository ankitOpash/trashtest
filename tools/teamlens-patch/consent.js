'use strict';

// Screenshot consent UI — runs inside TeamLens Electron main process.
// Shows preview + "May I post?" before image is queued/uploaded.

const { BrowserWindow, ipcMain, app } = require('electron');
const path = require('node:path');

let handlersReady = false;

function ensureHandlers() {
  if (handlersReady) return;
  handlersReady = true;
  ipcMain.handle('consent-response', (_evt, approved) => {
    if (pending) {
      const { finish } = pending;
      pending = null;
      finish(Boolean(approved));
    }
  });
}

let pending = null;

function requestScreenshotConsent({
  buffer,
  width,
  height,
  activeApp = null,
  windowTitle = null,
  timeoutSec = 60,
} = {}) {
  ensureHandlers();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (approved) => {
      if (settled) return;
      settled = true;
      pending = null;
      try {
        if (win && !win.isDestroyed()) win.close();
      } catch {}
      resolve(approved);
    };

    const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

    const win = new BrowserWindow({
      width: 760,
      height: 680,
      center: true,
      alwaysOnTop: true,
      resizable: true,
      minimizable: false,
      maximizable: true,
      title: 'TeamLens — Screenshot consent',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'consent-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    pending = { finish };
    const timer = setTimeout(() => finish(false), timeoutSec * 1000);

    win.on('closed', () => {
      clearTimeout(timer);
      if (!settled) finish(false);
    });

    win.webContents.on('did-finish-load', () => {
      win.webContents.send('consent-data', {
        dataUrl,
        width,
        height,
        activeApp,
        windowTitle,
      });
      win.focus();
    });

    win.loadFile(path.join(__dirname, 'consent.html'));
  });
}

module.exports = { requestScreenshotConsent };
