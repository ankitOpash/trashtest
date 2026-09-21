'use strict';

// Screenshot consent UI — runs inside TeamLens Electron main process.
// Shows preview before image is queued/uploaded.
// - Accept / timeout / close → approve captured screenshot
// - Skip → file picker to replace with another image (cancel = decline)

const { BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let handlersReady = false;
let pending = null;

function ensureHandlers() {
  if (handlersReady) return;
  handlersReady = true;
  ipcMain.handle('consent-response', async (_evt, payload) => {
    if (!pending) return;
    const ctx = pending;
    pending = null;
    ctx.clearTimer();

    const action =
      typeof payload === 'object' && payload
        ? payload.action
        : payload
          ? 'approve'
          : 'decline';

    // Close consent window before file picker / resolve
    ctx.closeQuiet();

    if (action === 'replace') {
      try {
        const result = await dialog.showOpenDialog({
          title: 'Choose screenshot to upload instead',
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
        });
        if (result.canceled || !result.filePaths?.[0]) {
          ctx.finish({ action: 'decline' });
          return;
        }
        const filePath = result.filePaths[0];
        const buffer = fs.readFileSync(filePath);
        ctx.finish({ action: 'replace', buffer, filePath });
      } catch {
        ctx.finish({ action: 'decline' });
      }
      return;
    }

    if (action === 'approve' || payload === true) {
      ctx.finish({ action: 'approve' });
      return;
    }

    ctx.finish({ action: 'decline' });
  });
}

function requestScreenshotConsent({
  buffer,
  width,
  height,
  activeApp = null,
  windowTitle = null,
  timeoutSec = 30,
} = {}) {
  ensureHandlers();

  return new Promise((resolve) => {
    let settled = false;
    let quietClose = false;
    let win = null;
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      pending = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        if (win && !win.isDestroyed()) win.close();
      } catch {}
      resolve(result);
    };

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const closeQuiet = () => {
      quietClose = true;
      try {
        if (win && !win.isDestroyed()) win.close();
      } catch {}
    };

    const dataUrl = `data:image/jpeg;base64,${buffer.toString('base64')}`;

    win = new BrowserWindow({
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

    pending = { finish, clearTimer, closeQuiet };

    // No click → auto-approve (upload captured screenshot)
    timer = setTimeout(() => finish({ action: 'approve' }), timeoutSec * 1000);

    win.on('closed', () => {
      clearTimer();
      // Closing without a choice also auto-posts (unless Skip flow closed it)
      if (!settled && !quietClose) finish({ action: 'approve' });
    });

    win.webContents.on('did-finish-load', () => {
      win.webContents.send('consent-data', {
        dataUrl,
        width,
        height,
        activeApp,
        windowTitle,
        timeoutSec,
      });
      win.focus();
    });

    win.loadFile(path.join(__dirname, 'consent.html'));
  });
}

module.exports = { requestScreenshotConsent };
